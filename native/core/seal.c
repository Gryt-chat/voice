#include "seal.h"

#include <string.h>

#include "../vendor/monocypher/monocypher.h"

static void put32(uint8_t *b, uint32_t v) {
  b[0] = (uint8_t)(v >> 24); b[1] = (uint8_t)(v >> 16); b[2] = (uint8_t)(v >> 8); b[3] = (uint8_t)v;
}
static uint32_t get32(const uint8_t *b) { return (uint32_t)b[0] << 24 | (uint32_t)b[1] << 16 | (uint32_t)b[2] << 8 | b[3]; }

/* 96-bit nonce: the direction, three zero bytes, then the counter as a big-endian u64. */
static void nonce(uint8_t n[12], uint8_t dir, uint32_t counter) {
  memset(n, 0, 12);
  n[0] = dir;
  put32(n + 8, counter);
}

size_t gv_seal(const uint8_t key[GV_KEY_BYTES], uint8_t dir, uint32_t session, uint32_t counter,
               const uint8_t *clear, size_t clear_len, const uint8_t *secret, size_t secret_len,
               uint8_t *out, size_t cap) {
  size_t ad_len = GV_SEAL_PREFIX + clear_len;
  size_t len = ad_len + secret_len + GV_TAG_BYTES;
  if (len > cap) return 0;
  put32(out, session);
  put32(out + 4, counter);
  memcpy(out + GV_SEAL_PREFIX, clear, clear_len);
  uint8_t n[12];
  nonce(n, dir, counter);
  crypto_aead_ctx ctx;
  crypto_aead_init_ietf(&ctx, key, n);
  crypto_aead_write(&ctx, out + ad_len, out + ad_len + secret_len, out, ad_len, secret, secret_len);
  crypto_wipe(&ctx, sizeof ctx);
  return len;
}

/* The counter is new if it's past the highest seen, or within 64 below it and not seen yet. */
static int fresh(const gv_replay *r, uint32_t c) {
  if (!r->started || c > r->top) return 1;
  uint32_t back = r->top - c;
  return back < 64 && !(r->seen >> back & 1);
}

static void mark(gv_replay *r, uint32_t c) {
  if (!r->started) {
    r->started = 1; r->top = c; r->seen = 1;
  } else if (c > r->top) {
    uint32_t shift = c - r->top;
    r->seen = shift >= 64 ? 1 : r->seen << shift | 1;
    r->top = c;
  } else {
    r->seen |= (uint64_t)1 << (r->top - c);
  }
}

int gv_open(const uint8_t key[GV_KEY_BYTES], uint8_t dir, uint8_t *buf, size_t len, size_t clear_len,
            gv_replay *replay, uint32_t *session, uint8_t **secret, size_t *secret_len) {
  size_t ad_len = GV_SEAL_PREFIX + clear_len;
  if (len < ad_len + GV_TAG_BYTES) return -1;
  uint32_t counter = get32(buf + 4);
  if (!fresh(replay, counter)) return -1;
  size_t n_secret = len - ad_len - GV_TAG_BYTES;
  uint8_t n[12];
  nonce(n, dir, counter);
  crypto_aead_ctx ctx;
  crypto_aead_init_ietf(&ctx, key, n);
  /* Only a packet whose tag holds may move the replay window, so a forgery can't push it along. */
  int bad = crypto_aead_read(&ctx, buf + ad_len, buf + ad_len + n_secret, buf, ad_len, buf + ad_len, n_secret);
  crypto_wipe(&ctx, sizeof ctx);
  if (bad) return -1;
  mark(replay, counter);
  *session = get32(buf);
  *secret = buf + ad_len;
  *secret_len = n_secret;
  return 0;
}
