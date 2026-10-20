#include "effects.h"

#include <math.h>

#define METER_MIN_DB -100.0
#define METER_MAX_DB -30.0
#define GATE_RAMP_SECONDS 0.01
#define COMPRESSOR_ATTACK_SECONDS 0.003
#define COMPRESSOR_RELEASE_SECONDS 0.25
#define COMPRESSOR_MAKEUP_DB 3.0
#define AGC_STEP_SECONDS 0.05
#define AGC_SILENCE 0.001
#define AGC_MIN_GAIN 0.1
#define AGC_MAX_GAIN 4.0
#define AGC_SMOOTH_UP 0.02
#define AGC_SMOOTH_DOWN 0.5
#define AGC_GLIDE_SECONDS 0.05

static double db_to_gain(double db) { return pow(10, db / 20); }
static double maxd(double a, double b) { return a > b ? a : b; }
static double mind(double a, double b) { return a < b ? a : b; }

void gv_effects_init(gv_effects *fx, double sample_rate, const gv_effect_settings *s) {
  *fx = (gv_effects){.s = *s, .sample_rate = sample_rate, .gate_gain = 1, .gate_open = 1, .agc_target = 1, .agc_gain = 1};
}

void gv_effects_process(gv_effects *fx, float *left, float *right, size_t n) {
  const gv_effect_settings *s = &fx->s;
  double sr = fx->sample_rate, volume = maxd(0, s->volume) / 100;
  const double ceiling = pow(10, -1.0 / 20), peak_ceiling = pow(10, -6.0 / 20);

  /* The gate decides once a block, on the louder side's level after the volume. */
  double sum = 0;
  for (size_t i = 0; i < n; i++) {
    double v = maxd(fabs(left[i]), right ? fabs(right[i]) : 0) * volume;
    sum += v * v;
  }
  double rms = sqrt(sum / (n > 1 ? (double)n : 1));
  double db = rms > 0 ? 20 * log10(rms) : METER_MIN_DB;
  double clamped = mind(METER_MAX_DB, maxd(METER_MIN_DB, db));
  double instant = (clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB) * 100;
  fx->level = s->gate_smoothing * fx->level + (1 - s->gate_smoothing) * instant;
  if (s->gate_threshold <= 0) {
    fx->gate_open = 1;
  } else if (fx->level >= s->gate_threshold) {
    fx->gate_open = 1;
    fx->hold_samples = s->gate_release_ms / 1000 * sr;
  } else if (fx->gate_open) {
    fx->hold_samples -= (double)n;
    if (fx->hold_samples <= 0) fx->gate_open = 0;
  }

  double gate_target = fx->gate_open ? 1 : 0, gate_step = 1 / (GATE_RAMP_SECONDS * sr);
  double attack = exp(-1 / (COMPRESSOR_ATTACK_SECONDS * sr)), release = exp(-1 / (COMPRESSOR_RELEASE_SECONDS * sr));
  double t = s->compressor_amount / 100, threshold = -10 + t * -30, ratio = 1 + t * 19;
  double makeup = s->compressor_amount > 0 ? db_to_gain(COMPRESSOR_MAKEUP_DB) : 1;
  double agc_glide = 1 - exp(-1 / (AGC_GLIDE_SECONDS * sr));
  int agc_step = (int)floor(AGC_STEP_SECONDS * sr + 0.5);
  double agc_wanted = db_to_gain(s->auto_gain_target_db);

  for (size_t i = 0; i < n; i++) {
    double r = right ? right[i] * volume : 0, x = left[i] * volume, gain = 1;
    if (s->auto_gain) {
      double d = fabs(r * gain) > fabs(x) ? r * gain : x;
      fx->agc_sum += d * d;
      fx->agc_peak = maxd(fx->agc_peak, fabs(d));
      if (++fx->agc_count >= agc_step) {
        double level = sqrt(fx->agc_sum / fx->agc_count);
        if (level > AGC_SILENCE) {
          double desired = mind(agc_wanted / level, peak_ceiling / maxd(fx->agc_peak, 1e-6));
          double want = maxd(AGC_MIN_GAIN, mind(AGC_MAX_GAIN, desired));
          fx->agc_target += (want - fx->agc_target) * (want > fx->agc_target ? AGC_SMOOTH_UP : AGC_SMOOTH_DOWN);
        }
        fx->agc_sum = 0;
        fx->agc_peak = 0;
        fx->agc_count = 0;
      }
      fx->agc_gain += (fx->agc_target - fx->agc_gain) * agc_glide;
      x *= fx->agc_gain;
      gain *= fx->agc_gain;
    }
    if (s->compressor) {
      double a = fabs(fabs(r * gain) > fabs(x) ? r * gain : x);
      fx->comp_env = a > fx->comp_env ? attack * fx->comp_env + (1 - attack) * a : release * fx->comp_env + (1 - release) * a;
      double over = 20 * log10(fx->comp_env + 1e-9) - threshold;
      double g = (over > 0 ? db_to_gain(-over * (1 - 1 / ratio)) : 1) * makeup;
      x *= g;
      gain *= g;
    }
    if (s->limiter) x = ceiling * tanh(x / ceiling);
    if (fx->gate_gain < gate_target) fx->gate_gain = mind(gate_target, fx->gate_gain + gate_step);
    else if (fx->gate_gain > gate_target) fx->gate_gain = maxd(gate_target, fx->gate_gain - gate_step);
    left[i] = (float)(x * fx->gate_gain);
    if (right) right[i] = (float)((s->limiter ? ceiling * tanh(r * gain / ceiling) : r * gain) * fx->gate_gain);
  }
}
