/* The native engine on real devices. measure <device> <period> <seconds>: a click through the whole engine and out
   and back in through a loopback device (BlackHole), timed in samples. echo [period]: hear yourself (headphones). */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../core/device.h"
#include <time.h>

#define SR 48000
#define EVERY (SR / 4)

static gv_engine engine;
static unsigned long long clock_frames, last_click;
static int armed, n_lat;
static long lat[1000];

/* What the SFU does, without the network: the sender's id in front, straight back. */
static void loopback(void *user, const uint8_t *packet, size_t len) {
  (void)user;
  uint8_t forwarded[4 + GV_HEADER_BYTES + GV_MAX_OPUS_BYTES] = {0, 0, 0, 1};
  memcpy(forwarded + 4, packet, len);
  gv_engine_receive(&engine, forwarded, len + 4);
}

static void measure_tap(void *user, float *mic, float *out, unsigned frames, int ch, int stage) {
  (void)user;
  (void)out;
  if (stage != 0) return;
  for (unsigned i = 0; i < frames; i++) {
    unsigned long long t = clock_frames + i;
    if (armed && fabsf(mic[i * ch]) > 0.3f && t > last_click) {
      if (n_lat < 1000) lat[n_lat++] = (long)(t - last_click);
      armed = 0;
    }
  }
  for (unsigned i = 0; i < frames; i++) {
    unsigned long long p = (clock_frames + i) % EVERY;
    for (int c = 0; c < ch; c++) mic[i * ch + c] = p < 48 ? 0.8f : 0.0f;
    if (p == 0) {
      last_click = clock_frames + i;
      armed = 1;
    }
  }
  clock_frames += frames;
}

static int cmp(const void *a, const void *b) { return (int)(*(const long *)a - *(const long *)b); }

int main(int argc, char **argv) {
  gv_effect_settings off = {100, 0, 200, 0.8, 0, -20, 0, 50, 0};
  if (gv_engine_init(&engine, &off, 192000, 256000, loopback, NULL) != 0) return 1;
  if (argc >= 2 && !strcmp(argv[1], "measure")) {
    const char *name = argc > 2 ? argv[2] : "BlackHole";
    unsigned period = argc > 3 ? (unsigned)atoi(argv[3]) : 32;
    int secs = argc > 4 ? atoi(argv[4]) : 6;
    gv_device *d = gv_device_start(&engine, name, period, measure_tap, NULL);
    if (!d) return fprintf(stderr, "no device matching %s\n", name), 1;
    nanosleep(&(struct timespec){secs, 0}, NULL);
    gv_device_stop(d);
    if (!n_lat) return printf("period %u: no clicks came back\n", period), 0;
    qsort(lat, n_lat, sizeof(long), cmp);
    /* The first click comes before the jitter buffer has filled; the median is the steady state. */
    printf("period %4u: click through the engine and back in, median %.2f ms, min %.2f, max %.2f, %d clicks\n", period,
           lat[n_lat / 2] * 1000.0 / SR, lat[0] * 1000.0 / SR, lat[n_lat - 1] * 1000.0 / SR, n_lat);
  } else if (argc >= 2 && !strcmp(argv[1], "echo")) {
    unsigned period = argc > 2 ? (unsigned)atoi(argv[2]) : 64;
    gv_device *d = gv_device_start(&engine, NULL, period, NULL, NULL);
    if (!d) return fprintf(stderr, "no default device\n"), 1;
    printf("You should hear yourself through the engine (mic %s). Use headphones. Enter stops it.\n",
           gv_device_mic_channels(d) == 2 ? "stereo" : "mono");
    getchar();
    gv_device_stop(d);
  } else {
    fprintf(stderr, "usage: voice_tool measure [device] [period] [seconds] | echo [period]\n");
    return 2;
  }
  gv_engine_destroy(&engine);
  return 0;
}
