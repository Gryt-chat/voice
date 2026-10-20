/* The engine over real UDP on localhost: a fake SFU opens what the engine sends and seals it back as a forwarded
   packet, the way sfu internal/audiotransport/udp.go does. The offer lists a dead address first. */
#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE
#endif
#include <arpa/inet.h>
#include <assert.h>
#include <math.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "../core/net.h"
#include "../core/seal.h"

#define SR 48000
#define BLOCK 128
static const uint8_t KEY[32] = {1, 2, 3};
static int sfu_fd;
static volatile int sfu_stop;

static void *fake_sfu(void *arg) {
  (void)arg;
  uint8_t buf[2048], out[2048];
  gv_replay replay = {0};
  uint32_t counter = 0;
  while (!sfu_stop) {
    struct sockaddr_in from;
    socklen_t len = sizeof from;
    ssize_t got = recvfrom(sfu_fd, buf, sizeof buf, 0, (struct sockaddr *)&from, &len);
    if (got <= 0) continue;
    uint32_t session;
    uint8_t *secret;
    size_t secret_len;
    if (gv_open(KEY, GV_TO_SFU, buf, (size_t)got, GV_HEADER_BYTES, &replay, &session, &secret, &secret_len) != 0) continue;
    uint8_t clear[4 + GV_HEADER_BYTES] = {0, 0, 0, 7};
    memcpy(clear + 4, buf + GV_SEAL_PREFIX, GV_HEADER_BYTES);
    size_t n = gv_seal(KEY, GV_FROM_SFU, session, ++counter, clear, sizeof clear, secret, secret_len, out, sizeof out);
    sendto(sfu_fd, out, n, 0, (struct sockaddr *)&from, len);
  }
  return NULL;
}

int main(void) {
  sfu_fd = socket(AF_INET, SOCK_DGRAM, 0);
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
  assert(bind(sfu_fd, (struct sockaddr *)&a, sizeof a) == 0);
  socklen_t alen = sizeof a;
  getsockname(sfu_fd, (struct sockaddr *)&a, &alen);
  struct timeval tv = {0, 100000};
  setsockopt(sfu_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  pthread_t t;
  pthread_create(&t, NULL, fake_sfu, NULL);

  static gv_engine engine;
  gv_effect_settings off = {100, 0, 200, 0.8, 0, -20, 0, 50, 0};
  assert(gv_engine_init(&engine, &off, 192000, 256000, NULL, NULL) == 0);
  char live[64];
  snprintf(live, sizeof live, "127.0.0.1:%d", ntohs(a.sin_port));
  const char *addrs[] = {"127.0.0.1:9", live};
  gv_net *net = gv_net_open(&engine, addrs, 2, 0x0a0b0c0d, KEY);
  assert(net);

  /* One second in real time: a beep at 0.5 s, captured and rendered a block at a time like a device would. */
  static float l[SR];
  static float in[BLOCK], out[BLOCK * 2];
  for (int pos = 0; pos + BLOCK <= SR; pos += BLOCK) {
    for (int i = 0; i < BLOCK; i++) {
      int k = pos + i - SR / 2;
      in[i] = k >= 0 && k < SR * 8 / 100 ? 0.5f * sinf(2 * (float)M_PI * 1000 * k / SR) : 0;
    }
    gv_engine_capture(&engine, in, BLOCK, 1);
    nanosleep(&(struct timespec){0, BLOCK * 1000000000L / SR}, NULL);
    gv_engine_render(&engine, out, BLOCK);
    for (int i = 0; i < BLOCK; i++) l[pos + i] = out[2 * i];
  }
  int onset = -1;
  float peak = 0;
  for (int i = SR / 2; i < SR; i++) {
    if (onset < 0 && fabsf(l[i]) > 0.05f) onset = i;
    peak = fmaxf(peak, fabsf(l[i]));
  }
  assert(onset > 0);
  assert(peak > 0.4f && peak < 0.6f);
  assert(gv_net_chosen(net) == 1);
  double delay = (onset - SR / 2) * 1000.0 / SR;

  gv_net_close(net);
  sfu_stop = 1;
  pthread_join(t, NULL);
  close(sfu_fd);
  gv_engine_destroy(&engine);
  printf("native net ok: a beep over real UDP through a fake SFU in %.1f ms, at %.2f; the live address won the race\n", delay, peak);
  return 0;
}
