/* The engine over real UDP through a fake SFU that seals each packet back as udp.go does, a dead address listed
   first. Then, with only the dead one, the same over a fake /audio-ws. */
#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE
#endif
#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <math.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "../core/net.h"
#include "../core/seal.h"

#define SR 48000
#define BLOCK 128
static const uint8_t KEY[32] = {1, 2, 3};
static int sfu_fd;
static volatile int sfu_stop, keep_alives, ws_conns, ws_keep_alives, ws_pongs;
static int ws_fd;

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
    /* The Rust SFU answers a keep-alive with an empty packet from sender 0. */
    if (secret_len == 0) keep_alives++, memset(clear, 0, sizeof clear);
    size_t n = gv_seal(KEY, GV_FROM_SFU, session, ++counter, clear, sizeof clear, secret, secret_len, out, sizeof out);
    sendto(sfu_fd, out, n, 0, (struct sockaddr *)&from, len);
  }
  return NULL;
}

static int read_n(int fd, uint8_t *b, size_t n) {
  for (size_t got = 0; got < n;) {
    ssize_t k = recv(fd, b + got, n - got, 0);
    if (k <= 0) return -1;
    got += (size_t)k;
  }
  return 0;
}

/* Upgrades /audio-ws?ticket=t, pings once, then sends every masked binary message back unmasked from sender 7. */
static void *fake_ws(void *arg) {
  (void)arg;
  while (!sfu_stop) {
    fd_set s;
    FD_ZERO(&s);
    FD_SET(ws_fd, &s);
    struct timeval tv = {0, 100000};
    if (select(ws_fd + 1, &s, NULL, NULL, &tv) <= 0) continue;
    int c = accept(ws_fd, NULL, NULL);
    ws_conns++;
    char req[2048] = {0};
    size_t len = 0;
    while (!strstr(req, "\r\n\r\n") && len < sizeof req - 1) {
      ssize_t k = recv(c, req + len, sizeof req - 1 - len, 0);
      if (k <= 0) break;
      len += (size_t)k;
    }
    assert(strstr(req, "GET /audio-ws?ticket=t HTTP/1.1\r\n") == req);
    const char *ok = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
    send(c, ok, strlen(ok), 0);
    send(c, "\x89\x02hi", 4, 0);
    uint8_t h[4], mask[4], p[2048], out[2048];
    struct timeval rt = {0, 100000};
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &rt, sizeof rt);
    while (!sfu_stop) {
      if (read_n(c, h, 2) != 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
        break;
      }
      size_t n = h[1] & 0x7f;
      if (n == 126 && read_n(c, h + 2, 2) == 0) n = (size_t)(h[2] << 8 | h[3]);
      assert(h[1] & 0x80);
      if (read_n(c, mask, 4) != 0 || n > sizeof p || read_n(c, p, n) != 0) break;
      for (size_t i = 0; i < n; i++) p[i] ^= mask[i & 3];
      if ((h[0] & 0x0f) == 10) ws_pongs += n == 2 && !memcmp(p, "hi", 2);
      if ((h[0] & 0x0f) != 2) continue;
      if (n == GV_HEADER_BYTES) {
        ws_keep_alives++;
        continue;
      }
      size_t m = 4 + n, at = m < 126 ? 2 : 4;
      out[0] = 0x82;
      if (at == 2) out[1] = (uint8_t)m;
      else out[1] = 126, out[2] = (uint8_t)(m >> 8), out[3] = (uint8_t)m;
      memcpy(out + at, "\0\0\0\7", 4);
      memcpy(out + at + 4, p, n);
      send(c, out, at + m, 0);
    }
    close(c);
  }
  return NULL;
}

/* One second in real time: a beep at 0.5 s, captured and rendered a block at a time like a device would. */
static void beep(gv_engine *engine, int *onset, float *peak) {
  static float l[SR];
  static float in[BLOCK], out[BLOCK * 2];
  for (int pos = 0; pos + BLOCK <= SR; pos += BLOCK) {
    for (int i = 0; i < BLOCK; i++) {
      int k = pos + i - SR / 2;
      in[i] = k >= 0 && k < SR * 8 / 100 ? 0.5f * sinf(2 * (float)M_PI * 1000 * k / SR) : 0;
    }
    gv_engine_capture(engine, in, BLOCK, 1);
    nanosleep(&(struct timespec){0, BLOCK * 1000000000L / SR}, NULL);
    gv_engine_render(engine, out, BLOCK);
    for (int i = 0; i < BLOCK; i++) l[pos + i] = out[2 * i];
  }
  *onset = -1;
  *peak = 0;
  for (int i = SR / 2; i < SR; i++) {
    if (*onset < 0 && fabsf(l[i]) > 0.05f) *onset = i;
    *peak = fmaxf(*peak, fabsf(l[i]));
  }
}

int main(void) {
  sfu_fd = socket(AF_INET, SOCK_DGRAM, 0);
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
  assert(bind(sfu_fd, (struct sockaddr *)&a, sizeof a) == 0);
  socklen_t alen = sizeof a;
  getsockname(sfu_fd, (struct sockaddr *)&a, &alen);
  struct timeval tv = {0, 100000};
  setsockopt(sfu_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  pthread_t t, tw;
  pthread_create(&t, NULL, fake_sfu, NULL);
  ws_fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in w = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
  assert(bind(ws_fd, (struct sockaddr *)&w, sizeof w) == 0 && listen(ws_fd, 4) == 0);
  socklen_t wlen = sizeof w;
  getsockname(ws_fd, (struct sockaddr *)&w, &wlen);
  pthread_create(&tw, NULL, fake_ws, NULL);
  char ws_url[64];
  snprintf(ws_url, sizeof ws_url, "ws://127.0.0.1:%d/audio-ws?ticket=t", ntohs(w.sin_port));

  static gv_engine engine;
  gv_effect_settings off = {100, 0, 200, 0.8, 0, -20, 0, 50, 0};
  assert(gv_engine_init(&engine, &off, 192000, 256000, NULL, NULL) == 0);
  char live[64];
  snprintf(live, sizeof live, "127.0.0.1:%d", ntohs(a.sin_port));
  const char *addrs[] = {"127.0.0.1:9", live};
  gv_net *net = gv_net_open(&engine, addrs, 2, 0x0a0b0c0d, KEY, ws_url);
  assert(net);

  int onset;
  float peak;
  beep(&engine, &onset, &peak);
  assert(onset > 0);
  assert(peak > 0.4f && peak < 0.6f);
  assert(gv_net_chosen(net) == 1);
  /* One on the first route check, and nothing that makes a second before 2 s. */
  assert(keep_alives == 1);
  double delay = (onset - SR / 2) * 1000.0 / SR;
  /* Past the 2 s UDP gets: it answered, so /audio-ws is never dialled. */
  nanosleep(&(struct timespec){1, 500000000L}, NULL);
  assert(ws_conns == 0 && gv_net_chosen(net) == 1);
  gv_net_close(net);

  static gv_engine blocked;
  assert(gv_engine_init(&blocked, &off, 192000, 256000, NULL, NULL) == 0);
  const char *dead[] = {"127.0.0.1:9"};
  gv_net *via_ws = gv_net_open(&blocked, dead, 1, 0x0a0b0c0d, KEY, ws_url);
  assert(via_ws);
  nanosleep(&(struct timespec){2, 300000000L}, NULL);
  assert(ws_conns == 1 && gv_net_chosen(via_ws) == 1);
  int ws_onset;
  float ws_peak;
  beep(&blocked, &ws_onset, &ws_peak);
  assert(ws_onset > 0 && ws_peak > 0.4f && ws_peak < 0.6f);
  assert(ws_pongs == 1);
  gv_net_close(via_ws);
  gv_engine_destroy(&blocked);
  sfu_stop = 1;
  pthread_join(t, NULL);
  pthread_join(tw, NULL);
  close(sfu_fd);
  close(ws_fd);
  gv_engine_destroy(&engine);
  printf("native net ok: a beep over real UDP through a fake SFU in %.1f ms, at %.2f; the live address won the race; %d keep-alive\n", delay, peak, keep_alives);
  printf("native net ok: with UDP dead, the beep over /audio-ws in %.1f ms, at %.2f; the ping answered\n", (ws_onset - SR / 2) * 1000.0 / SR, ws_peak);
  return 0;
}
