#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE
#endif
#include "ws.h"

#include "tls.h"

#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
typedef SOCKET gv_socket;
#define GV_BAD_SOCKET INVALID_SOCKET
#define gv_close_socket closesocket
#define WOULD_BLOCK() (WSAGetLastError() == WSAEWOULDBLOCK)
#define IN_PROGRESS() (WSAGetLastError() == WSAEWOULDBLOCK)
#define LOCK_T CRITICAL_SECTION
#define LOCK_INIT(l) InitializeCriticalSection(l)
#define LOCK(l) EnterCriticalSection(l)
#define UNLOCK(l) LeaveCriticalSection(l)
#define LOCK_FREE(l) DeleteCriticalSection(l)
#define SEND_FLAGS 0
#else
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
typedef int gv_socket;
#define GV_BAD_SOCKET (-1)
#define gv_close_socket close
#define WOULD_BLOCK() (errno == EAGAIN || errno == EWOULDBLOCK)
#define IN_PROGRESS() (errno == EINPROGRESS)
#define LOCK_T pthread_mutex_t
#define LOCK_INIT(l) pthread_mutex_init(l, NULL)
#define LOCK(l) pthread_mutex_lock(l)
#define UNLOCK(l) pthread_mutex_unlock(l)
#define LOCK_FREE(l) pthread_mutex_destroy(l)
#ifdef MSG_NOSIGNAL
#define SEND_FLAGS MSG_NOSIGNAL
#else
#define SEND_FLAGS 0
#endif
#endif

#define OUT_CAP (16 * 1024)
#define IN_CAP 4096

struct gv_ws {
  gv_socket fd;
  gv_tls *tls;
  atomic_int dead;
  LOCK_T lock;
  uint32_t mask;
  size_t out_len, in_len;
  uint8_t out[OUT_CAP], in[IN_CAP];
};

static int wait_fd(gv_socket fd, int for_write, int ms) {
  fd_set s;
  FD_ZERO(&s);
  FD_SET(fd, &s);
  struct timeval tv = {ms / 1000, (ms % 1000) * 1000};
  return select((int)fd + 1, for_write ? NULL : &s, for_write ? &s : NULL, NULL, &tv);
}

static int set_nonblocking(gv_socket fd) {
#ifdef _WIN32
  u_long on = 1;
  return ioctlsocket(fd, FIONBIO, &on);
#else
  int flags = fcntl(fd, F_GETFL, 0);
  return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
#endif
}

gv_socket gv_ws_dial(const char *host, const char *port, int ms) {
  struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM}, *res, *a;
  if (getaddrinfo(host, port, &hints, &res) != 0) return GV_BAD_SOCKET;
  gv_socket fd = GV_BAD_SOCKET;
  for (a = res; a && fd == GV_BAD_SOCKET; a = a->ai_next) {
    fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
    if (fd == GV_BAD_SOCKET) continue;
    int err = 0;
    socklen_t len = sizeof err;
    if (set_nonblocking(fd) != 0 ||
        (connect(fd, a->ai_addr, (int)a->ai_addrlen) != 0 &&
         (!IN_PROGRESS() || wait_fd(fd, 1, ms) <= 0 || getsockopt(fd, SOL_SOCKET, SO_ERROR, (char *)&err, &len) != 0 || err))) {
      gv_close_socket(fd);
      fd = GV_BAD_SOCKET;
    }
  }
  freeaddrinfo(res);
  if (fd == GV_BAD_SOCKET) return fd;
  int on = 1;
  /* Nagle would hold a 2.5 ms frame back for the one before it to be acknowledged. */
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, (const char *)&on, sizeof on);
#ifdef SO_NOSIGPIPE
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
#endif
  return fd;
}

/* How many bytes went, 0 when none can go now, -1 once closed. */
static int write_some(gv_ws *w, const uint8_t *b, size_t len) {
  if (w->tls) return gv_tls_write(w->tls, b, len);
  int n = (int)send(w->fd, (const char *)b, (int)len, SEND_FLAGS);
  return n >= 0 ? n : WOULD_BLOCK() ? 0 : -1;
}

static void flush_locked(gv_ws *w) {
  while (w->out_len) {
    int n = write_some(w, w->out, w->out_len);
    if (n > 0) {
      memmove(w->out, w->out + n, w->out_len - (size_t)n);
      w->out_len -= (size_t)n;
    } else {
      if (n < 0) atomic_store(&w->dead, 1);
      return;
    }
  }
}

/* Clients mask every frame; the mask only has to vary, not be secret. */
static int send_frame(gv_ws *w, uint8_t opcode, const uint8_t *b, size_t len) {
  if (len > 0xffff) return 0;
  LOCK(&w->lock);
  if (atomic_load(&w->dead)) {
    UNLOCK(&w->lock);
    return -1;
  }
  size_t head = len < 126 ? 6 : 8;
  if (w->out_len + head + len <= OUT_CAP) {
    uint8_t *f = w->out + w->out_len;
    f[0] = (uint8_t)(0x80 | opcode);
    if (len < 126) {
      f[1] = (uint8_t)(0x80 | len);
    } else {
      f[1] = 0x80 | 126, f[2] = (uint8_t)(len >> 8), f[3] = (uint8_t)len;
    }
    w->mask ^= w->mask << 13, w->mask ^= w->mask >> 17, w->mask ^= w->mask << 5;
    uint8_t *mask = f + head - 4;
    memcpy(mask, &w->mask, 4);
    for (size_t i = 0; i < len; i++) f[head + i] = b[i] ^ mask[i & 3];
    w->out_len += head + len;
    flush_locked(w);
  }
  UNLOCK(&w->lock);
  return 0;
}

int gv_ws_send(gv_ws *w, const uint8_t *b, size_t len) { return send_frame(w, 2, b, len); }

static int send_all(gv_socket fd, const char *s, size_t len, int ms) {
  while (len) {
    int n = (int)send(fd, s, (int)len, SEND_FLAGS);
    if (n > 0) s += n, len -= (size_t)n;
    else if (n < 0 && WOULD_BLOCK() && wait_fd(fd, 1, ms) > 0) continue;
    else return -1;
  }
  return 0;
}

/* Into w->in, up to cap: how many, 0 when nothing came within ms, -1 once closed. */
static int read_some(gv_ws *w, size_t cap, int ms) {
  if (w->tls) return gv_tls_read(w->tls, w->in + w->in_len, cap - w->in_len, ms);
  if (wait_fd(w->fd, 0, ms) <= 0) return 0;
  int got = (int)recv(w->fd, (char *)w->in + w->in_len, (int)(cap - w->in_len), 0);
  return got > 0 ? got : got == 0 || !WOULD_BLOCK() ? -1 : 0;
}

static int handshake(gv_ws *w, const char *host, const char *port, const char *path, int ms) {
  char req[1024];
  /* The key only proves the server speaks WebSocket; nothing here checks its answer, so one fixed key does. */
  int n = snprintf(req, sizeof req,
                   "GET %s HTTP/1.1\r\nHost: %s:%s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
                   path, host, port);
  if (n <= 0 || (size_t)n >= sizeof req ||
      (w->tls ? gv_tls_write(w->tls, (const uint8_t *)req, (size_t)n) != n : send_all(w->fd, req, (size_t)n, ms) != 0))
    return -1;
  char *end = NULL;
  while (!end) {
    if (w->in_len >= IN_CAP - 1) break;
    int got = read_some(w, IN_CAP - 1, ms);
    if (got <= 0) break;
    w->in_len += (size_t)got;
    w->in[w->in_len] = 0;
    end = strstr((char *)w->in, "\r\n\r\n");
  }
  if (!end || strncmp((char *)w->in, "HTTP/1.1 101", 12) != 0) return -1;
  size_t used = (size_t)(end + 4 - (char *)w->in);
  memmove(w->in, w->in + used, w->in_len - used);
  w->in_len -= used;
  return 0;
}

gv_ws *gv_ws_connect(const char *url, int timeout_ms) {
  int tls = strncmp(url, "wss://", 6) == 0;
  if (!tls && strncmp(url, "ws://", 5) != 0) return NULL;
  const char *h = url + (tls ? 6 : 5), *path = h + strcspn(h, "/?");
  char host[256], port[8], where[1024];
  snprintf(port, sizeof port, "%s", tls ? "443" : "80");
  size_t hl = (size_t)(path - h);
  if (hl == 0 || hl >= sizeof host) return NULL;
  memcpy(host, h, hl);
  host[hl] = 0;
  char *colon = strrchr(host, ':');
  if (colon && !strchr(colon, ']')) {
    *colon = 0;
    snprintf(port, sizeof port, "%s", colon + 1);
  }
  char *name = host;
  if (name[0] == '[' && name[strlen(name) - 1] == ']') name[strlen(name) - 1] = 0, name++;
  snprintf(where, sizeof where, "%s%s", *path == '/' ? "" : "/", path);
  gv_ws *w = calloc(1, sizeof *w);
  if (!w) return NULL;
  w->fd = GV_BAD_SOCKET;
  if (tls) w->tls = gv_tls_open(name, port, timeout_ms);
  else w->fd = gv_ws_dial(name, port, timeout_ms);
  if ((tls ? !w->tls : w->fd == GV_BAD_SOCKET) || handshake(w, host, port, where, timeout_ms) != 0) {
    if (w->tls) gv_tls_close(w->tls);
    if (w->fd != GV_BAD_SOCKET) gv_close_socket(w->fd);
    free(w);
    return NULL;
  }
  w->mask = (uint32_t)time(NULL) ^ (uint32_t)(uintptr_t)w ^ 0x9e3779b9u;
  atomic_init(&w->dead, 0);
  LOCK_INIT(&w->lock);
  return w;
}

int gv_ws_recv(gv_ws *w, uint8_t *out, size_t cap, int timeout_ms) {
  for (int waited = 0;;) {
    LOCK(&w->lock);
    flush_locked(w);
    UNLOCK(&w->lock);
    if (w->in_len >= 2) {
      uint8_t *f = w->in;
      size_t len = f[1] & 0x7f, head = 2;
      if (len == 126) len = w->in_len >= 4 ? (size_t)(f[2] << 8 | f[3]) : SIZE_MAX, head = 4;
      int masked = f[1] & 0x80;
      if (masked) head += 4;
      /* Nothing the SFU sends is near this, so one that is can only be a broken stream. */
      if (len == 127 || (len != SIZE_MAX && head + len > IN_CAP)) atomic_store(&w->dead, 1);
      else if (len != SIZE_MAX && w->in_len >= head + len) {
        uint8_t op = f[0] & 0x0f, *p = f + head;
        if (masked)
          for (size_t i = 0; i < len; i++) p[i] ^= f[head - 4 + (i & 3)];
        int ret = 0;
        if (op == 2 && len <= cap) memcpy(out, p, len), ret = (int)len;
        else if (op == 8) atomic_store(&w->dead, 1);
        else if (op == 9) send_frame(w, 10, p, len);
        memmove(w->in, w->in + head + len, w->in_len - head - len);
        w->in_len -= head + len;
        if (ret) return ret;
        continue;
      }
    }
    if (atomic_load(&w->dead)) return -1;
    if (waited) return 0;
    waited = 1;
    int got = read_some(w, IN_CAP, timeout_ms);
    if (got > 0) w->in_len += (size_t)got;
    else if (got < 0) atomic_store(&w->dead, 1);
  }
}

void gv_ws_close(gv_ws *w) {
  if (!w) return;
  if (w->tls) gv_tls_close(w->tls);
  else gv_close_socket(w->fd);
  LOCK_FREE(&w->lock);
  free(w);
}
