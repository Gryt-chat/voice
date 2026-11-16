/* The engine on a real microphone and speakers, through the vendored miniaudio: one duplex device whose
   callback captures into the engine and renders out of it. GRYT-1822. */
#ifndef GRYT_VOICE_DEVICE_H
#define GRYT_VOICE_DEVICE_H

#include "engine.h"

typedef struct gv_device gv_device;

/* Called on the audio thread after capture and before render, for tools that tap or inject audio. */
typedef void (*gv_tap_fn)(void *user, float *mic, float *out, unsigned frames, int mic_channels, int stage);

/* capture, playback: a substring of each device's name, or NULL for the system default. period: frames per callback
   (32 is ~0.7 ms). */
gv_device *gv_device_start(gv_engine *engine, const char *capture, const char *playback, unsigned period, gv_tap_fn tap,
                           void *user);
/* Every device the system offers, by name. Returns how many, or -1 when they can't be listed. */
int gv_device_list(void (*each)(void *user, int capture, const char *name), void *user);
void gv_device_stop(gv_device *d);
/* The channels the microphone actually gave, 1 or 2. */
int gv_device_mic_channels(const gv_device *d);

#endif
