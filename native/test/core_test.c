/* The native core's unit checks, plus hex in and out for scripts/check-native-core.ts to compare against
   the TypeScript packet format and OpenSSL's ChaCha20-Poly1305. */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../core/effects.h"
#include "../core/jitter.h"
#include "../core/packet.h"
#include "../core/seal.h"

static size_t unhex(const char *s, uint8_t *out) {
  size_t n = strlen(s) / 2;
  for (size_t i = 0; i < n; i++) sscanf(s + 2 * i, "%2hhx", &out[i]);
  return n;
}
static void hex(const uint8_t *b, size_t n) {
  for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
  printf("\n");
}

static void unit(void) {
  uint8_t opus[3] = {1, 2, 3}, buf[2048], key[32] = {7};
  gv_packet p = {GV_FLAG_SPEAKING, 0xfffe, 0x01020304, opus, 3}, q;
  size_t n = gv_write_packet(&p, buf, sizeof buf);
  assert(n == 11 && gv_read_packet(buf, n, &q) == 0);
  assert(q.flags == 1 && q.seq == 0xfffe && q.timestamp == 0x01020304 && q.opus_len == 3 && q.opus[2] == 3);
  assert(gv_read_packet(buf, GV_HEADER_BYTES, &q) == -1);
  buf[0] = 2;
  assert(gv_read_packet(buf, n, &q) == -1);
  p.opus_len = GV_MAX_OPUS_BYTES + 1;
  assert(gv_write_packet(&p, buf, sizeof buf) == 0);
  assert(gv_seq_delta(0xffff, 1) == 2 && gv_seq_delta(1, 0xffff) == -2);

  /* Seal, open, and every way it must refuse: tampering, the wrong direction, a replay, a too-old counter. */
  uint8_t clear[8] = {1, 0, 0, 5, 0, 0, 0, 9}, secret[4] = {9, 9, 9, 9}, *out;
  size_t out_len;
  uint32_t session;
  gv_replay r = {0};
  n = gv_seal(key, GV_TO_SFU, 42, 100, clear, 8, secret, 4, buf, sizeof buf);
  assert(n == 8 + 8 + 4 + 16);
  uint8_t copy[64];
  memcpy(copy, buf, n);
  assert(gv_open(key, GV_FROM_SFU, copy, n, 8, &r, &session, &out, &out_len) == -1);
  memcpy(copy, buf, n);
  copy[10] ^= 1;
  assert(gv_open(key, GV_TO_SFU, copy, n, 8, &r, &session, &out, &out_len) == -1);
  memcpy(copy, buf, n);
  assert(gv_open(key, GV_TO_SFU, copy, n, 8, &r, &session, &out, &out_len) == 0);
  assert(session == 42 && out_len == 4 && memcmp(out, secret, 4) == 0);
  memcpy(copy, buf, n);
  assert(gv_open(key, GV_TO_SFU, copy, n, 8, &r, &session, &out, &out_len) == -1);
  n = gv_seal(key, GV_TO_SFU, 42, 200, clear, 8, secret, 4, buf, sizeof buf);
  assert(gv_open(key, GV_TO_SFU, buf, n, 8, &r, &session, &out, &out_len) == 0);
  n = gv_seal(key, GV_TO_SFU, 42, 180, clear, 8, secret, 4, buf, sizeof buf);
  assert(gv_open(key, GV_TO_SFU, buf, n, 8, &r, &session, &out, &out_len) == 0);
  n = gv_seal(key, GV_TO_SFU, 42, 120, clear, 8, secret, 4, buf, sizeof buf);
  assert(gv_open(key, GV_TO_SFU, buf, n, 8, &r, &session, &out, &out_len) == -1);
  assert(gv_open(key, GV_TO_SFU, buf, 20, 8, &r, &session, &out, &out_len) == -1);
  printf("native core ok\n");
}

int main(int argc, char **argv) {
  static uint8_t a[4096], b[4096], c[4096];
  if (argc == 2 && !strcmp(argv[1], "unit")) unit();
  else if (argc == 6 && !strcmp(argv[1], "packet")) {
    gv_packet p = {(uint8_t)atoi(argv[2]), (uint16_t)atoi(argv[3]), (uint32_t)strtoul(argv[4], 0, 10), a, unhex(argv[5], a)};
    hex(b, gv_write_packet(&p, b, sizeof b));
  } else if (argc == 8 && !strcmp(argv[1], "seal")) {
    unhex(argv[2], c);
    size_t cl = unhex(argv[6], a), sl = unhex(argv[7], b);
    uint8_t out[4096];
    hex(out, gv_seal(c, (uint8_t)atoi(argv[3]), (uint32_t)strtoul(argv[4], 0, 10), (uint32_t)strtoul(argv[5], 0, 10), a, cl, b, sl, out, sizeof out));
  } else if (argc == 6 && !strcmp(argv[1], "open")) {
    unhex(argv[2], c);
    size_t len = unhex(argv[5], a), out_len;
    uint8_t *out;
    uint32_t session;
    gv_replay r = {0};
    if (gv_open(c, (uint8_t)atoi(argv[3]), a, len, (size_t)atoi(argv[4]), &r, &session, &out, &out_len)) printf("reject\n");
    else hex(out, out_len);
  } else if (argc == 2 && !strcmp(argv[1], "jitter")) {
    /* Stdin: "push seq timestamp arrival_ms" and "pull" lines. Stdout: one line per pull, then the stats. */
    static gv_jitter j;
    gv_jitter_init(&j, 2.5, 5, 60);
    char op[8];
    while (scanf("%7s", op) == 1) {
      if (!strcmp(op, "push")) {
        unsigned seq;
        unsigned long ts;
        double at;
        if (scanf("%u %lu %lf", &seq, &ts, &at) != 3) return 2;
        uint8_t opus[2] = {(uint8_t)seq, (uint8_t)(seq >> 8)};
        gv_packet p = {0, (uint16_t)seq, (uint32_t)ts, opus, 2};
        gv_jitter_push(&j, &p, at);
      } else {
        gv_packet out;
        gv_pull_kind k = gv_jitter_pull(&j, &out);
        if (k == GV_PULL_PACKET) printf("P %u\n", out.seq);
        else printf(k == GV_PULL_LOST ? "L\n" : "S\n");
      }
    }
    printf("stats %u %u %u %u %u\n", j.stats.late, j.stats.duplicate, j.stats.lost, j.stats.drained, j.stats.rebuffered);
  } else if (argc == 15 && !strcmp(argv[1], "effects")) {
    /* Settings as numbers, then stereo, block size, and planar float32 files in and out (left, then right). */
    gv_effect_settings s = {atof(argv[2]), atof(argv[3]), atof(argv[4]), atof(argv[5]), atoi(argv[6]), atof(argv[7]),
                            atoi(argv[8]), atof(argv[9]), atoi(argv[10])};
    int stereo = atoi(argv[11]);
    size_t block = (size_t)atoi(argv[12]);
    FILE *in = fopen(argv[13], "rb");
    if (!in) return 3;
    fseek(in, 0, SEEK_END);
    size_t n = (size_t)ftell(in) / sizeof(float) / (stereo ? 2 : 1);
    fseek(in, 0, SEEK_SET);
    float *l = malloc(n * sizeof(float)), *r = stereo ? malloc(n * sizeof(float)) : NULL;
    if (fread(l, sizeof(float), n, in) != n || (r && fread(r, sizeof(float), n, in) != n)) return 3;
    fclose(in);
    gv_effects fx;
    gv_effects_init(&fx, 48000, &s);
    for (size_t at = 0; at < n; at += block) gv_effects_process(&fx, l + at, r ? r + at : NULL, at + block > n ? n - at : block);
    FILE *out = fopen(argv[14], "wb");
    if (!out) return 3;
    fwrite(l, sizeof(float), n, out);
    if (r) fwrite(r, sizeof(float), n, out);
    fclose(out);
    free(l);
    free(r);
  } else return 2;
  return 0;
}
