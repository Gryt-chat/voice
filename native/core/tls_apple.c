#ifdef __APPLE__
#include <Network/Network.h>
#include <Security/Security.h>
#include <dispatch/dispatch.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "tls.h"

#define OUT_CAP (16 * 1024)
#define IN_CAP 4096

/* Everything but the atomics is touched only on q, where Network.framework calls back. */
struct gv_tls {
  nw_connection_t c;
  dispatch_queue_t q;
  dispatch_semaphore_t ready, got, gone;
  CFArrayRef anchors;
  atomic_int up, dead;
  atomic_size_t queued;
  int receiving;
  size_t in_len;
  uint8_t in[IN_CAP];
};

/* GV_TLS_CA names one DER certificate trusted on top of the system's, for a test SFU. The host is still checked. */
static CFArrayRef test_anchors(void) {
  const char *path = getenv("GV_TLS_CA");
  FILE *f = path ? fopen(path, "rb") : NULL;
  if (!f) return NULL;
  uint8_t der[8192];
  size_t n = fread(der, 1, sizeof der, f);
  fclose(f);
  CFDataRef data = CFDataCreate(NULL, der, (CFIndex)n);
  SecCertificateRef cert = data ? SecCertificateCreateWithData(NULL, data) : NULL;
  if (data) CFRelease(data);
  if (!cert) return NULL;
  CFArrayRef a = CFArrayCreate(NULL, (const void **)&cert, 1, &kCFTypeArrayCallBacks);
  CFRelease(cert);
  return a;
}

static void receive(gv_tls *t) {
  t->receiving = 1;
  nw_connection_receive(t->c, 1, IN_CAP, ^(dispatch_data_t content, nw_content_context_t ctx, bool complete, nw_error_t err) {
    (void)ctx;
    t->receiving = 0;
    if (content)
      dispatch_data_apply(content, ^bool(dispatch_data_t region, size_t offset, const void *buf, size_t size) {
        (void)region, (void)offset;
        memcpy(t->in + t->in_len, buf, size);
        t->in_len += size;
        return true;
      });
    if (err || complete) atomic_store(&t->dead, 1);
    dispatch_semaphore_signal(t->got);
  });
}

void gv_tls_close(gv_tls *t) {
  if (!t) return;
  nw_connection_cancel(t->c);
  /* Callbacks still hold t until cancelled is reported; past a second, leaking it beats freeing it under them. */
  if (dispatch_semaphore_wait(t->gone, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) != 0) return;
  dispatch_sync(t->q, ^{});
  nw_release(t->c);
  dispatch_release(t->q);
  dispatch_release(t->ready);
  dispatch_release(t->got);
  dispatch_release(t->gone);
  if (t->anchors) CFRelease(t->anchors);
  free(t);
}

gv_tls *gv_tls_open(const char *host, const char *port, int timeout_ms) {
  gv_tls *t = calloc(1, sizeof *t);
  if (!t) return NULL;
  atomic_init(&t->up, 0);
  atomic_init(&t->dead, 0);
  atomic_init(&t->queued, 0);
  t->q = dispatch_queue_create("chat.gryt.voice.tls", DISPATCH_QUEUE_SERIAL);
  t->ready = dispatch_semaphore_create(0);
  t->got = dispatch_semaphore_create(0);
  t->gone = dispatch_semaphore_create(0);
  t->anchors = test_anchors();
  nw_parameters_t params = nw_parameters_create_secure_tcp(
      ^(nw_protocol_options_t tls) {
        if (!t->anchors) return;
        sec_protocol_options_t sec = nw_tls_copy_sec_protocol_options(tls);
        sec_protocol_options_set_verify_block(
            sec,
            ^(sec_protocol_metadata_t meta, sec_trust_t trust, sec_protocol_verify_complete_t done) {
              (void)meta;
              SecTrustRef ref = sec_trust_copy_ref(trust);
              SecTrustSetAnchorCertificates(ref, t->anchors);
              SecTrustSetAnchorCertificatesOnly(ref, false);
              done(SecTrustEvaluateWithError(ref, NULL));
              CFRelease(ref);
            },
            t->q);
        sec_release(sec);
      },
      ^(nw_protocol_options_t tcp) {
        /* Nagle would hold a 2.5 ms frame back for the one before it to be acknowledged. */
        nw_tcp_options_set_no_delay(tcp, true);
      });
  nw_endpoint_t where = nw_endpoint_create_host(host, port);
  t->c = nw_connection_create(where, params);
  nw_release(where);
  nw_release(params);
  nw_connection_set_queue(t->c, t->q);
  nw_connection_set_state_changed_handler(t->c, ^(nw_connection_state_t state, nw_error_t err) {
    (void)err;
    if (state == nw_connection_state_ready) atomic_store(&t->up, 1);
    if (state == nw_connection_state_failed || state == nw_connection_state_cancelled) atomic_store(&t->dead, 1);
    if (state == nw_connection_state_ready || state == nw_connection_state_failed) dispatch_semaphore_signal(t->ready);
    if (state == nw_connection_state_failed || state == nw_connection_state_cancelled) dispatch_semaphore_signal(t->got);
    if (state == nw_connection_state_cancelled) dispatch_semaphore_signal(t->gone);
  });
  nw_connection_start(t->c);
  dispatch_semaphore_wait(t->ready, dispatch_time(DISPATCH_TIME_NOW, (int64_t)timeout_ms * NSEC_PER_MSEC));
  if (!atomic_load(&t->up) || atomic_load(&t->dead)) {
    gv_tls_close(t);
    return NULL;
  }
  return t;
}

int gv_tls_write(gv_tls *t, const uint8_t *b, size_t len) {
  if (atomic_load(&t->dead)) return -1;
  if (atomic_load(&t->queued) + len > OUT_CAP) return 0;
  atomic_fetch_add(&t->queued, len);
  dispatch_data_t data = dispatch_data_create(b, len, NULL, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
  nw_connection_send(t->c, data, NW_CONNECTION_DEFAULT_STREAM_CONTEXT, false, ^(nw_error_t err) {
    atomic_fetch_sub(&t->queued, len);
    if (err) atomic_store(&t->dead, 1);
  });
  dispatch_release(data);
  return (int)len;
}

int gv_tls_read(gv_tls *t, uint8_t *b, size_t cap, int timeout_ms) {
  for (int waited = 0;; waited = 1) {
    __block size_t n = 0;
    dispatch_sync(t->q, ^{
      n = t->in_len < cap ? t->in_len : cap;
      memcpy(b, t->in, n);
      memmove(t->in, t->in + n, t->in_len - n);
      t->in_len -= n;
      if (!t->in_len && !t->receiving && !atomic_load(&t->dead)) receive(t);
    });
    if (n) return (int)n;
    if (atomic_load(&t->dead)) return -1;
    if (waited || dispatch_semaphore_wait(t->got, dispatch_time(DISPATCH_TIME_NOW, (int64_t)timeout_ms * NSEC_PER_MSEC)) != 0) return 0;
  }
}
#endif
