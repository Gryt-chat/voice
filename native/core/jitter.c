#include "jitter.h"

#include <stdlib.h>
#include <string.h>

#define MAX_CONCEALED 4
#define DRAIN_EXCESS_FRAMES 2
#define DRAIN_AFTER_PULLS 20

void gv_jitter_init(gv_jitter *j, double frame_ms, double min_ms, double max_ms) {
  memset(j, 0, sizeof *j);
  j->frame_ms = frame_ms;
  j->min_ms = min_ms;
  j->max_ms = max_ms;
}

static gv_slot *slot(gv_jitter *j, uint16_t seq) {
  gv_slot *s = &j->slots[seq % GV_JITTER_SLOTS];
  return s->used && s->seq == seq ? s : NULL;
}

static int cmp(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return (x > y) - (x < y);
}

double gv_jitter_target_ms(const gv_jitter *j) {
  double floor_ms = j->min_ms > 2 * j->frame_ms ? j->min_ms : 2 * j->frame_ms;
  if (j->n_transits < 10) return floor_ms;
  double sorted[GV_JITTER_WINDOW];
  memcpy(sorted, j->transits, j->n_transits * sizeof(double));
  qsort(sorted, j->n_transits, sizeof(double), cmp);
  double spread = sorted[(size_t)(j->n_transits * 0.95)] - sorted[0] + j->frame_ms;
  if (spread < j->min_ms) spread = j->min_ms;
  return spread > j->max_ms ? j->max_ms : spread;
}

double gv_jitter_depth_ms(const gv_jitter *j) {
  if (!j->has_next || j->queued == 0) return 0;
  int newest = 0;
  for (size_t i = 0; i < GV_JITTER_SLOTS; i++) {
    if (!j->slots[i].used) continue;
    int d = gv_seq_delta(j->next, j->slots[i].seq) + 1;
    if (d > newest) newest = d;
  }
  return newest * j->frame_ms;
}

void gv_jitter_push(gv_jitter *j, const gv_packet *p, double arrival_ms) {
  /* Transit up to a constant: arrival against when the sender says it captured the frame. */
  double transit = arrival_ms - p->timestamp / 48.0;
  if (j->n_transits < GV_JITTER_WINDOW) {
    j->transits[j->n_transits++] = transit;
  } else {
    j->transits[j->transit_head] = transit;
    j->transit_head = (j->transit_head + 1) % GV_JITTER_WINDOW;
  }

  if (!j->has_next) {
    j->has_next = 1;
    j->next = p->seq;
  }
  if (gv_seq_delta(j->next, p->seq) < 0) {
    j->stats.late++;
    return;
  }
  if (slot(j, p->seq)) {
    j->stats.duplicate++;
    return;
  }
  gv_slot *s = &j->slots[p->seq % GV_JITTER_SLOTS];
  /* A slot still holding a packet 512 ahead or behind is as full as the queue gets. */
  if (j->queued >= GV_JITTER_MAX_QUEUED || s->used) return;
  s->used = 1;
  s->seq = p->seq;
  s->flags = p->flags;
  s->timestamp = p->timestamp;
  s->opus_len = (uint16_t)p->opus_len;
  memcpy(s->opus, p->opus, p->opus_len);
  j->queued++;
}

static void take(gv_jitter *j, gv_slot *s) {
  s->used = 0;
  j->queued--;
}

gv_pull_kind gv_jitter_pull(gv_jitter *j, gv_packet *out) {
  if (!j->has_next) return GV_PULL_SILENCE;
  double target = gv_jitter_target_ms(j);
  if (!j->playing) {
    if (gv_jitter_depth_ms(j) < target) return GV_PULL_SILENCE;
    j->playing = 1;
  }

  /* Too much queued for too long: skip a frame, so delay comes back down after a burst. */
  double excess = gv_jitter_depth_ms(j) - target;
  j->over = excess > DRAIN_EXCESS_FRAMES * j->frame_ms ? j->over + 1 : 0;
  if (j->over >= DRAIN_AFTER_PULLS) {
    gv_slot *s = slot(j, j->next);
    if (s) take(j, s);
    j->next++;
    j->stats.drained++;
    j->over = 0;
  }

  gv_slot *s = slot(j, j->next);
  if (s) {
    take(j, s);
    j->next++;
    j->concealed = 0;
    out->flags = s->flags;
    out->seq = s->seq;
    out->timestamp = s->timestamp;
    out->opus = s->opus;
    out->opus_len = s->opus_len;
    return GV_PULL_PACKET;
  }

  if (j->queued > 0 && j->concealed < MAX_CONCEALED) {
    j->next++;
    j->concealed++;
    j->stats.lost++;
    return GV_PULL_LOST;
  }

  /* Nothing to play: go quiet and refill. A gap too long to conceal is given up on, so skip to the oldest. */
  j->playing = 0;
  j->stats.rebuffered++;
  j->concealed = 0;
  if (j->queued > 0) {
    int best = 1 << 30;
    uint16_t oldest = j->next;
    for (size_t i = 0; i < GV_JITTER_SLOTS; i++) {
      if (!j->slots[i].used) continue;
      int d = gv_seq_delta(j->next, j->slots[i].seq);
      if (d < best) {
        best = d;
        oldest = j->slots[i].seq;
      }
    }
    j->next = oldest;
  }
  return GV_PULL_SILENCE;
}
