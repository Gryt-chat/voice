/* The SFU's /audio-ws for when UDP is blocked (GRYT-2431): an HTTP upgrade, then each packet as one binary
   message, unsealed, the way the web engine sends them. ws:// only; wss:// has no TLS here yet. */
#ifndef GRYT_VOICE_WS_H
#define GRYT_VOICE_WS_H

#include <stddef.h>
#include <stdint.h>

typedef struct gv_ws gv_ws;

/* NULL if the URL isn't ws:// or the upgrade fails within timeout_ms. */
gv_ws *gv_ws_connect(const char *url, int timeout_ms);
/* Never blocks: past 16 KB still unsent the packet is dropped, as the web engine drops it. -1 once closed. */
int gv_ws_send(gv_ws *w, const uint8_t *b, size_t len);
/* One binary message into out: its length, 0 when none came within timeout_ms, -1 once closed. */
int gv_ws_recv(gv_ws *w, uint8_t *out, size_t cap, int timeout_ms);
void gv_ws_close(gv_ws *w);

#endif
