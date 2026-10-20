/* The microphone effects, the same as src/audio/voiceEffects.ts: gate, volume, auto gain, compressor and
   soft limiter, sample by sample with no lookahead. One gain for both sides in stereo. GRYT-1822. */
#ifndef GRYT_VOICE_EFFECTS_H
#define GRYT_VOICE_EFFECTS_H

#include <stddef.h>

typedef struct {
  double volume, gate_threshold, gate_release_ms, gate_smoothing;
  int auto_gain;
  double auto_gain_target_db;
  int compressor;
  double compressor_amount;
  int limiter;
} gv_effect_settings;

typedef struct {
  gv_effect_settings s;
  double sample_rate, level, gate_gain, hold_samples, comp_env, agc_target, agc_gain, agc_sum, agc_peak;
  int gate_open, agc_count;
} gv_effects;

void gv_effects_init(gv_effects *fx, double sample_rate, const gv_effect_settings *s);
/* In place. right may be NULL for mono. */
void gv_effects_process(gv_effects *fx, float *left, float *right, size_t n);

#endif
