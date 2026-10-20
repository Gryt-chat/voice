/* One sender's jitter buffer, the same rules as src/transport/jitterBuffer.ts: sized from measured
   jitter, and it drains back down after a burst. GRYT-1822. */
#ifndef GRYT_VOICE_JITTER_H
#define GRYT_VOICE_JITTER_H

#include <stddef.h>
#include <stdint.h>

#include "packet.h"

#define GV_JITTER_WINDOW 400
#define GV_JITTER_SLOTS 512
#define GV_JITTER_MAX_QUEUED 400

typedef enum { GV_PULL_SILENCE, GV_PULL_PACKET, GV_PULL_LOST } gv_pull_kind;

typedef struct {
  uint8_t used;
  uint16_t seq;
  uint8_t flags;
  uint32_t timestamp;
  uint16_t opus_len;
  uint8_t opus[GV_MAX_OPUS_BYTES];
} gv_slot;

typedef struct {
  double frame_ms, min_ms, max_ms;
  gv_slot slots[GV_JITTER_SLOTS];
  size_t queued;
  int has_next, playing;
  uint16_t next;
  int concealed, over;
  double transits[GV_JITTER_WINDOW];
  size_t n_transits, transit_head;
  struct { uint32_t late, duplicate, lost, drained, rebuffered; } stats;
} gv_jitter;

void gv_jitter_init(gv_jitter *j, double frame_ms, double min_ms, double max_ms);
void gv_jitter_push(gv_jitter *j, const gv_packet *p, double arrival_ms);
/* Called once a frame. On GV_PULL_PACKET, *out points at a copy that stays valid until the next push. */
gv_pull_kind gv_jitter_pull(gv_jitter *j, gv_packet *out);
double gv_jitter_target_ms(const gv_jitter *j);
double gv_jitter_depth_ms(const gv_jitter *j);

#endif
