#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#include "../vendor/miniaudio/miniaudio.h"

#include "device.h"

#include <stdlib.h>
#include <string.h>

struct gv_device {
  ma_context context;
  ma_device device;
  gv_engine *engine;
  gv_tap_fn tap;
  void *user;
  float mic[4096 * 2];
};

static void callback(ma_device *dev, void *output, const void *input, ma_uint32 frames) {
  gv_device *d = dev->pUserData;
  int ch = (int)dev->capture.channels;
  if (frames > 4096) frames = 4096;
  memcpy(d->mic, input, frames * ch * sizeof(float));
  if (d->tap) d->tap(d->user, d->mic, output, frames, ch, 0);
  gv_engine_capture(d->engine, d->mic, frames, ch);
  gv_engine_render(d->engine, output, frames);
  if (d->tap) d->tap(d->user, d->mic, output, frames, ch, 1);
}

static ma_device_id *find(ma_device_info *list, ma_uint32 n, const char *name) {
  for (ma_uint32 i = 0; name && i < n; i++) if (strstr(list[i].name, name)) return &list[i].id;
  return NULL;
}

gv_device *gv_device_start(gv_engine *engine, const char *name, unsigned period, gv_tap_fn tap, void *user) {
  gv_device *d = calloc(1, sizeof *d);
  if (!d || ma_context_init(NULL, 0, NULL, &d->context) != MA_SUCCESS) return free(d), NULL;
  ma_device_info *playback, *capture;
  ma_uint32 np, nc;
  ma_context_get_devices(&d->context, &playback, &np, &capture, &nc);
  ma_device_config c = ma_device_config_init(ma_device_type_duplex);
  c.playback.pDeviceID = find(playback, np, name);
  c.capture.pDeviceID = find(capture, nc, name);
  c.playback.format = c.capture.format = ma_format_f32;
  c.playback.channels = 2;
  /* Up to two: a stereo mic stays stereo, a mono one reports one channel. */
  c.capture.channels = 0;
  c.sampleRate = 48000;
  c.periodSizeInFrames = period;
  c.periods = 2;
  c.performanceProfile = ma_performance_profile_low_latency;
  c.dataCallback = callback;
  c.pUserData = d;
  d->engine = engine;
  d->tap = tap;
  d->user = user;
  if (ma_device_init(&d->context, &c, &d->device) != MA_SUCCESS) return ma_context_uninit(&d->context), free(d), NULL;
  if (d->device.capture.channels > 2) {
    /* A multichannel interface: take its first two inputs. */
    ma_device_uninit(&d->device);
    c.capture.channels = 2;
    if (ma_device_init(&d->context, &c, &d->device) != MA_SUCCESS) return ma_context_uninit(&d->context), free(d), NULL;
  }
  if (ma_device_start(&d->device) != MA_SUCCESS) return gv_device_stop(d), NULL;
  return d;
}

void gv_device_stop(gv_device *d) {
  if (!d) return;
  ma_device_uninit(&d->device);
  ma_context_uninit(&d->context);
  free(d);
}

int gv_device_mic_channels(const gv_device *d) { return (int)d->device.capture.channels; }
