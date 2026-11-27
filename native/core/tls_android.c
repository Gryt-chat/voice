#ifdef __ANDROID__
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

#include "tls.h"

/* In gryt_voice_jni.c. TlsPipe.kt does the TLS and pumps it through a socket pair; this is our end, or -1. */
int gv_android_tls_fd(const char *host, const char *port, int timeout_ms);

struct gv_tls {
  int fd;
};

gv_tls *gv_tls_open(const char *host, const char *port, int timeout_ms) {
  int fd = gv_android_tls_fd(host, port, timeout_ms);
  if (fd < 0) return NULL;
  int flags = fcntl(fd, F_GETFL, 0);
  gv_tls *t = flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0 ? NULL : malloc(sizeof *t);
  if (!t) {
    close(fd);
    return NULL;
  }
  t->fd = fd;
  return t;
}

int gv_tls_write(gv_tls *t, const uint8_t *b, size_t len) {
  ssize_t n = send(t->fd, b, len, MSG_NOSIGNAL);
  return n >= 0 ? (int)n : errno == EAGAIN || errno == EWOULDBLOCK ? 0 : -1;
}

int gv_tls_read(gv_tls *t, uint8_t *b, size_t cap, int timeout_ms) {
  struct pollfd p = {.fd = t->fd, .events = POLLIN};
  if (poll(&p, 1, timeout_ms) <= 0) return 0;
  ssize_t n = recv(t->fd, b, cap, 0);
  return n > 0 ? (int)n : n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : -1;
}

void gv_tls_close(gv_tls *t) {
  if (!t) return;
  close(t->fd);
  free(t);
}
#endif
