#ifdef _WIN32
#define SECURITY_WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <schannel.h>
#include <security.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "tls.h"

/* In ws.c: a connected non-blocking socket, or INVALID_SOCKET. */
SOCKET gv_ws_dial(const char *host, const char *port, int ms);

#define REC_CAP (16384 + 512)

struct gv_tls {
  SOCKET fd;
  CredHandle cred;
  CtxtHandle ctx;
  int have_cred, have_ctx;
  atomic_int dead;
  SecPkgContext_StreamSizes sizes;
  /* Encrypt and decrypt share the context and run on two threads. */
  CRITICAL_SECTION lock;
  size_t out_len, in_len, plain_len;
  uint8_t out[REC_CAP], in[REC_CAP], plain[REC_CAP];
};

static int wait_fd(SOCKET fd, int for_write, int ms) {
  fd_set s;
  FD_ZERO(&s);
  FD_SET(fd, &s);
  struct timeval tv = {ms / 1000, (ms % 1000) * 1000};
  return select(0, for_write ? NULL : &s, for_write ? &s : NULL, NULL, &tv);
}

static int send_all(SOCKET fd, const uint8_t *b, size_t len, int ms) {
  while (len) {
    int n = send(fd, (const char *)b, (int)len, 0);
    if (n > 0) b += n, len -= (size_t)n;
    else if (n < 0 && WSAGetLastError() == WSAEWOULDBLOCK && wait_fd(fd, 1, ms) > 0) continue;
    else return -1;
  }
  return 0;
}

/* More raw bytes into t->in: how many, 0 when none came within ms, -1 once closed. */
static int fill(gv_tls *t, int ms) {
  if (t->in_len >= sizeof t->in) return -1;
  if (wait_fd(t->fd, 0, ms) <= 0) return 0;
  int n = recv(t->fd, (char *)t->in + t->in_len, (int)(sizeof t->in - t->in_len), 0);
  if (n > 0) return t->in_len += (size_t)n, n;
  return n < 0 && WSAGetLastError() == WSAEWOULDBLOCK ? 0 : -1;
}

/* Whatever SECBUFFER_EXTRA says came after the record or token just used goes to the front of t->in. */
static void keep_extra(gv_tls *t, SecBuffer *b, int n) {
  size_t extra = 0;
  for (int i = 0; i < n; i++)
    if (b[i].BufferType == SECBUFFER_EXTRA) extra = b[i].cbBuffer;
  memmove(t->in, t->in + t->in_len - extra, extra);
  t->in_len = extra;
}

/* The certificate is checked by Schannel itself, against the Windows trust store, for host. */
static int handshake(gv_tls *t, const char *host, int ms) {
  DWORD want = ISC_REQ_SEQUENCE_DETECT | ISC_REQ_REPLAY_DETECT | ISC_REQ_CONFIDENTIALITY | ISC_REQ_ALLOCATE_MEMORY |
               ISC_REQ_STREAM, got;
  for (int first = 1;;) {
    SecBuffer in[2] = {{(unsigned long)t->in_len, SECBUFFER_TOKEN, t->in}, {0, SECBUFFER_EMPTY, NULL}};
    SecBuffer out[1] = {{0, SECBUFFER_TOKEN, NULL}};
    SecBufferDesc in_desc = {SECBUFFER_VERSION, 2, in}, out_desc = {SECBUFFER_VERSION, 1, out};
    SECURITY_STATUS s = InitializeSecurityContextA(&t->cred, first ? NULL : &t->ctx, (SEC_CHAR *)host, want, 0, 0,
                                                   first ? NULL : &in_desc, 0, &t->ctx, &out_desc, &got, NULL);
    if (first) t->have_ctx = s == SEC_I_CONTINUE_NEEDED || s == SEC_E_OK;
    first = 0;
    if (out[0].pvBuffer) {
      int sent = out[0].cbBuffer ? send_all(t->fd, out[0].pvBuffer, out[0].cbBuffer, ms) : 0;
      FreeContextBuffer(out[0].pvBuffer);
      if (sent != 0) return -1;
    }
    if (s == SEC_E_INCOMPLETE_MESSAGE) {
      if (fill(t, ms) <= 0) return -1;
      continue;
    }
    if (s != SEC_E_OK && s != SEC_I_CONTINUE_NEEDED) return -1;
    if (in[1].BufferType == SECBUFFER_EXTRA) keep_extra(t, in, 2);
    else t->in_len = 0;
    if (s == SEC_E_OK) return QueryContextAttributesA(&t->ctx, SECPKG_ATTR_STREAM_SIZES, &t->sizes) == SEC_E_OK ? 0 : -1;
    if (fill(t, ms) <= 0) return -1;
  }
}

void gv_tls_close(gv_tls *t) {
  if (!t) return;
  if (t->have_ctx) DeleteSecurityContext(&t->ctx);
  if (t->have_cred) FreeCredentialsHandle(&t->cred);
  closesocket(t->fd);
  DeleteCriticalSection(&t->lock);
  free(t);
}

gv_tls *gv_tls_open(const char *host, const char *port, int timeout_ms) {
  SOCKET fd = gv_ws_dial(host, port, timeout_ms);
  if (fd == INVALID_SOCKET) return NULL;
  gv_tls *t = calloc(1, sizeof *t);
  if (!t) {
    closesocket(fd);
    return NULL;
  }
  t->fd = fd;
  InitializeCriticalSection(&t->lock);
  SCHANNEL_CRED sc = {.dwVersion = SCHANNEL_CRED_VERSION, .dwFlags = SCH_CRED_NO_DEFAULT_CREDS | SCH_CRED_AUTO_CRED_VALIDATION};
  t->have_cred = AcquireCredentialsHandleA(NULL, UNISP_NAME_A, SECPKG_CRED_OUTBOUND, NULL, &sc, NULL, NULL, &t->cred, NULL) == SEC_E_OK;
  if (!t->have_cred || handshake(t, host, timeout_ms) != 0) {
    gv_tls_close(t);
    return NULL;
  }
  return t;
}

/* Under t->lock. 1 once the last record is all sent, 0 while some waits, -1 once closed. */
static int flush(gv_tls *t) {
  while (t->out_len) {
    int n = send(t->fd, (const char *)t->out, (int)t->out_len, 0);
    if (n <= 0) return n < 0 && WSAGetLastError() == WSAEWOULDBLOCK ? 0 : (atomic_store(&t->dead, 1), -1);
    memmove(t->out, t->out + n, t->out_len - (size_t)n);
    t->out_len -= (size_t)n;
  }
  return 1;
}

int gv_tls_write(gv_tls *t, const uint8_t *b, size_t len) {
  EnterCriticalSection(&t->lock);
  int ret = atomic_load(&t->dead) ? -1 : flush(t);
  if (ret == 1) {
    size_t take = len < t->sizes.cbMaximumMessage ? len : t->sizes.cbMaximumMessage;
    uint8_t *head = t->out, *data = head + t->sizes.cbHeader, *trail = data + take;
    memcpy(data, b, take);
    SecBuffer bufs[4] = {{t->sizes.cbHeader, SECBUFFER_STREAM_HEADER, head},
                         {(unsigned long)take, SECBUFFER_DATA, data},
                         {t->sizes.cbTrailer, SECBUFFER_STREAM_TRAILER, trail},
                         {0, SECBUFFER_EMPTY, NULL}};
    SecBufferDesc desc = {SECBUFFER_VERSION, 4, bufs};
    if (EncryptMessage(&t->ctx, 0, &desc, 0) != SEC_E_OK) {
      atomic_store(&t->dead, 1);
      ret = -1;
    } else {
      t->out_len = bufs[0].cbBuffer + bufs[1].cbBuffer + bufs[2].cbBuffer;
      ret = flush(t) < 0 ? -1 : (int)take;
    }
  }
  LeaveCriticalSection(&t->lock);
  return ret;
}

int gv_tls_read(gv_tls *t, uint8_t *b, size_t cap, int timeout_ms) {
  for (int waited = 0;;) {
    if (t->plain_len) {
      size_t n = t->plain_len < cap ? t->plain_len : cap;
      memcpy(b, t->plain, n);
      memmove(t->plain, t->plain + n, t->plain_len - n);
      t->plain_len -= n;
      return (int)n;
    }
    EnterCriticalSection(&t->lock);
    if (!atomic_load(&t->dead)) flush(t);
    SECURITY_STATUS s = SEC_E_INCOMPLETE_MESSAGE;
    SecBuffer bufs[4] = {{(unsigned long)t->in_len, SECBUFFER_DATA, t->in}, {0, SECBUFFER_EMPTY, NULL}, {0, SECBUFFER_EMPTY, NULL}, {0, SECBUFFER_EMPTY, NULL}};
    SecBufferDesc desc = {SECBUFFER_VERSION, 4, bufs};
    if (t->in_len && !atomic_load(&t->dead)) s = DecryptMessage(&t->ctx, &desc, 0, NULL);
    LeaveCriticalSection(&t->lock);
    if (s == SEC_E_OK) {
      for (int i = 0; i < 4; i++)
        if (bufs[i].BufferType == SECBUFFER_DATA) memcpy(t->plain, bufs[i].pvBuffer, t->plain_len = bufs[i].cbBuffer);
      keep_extra(t, bufs, 4);
      continue;
    }
    /* A close_notify, a renegotiation or anything broken ends it, and the engine goes back to UDP. */
    if (s != SEC_E_INCOMPLETE_MESSAGE || atomic_load(&t->dead)) return atomic_store(&t->dead, 1), -1;
    if (waited) return 0;
    waited = 1;
    int got = fill(t, timeout_ms);
    if (got < 0) return atomic_store(&t->dead, 1), -1;
    if (got == 0) return 0;
  }
}
#endif
