/* The native engine's way to the SFU (GRYT-1822): one UDP socket, packets sealed as seal.c does it, with the
   session and key from the room_joined offer. Sends from the audio thread; a thread of its own receives. */
#ifndef GRYT_VOICE_NET_H
#define GRYT_VOICE_NET_H

#include <stdint.h>

#include "engine.h"

typedef struct gv_net gv_net;

/* addrs are "host:port" (or "[v6]:port"), all tried until one answers. Becomes the engine's send callback. */
gv_net *gv_net_open(gv_engine *engine, const char *const *addrs, int n_addrs, uint32_t session, const uint8_t key[32]);
void gv_net_close(gv_net *n);
/* Which of the offered addresses answered first, or -1 while none has. */
int gv_net_chosen(const gv_net *n);

#endif
