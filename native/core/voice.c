#include "voice.h"

#include <stdlib.h>

#include "device.h"
#include "net.h"

struct gv_voice {
  gv_engine engine;
  gv_net *net;
  gv_device *device;
};

gv_voice *gv_voice_start(const char *const *addrs, int n_addrs, uint32_t session, const uint8_t key[32],
                         const gv_effect_settings *effects, unsigned period) {
  gv_voice *v = calloc(1, sizeof *v);
  if (!v) return NULL;
  /* Gryt's choice from the listening test: 192 kbps mono, 256 stereo (GRYT-1818). */
  if (gv_engine_init(&v->engine, effects, 192000, 256000, NULL, NULL) != 0) goto fail;
  v->net = gv_net_open(&v->engine, addrs, n_addrs, session, key);
  if (!v->net) goto fail;
  v->device = gv_device_start(&v->engine, NULL, period, NULL, NULL);
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

void gv_voice_set_sending(gv_voice *v, int on) { gv_engine_set_sending(&v->engine, on); }
void gv_voice_set_output_gain(gv_voice *v, float gain) { gv_engine_set_output_gain(&v->engine, gain); }
void gv_voice_set_effects(gv_voice *v, const gv_effect_settings *effects) { gv_engine_set_effects(&v->engine, effects); }
int gv_voice_route(const gv_voice *v) { return gv_net_chosen(v->net); }
int gv_voice_speaking(gv_voice *v, uint32_t *ids, int max) { return gv_engine_speaking(&v->engine, ids, max); }
void gv_voice_set_gains(gv_voice *v, const uint32_t *ids, const float *gains, int n) { gv_engine_set_gains(&v->engine, ids, gains, n); }
int gv_voice_levels(gv_voice *v, uint32_t *ids, float *db, int max, float *mic_db, int *mic_speaking) {
  return gv_engine_levels(&v->engine, ids, db, max, mic_db, mic_speaking);
}

int gv_voice_buffered(gv_voice *v, uint32_t *ids, float *ms, int max) {
  return gv_engine_buffered(&v->engine, ids, ms, max);
}

int gv_voice_rtt(gv_voice *v, uint32_t *ids, float *ms, int max) { return gv_engine_rtt(&v->engine, ids, ms, max); }
