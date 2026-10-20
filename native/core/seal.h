/* The native engine's encrypted datagram: session u32, counter u32, the clear part (a packet header,
   with the SFU's sender id in front when forwarded), the Opus payload sealed, a 16-byte tag. GRYT-1822. */
#ifndef GRYT_VOICE_SEAL_H
#define GRYT_VOICE_SEAL_H

#include <stddef.h>
#include <stdint.h>

#define GV_KEY_BYTES 32
#define GV_SEAL_PREFIX 8
#define GV_TAG_BYTES 16
/* Each direction has its own nonce space under the one session key. */
#define GV_TO_SFU 0
#define GV_FROM_SFU 1

typedef struct {
  uint32_t top;
  uint64_t seen;
  int started;
} gv_replay;

/* ChaCha20-Poly1305 (RFC 8439). Bytes written to out, or 0 if it doesn't fit. A counter must never repeat under a key. */
size_t gv_seal(const uint8_t key[GV_KEY_BYTES], uint8_t dir, uint32_t session, uint32_t counter,
               const uint8_t *clear, size_t clear_len, const uint8_t *secret, size_t secret_len,
               uint8_t *out, size_t cap);

/* Opens buf in place. 0 when the tag holds and the counter is new; -1 for a forgery, a replay or garbage.
   On success *secret points at the decrypted payload inside buf. */
int gv_open(const uint8_t key[GV_KEY_BYTES], uint8_t dir, uint8_t *buf, size_t len, size_t clear_len,
            gv_replay *replay, uint32_t *session, uint8_t **secret, size_t *secret_len);

#endif
