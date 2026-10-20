/* The native engine as one handle, for the iOS and Android bridges (GRYT-1822): start it with the SFU's
   offer, change it while it runs, stop it. Engine, network and devices stay out of sight. */
#ifndef GRYT_VOICE_VOICE_H
#define GRYT_VOICE_VOICE_H

#include <stdint.h>

#include "effects.h"

typedef struct gv_voice gv_voice;

/* The room_joined offer's udp part: addresses, session, the 32-byte key. NULL if any piece fails. */
gv_voice *gv_voice_start(const char *const *addrs, int n_addrs, uint32_t session, const uint8_t key[32],
                         const gv_effect_settings *effects, unsigned period);
void gv_voice_stop(gv_voice *v);
void gv_voice_set_sending(gv_voice *v, int on);
void gv_voice_set_output_gain(gv_voice *v, float gain);
void gv_voice_set_effects(gv_voice *v, const gv_effect_settings *effects);
/* Which offered address answered, or -1 while none has. */
int gv_voice_route(const gv_voice *v);

#endif
