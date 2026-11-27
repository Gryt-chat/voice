/* The byte stream under wss:// in ws.c: the OS's own TLS, checked against its trust store. One file per OS;
   tls.c is the stand-in where there's none yet, and its open always fails. */
#ifndef GRYT_VOICE_TLS_H
#define GRYT_VOICE_TLS_H

#include <stddef.h>
#include <stdint.h>

typedef struct gv_tls gv_tls;

/* NULL if it can't connect, or the certificate doesn't check out for host, within timeout_ms. */
gv_tls *gv_tls_open(const char *host, const char *port, int timeout_ms);
/* Never blocks: how many bytes of b it took, 0 when it can take none now, -1 once closed. */
int gv_tls_write(gv_tls *t, const uint8_t *b, size_t len);
/* Up to cap bytes: how many, 0 when none came within timeout_ms, -1 once closed. */
int gv_tls_read(gv_tls *t, uint8_t *b, size_t cap, int timeout_ms);
void gv_tls_close(gv_tls *t);

#endif
