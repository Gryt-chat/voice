#include "voice.h"

#include <stdlib.h>
#include <string.h>

#include "device.h"
#include "net.h"

struct gv_voice {
  gv_engine engine;
  gv_net *net;
  gv_device *device;
  unsigned period;
  int hear;
};

/* What the SFU would do with the monitor's packets: the sender's id in front, straight back. */
static void loopback(void *user, const uint8_t *packet, size_t len) {
  gv_voice *v = user;
  if (!v->hear || len > GV_HEADER_BYTES + GV_MAX_OPUS_BYTES) return;
  uint8_t forwarded[4 + GV_HEADER_BYTES + GV_MAX_OPUS_BYTES] = {0, 0, 0, 1};
  memcpy(forwarded + 4, packet, len);
  gv_engine_receive(&v->engine, forwarded, len + 4);
}

gv_voice *gv_voice_monitor(const gv_effect_settings *effects, unsigned period, int hear) {
  gv_voice *v = calloc(1, sizeof *v);
  if (!v) return NULL;
  v->hear = hear;
  v->period = period;
  if (gv_engine_init(&v->engine, effects, 510000, 510000, loopback, v) != 0) goto fail;
  gv_engine_set_sending(&v->engine, 1);
  v->device = gv_device_start(&v->engine, NULL, NULL, period, NULL, NULL);
  if (!v->device) goto fail;
  return v;
fail:
  gv_voice_stop(v);
  return NULL;
}

void gv_voice_mic_input(gv_voice *v, float *raw_db, float *gate_level) { gv_engine_mic_input(&v->engine, raw_db, gate_level); }

gv_voice *gv_voice_start(const char *const *addrs, int n_addrs, uint32_t session, const uint8_t key[32],
                         const gv_effect_settings *effects, unsigned period) {
  gv_voice *v = calloc(1, sizeof *v);
  if (!v) return NULL;
  /* Opus's ceiling for both, as the worklet starts at: a 2.5 ms frame gets about 60 bytes at 192 kbps. */
  if (gv_engine_init(&v->engine, effects, 510000, 510000, NULL, NULL) != 0) goto fail;
  v->net = gv_net_open(&v->engine, addrs, n_addrs, session, key);
  if (!v->net) goto fail;
  v->period = period;
  v->device = gv_device_start(&v->engine, NULL, NULL, period, NULL, NULL);
  if (!v->device) goto fail;
  return v;
fail:
  gv_voice_stop(v);
  return NULL;
}

void gv_voice_stop(gv_voice *v) {
  if (!v) return;
  gv_device_stop(v->device);
  gv_net_close(v->net);
  gv_engine_destroy(&v->engine);
  free(v);
}

int gv_voice_use_devices(gv_voice *v, const char *capture, const char *playback) {
  gv_device_stop(v->device);
  v->device = gv_device_start(&v->engine, capture, playback, v->period, NULL, NULL);
  /* A name that no longer matches anything falls back to the defaults rather than going silent. */
  if (!v->device) v->device = gv_device_start(&v->engine, NULL, NULL, v->period, NULL, NULL);
  return v->device ? 0 : -1;
}

void gv_voice_set_sending(gv_voice *v, int on) { gv_engine_set_sending(&v->engine, on); }
void gv_voice_set_output_gain(gv_voice *v, float gain) { gv_engine_set_output_gain(&v->engine, gain); }
void gv_voice_set_effects(gv_voice *v, const gv_effect_settings *effects) { gv_engine_set_effects(&v->engine, effects); }
void gv_voice_set_bitrate(gv_voice *v, int bitrate) { gv_engine_set_bitrate(&v->engine, bitrate); }
int gv_voice_route(const gv_voice *v) { return v->net ? gv_net_chosen(v->net) : -1; }
int gv_voice_speaking(gv_voice *v, uint32_t *ids, int max) { return gv_engine_speaking(&v->engine, ids, max); }
void gv_voice_set_gains(gv_voice *v, const uint32_t *ids, const float *gains, int n) { gv_engine_set_gains(&v->engine, ids, gains, n); }
int gv_voice_levels(gv_voice *v, uint32_t *ids, float *db, int max, float *mic_db, int *mic_speaking) {
  return gv_engine_levels(&v->engine, ids, db, max, mic_db, mic_speaking);
}

int gv_voice_buffered(gv_voice *v, uint32_t *ids, float *ms, int max) {
  return gv_engine_buffered(&v->engine, ids, ms, max);
}

int gv_voice_rtt(gv_voice *v, uint32_t *ids, float *ms, int max) { return gv_engine_rtt(&v->engine, ids, ms, max); }
