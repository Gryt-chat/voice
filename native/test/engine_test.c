/* The engine end to end with no network, as scripts/check-transport-worklets.ts does for the worklets:
   a beep through capture, a loopback that adds the SFU's sender id, and render. */
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "../core/engine.h"

#define SR 48000
#define BLOCK 128

static gv_engine engine;
static int sent;

/* What the SFU does: the sender's id in front, then straight back. */
static void loopback(void *user, const uint8_t *packet, size_t len) {
  (void)user;
  uint8_t forwarded[4 + GV_HEADER_BYTES + GV_MAX_OPUS_BYTES] = {0, 0, 0, 7};
  memcpy(forwarded + 4, packet, len);
  gv_engine_receive(&engine, forwarded, len + 4);
  sent++;
}

/* One second with a 1 kHz beep at 0.5 s on the left, and on the right too unless left_only. */
static void run(int channels, int left_only, float *outL, float *outR) {
  static float in[BLOCK * 2], out[BLOCK * 2];
  for (int pos = 0; pos + BLOCK <= SR; pos += BLOCK) {
    for (int i = 0; i < BLOCK; i++) {
      int n = pos + i - SR / 2;
      float v = n >= 0 && n < SR * 8 / 100 ? 0.5f * sinf(2 * (float)M_PI * 1000 * n / SR) : 0;
      in[i * channels] = v;
      if (channels == 2) in[i * 2 + 1] = left_only ? 0 : v;
    }
    gv_engine_capture(&engine, in, BLOCK, channels);
    gv_engine_render(&engine, out, BLOCK);
    for (int i = 0; i < BLOCK; i++) {
      outL[pos + i] = out[2 * i];
      outR[pos + i] = out[2 * i + 1];
    }
  }
}

int main(void) {
  static float l[SR], r[SR];
  gv_effect_settings off = {100, 0, 200, 0.8, 0, -20, 0, 50, 0};
  assert(gv_engine_init(&engine, &off, 192000, 256000, loopback, NULL) == 0);

  run(1, 0, l, r);
  int onset = -1;
  for (int i = SR / 2; i < SR; i++)
    if (fabsf(l[i]) > 0.05f) { onset = i; break; }
  assert(onset > 0);
  double delay_ms = (onset - SR / 2) * 1000.0 / SR;
  float peak = 0, peakR = 0;
  for (int i = onset; i < onset + SR / 20; i++) {
    peak = fmaxf(peak, fabsf(l[i]));
    peakR = fmaxf(peakR, fabsf(r[i]));
  }
  assert(delay_ms > 0 && delay_ms < 15);
  assert(peak > 0.4f && peak < 0.6f && fabsf(peak - peakR) < 0.01f);

  /* A stereo mic with the beep on the left only: the left comes back, the right stays quiet. */
  run(2, 1, l, r);
  float left = 0, right = 0;
  for (int i = SR / 2; i < SR / 2 + SR / 10; i++) {
    left = fmaxf(left, fabsf(l[i]));
    right = fmaxf(right, fabsf(r[i]));
  }
  assert(left > 0.4f && left < 0.6f);
  assert(right < 0.02f);

  /* Speaking (GRYT-1830): the gate is open with no threshold, so sender 7 is heard speaking. */
  uint32_t ids[GV_MAX_SENDERS];
  assert(gv_engine_speaking(&engine, ids, GV_MAX_SENDERS) == 1 && ids[0] == 7);
  /* Levels: sender 7 is heard, and the beep's tail has gone quiet by the end of the run. */
  float db[GV_MAX_SENDERS], mic_db;
  int mic_speaking;
  assert(gv_engine_levels(&engine, ids, db, GV_MAX_SENDERS, &mic_db, &mic_speaking) == 1 && ids[0] == 7);
  assert(db[0] < -40 && mic_speaking);
  /* A beep at 0.5 is about -9 dBFS as it's sent and as it's heard. */
  static float tone[BLOCK], out2[BLOCK * 2];
  for (int t = 0; t < SR / 10; t += BLOCK) {
    for (int i = 0; i < BLOCK; i++) tone[i] = 0.5f * sinf(2 * (float)M_PI * 1000 * (t + i) / SR);
    gv_engine_capture(&engine, tone, BLOCK, 1);
    gv_engine_render(&engine, out2, BLOCK);
  }
  gv_engine_levels(&engine, ids, db, GV_MAX_SENDERS, &mic_db, &mic_speaking);
  assert(mic_db > -11 && mic_db < -7);
  assert(db[0] > -12 && db[0] < -7);
  /* Buffered, for the latency estimate: sender 7 is named, with no more queued than the jitter buffer's ceiling. */
  float buffered[GV_MAX_SENDERS];
  assert(gv_engine_buffered(&engine, ids, buffered, GV_MAX_SENDERS) == 1 && ids[0] == 7);
  assert(buffered[0] >= 0 && buffered[0] < 70);
  /* Per-sender volume (GRYT-1831): sender 7 at half plays at half, measured on what was heard before the gain. */
  uint32_t seven = 7;
  float half = 0.5f, peak_half = 0;
  gv_engine_set_gains(&engine, &seven, &half, 1);
  for (int t = 0; t < SR / 10; t += BLOCK) {
    for (int i = 0; i < BLOCK; i++) tone[i] = 0.5f * sinf(2 * (float)M_PI * 1000 * (t + i) / SR);
    gv_engine_capture(&engine, tone, BLOCK, 1);
    gv_engine_render(&engine, out2, BLOCK);
    for (int i = 0; i < BLOCK * 2; i++) peak_half = fmaxf(peak_half, fabsf(out2[i]));
  }
  assert(peak_half > 0.2f && peak_half < 0.3f);
  gv_engine_set_gains(&engine, NULL, NULL, 0);

  /* Muted: the timestamp keeps moving, but nothing is sent. */
  gv_engine_set_sending(&engine, 0);
  int before = sent;
  static float noise[BLOCK];
  for (int i = 0; i < BLOCK; i++) noise[i] = 0.3f;
  gv_engine_capture(&engine, noise, BLOCK, 1);
  gv_engine_capture(&engine, noise, BLOCK, 1);
  assert(sent == before);
  gv_engine_levels(&engine, ids, db, GV_MAX_SENDERS, &mic_db, &mic_speaking);
  assert(isinf(mic_db) && !mic_speaking);
  /* Nothing more arrives, so after the hold nobody is speaking. */
  static float silent[BLOCK * 2];
  for (int t = 0; t < SR * 3 / 10; t += BLOCK) gv_engine_render(&engine, silent, BLOCK);
  assert(gv_engine_speaking(&engine, ids, GV_MAX_SENDERS) == 0);

  gv_engine_destroy(&engine);
  printf("native engine ok: a beep through capture and render in %.1f ms with no network, at %.2f; stereo kept apart (right %.3f); muted sends nothing; speaking named and cleared; levels about -9 dB for a 0.5 beep, the mic silent when muted; per-sender volume\n",
         delay_ms, peak, right);
  return 0;
}
