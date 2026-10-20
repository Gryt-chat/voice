/* The native core's unit checks, plus hex in and out for scripts/check-native-core.ts to compare against
   the TypeScript packet format and OpenSSL's ChaCha20-Poly1305. */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
  } else return 2;
  return 0;
}
