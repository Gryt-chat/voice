#include "tls.h"

#if !defined(__APPLE__) && !defined(__ANDROID__) && !defined(_WIN32)
gv_tls *gv_tls_open(const char *host, const char *port, int timeout_ms) {
  (void)host, (void)port, (void)timeout_ms;
  return NULL;
}
int gv_tls_write(gv_tls *t, const uint8_t *b, size_t len) {
  (void)t, (void)b, (void)len;
  return -1;
}
int gv_tls_read(gv_tls *t, uint8_t *b, size_t cap, int timeout_ms) {
  (void)t, (void)b, (void)cap, (void)timeout_ms;
  return -1;
}
void gv_tls_close(gv_tls *t) { (void)t; }
#endif
