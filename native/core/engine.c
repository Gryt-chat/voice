#include "engine.h"

#include <math.h>
#include <string.h>

#define GV_PROBE_PING 1
#define GV_PROBE_PONG 2
#define GV_PROBE_EVERY_MS 1000
#define SAMPLE_RATE 48000
#define FRAME_MS (GV_FRAME * 1000.0 / SAMPLE_RATE)
/* Two seconds of stereo after the sides last differed, so a song doesn't flip back and forth. */
#define STEREO_HOLD_FRAMES (2 * SAMPLE_RATE / GV_FRAME)
/* Someone silent this long has left or muted: their decoder is freed until they speak again. */
#define SENDER_TIMEOUT_MS 10000
#define SPEAKING_HOLD_MS 250

int gv_engine_init(gv_engine *e, const gv_effect_settings *s, int bitrate, int stereo_bitrate, gv_send_fn send, void *user) {
  memset(e, 0, sizeof *e);
  gv_effects_init(&e->effects, SAMPLE_RATE, s);
  e->mono = gryt_encoder_create(SAMPLE_RATE, 1, GV_OPUS_RESTRICTED_LOWDELAY, bitrate, 5);
  e->stereo = gryt_encoder_create(SAMPLE_RATE, 2, GV_OPUS_RESTRICTED_LOWDELAY, stereo_bitrate, 5);
  e->send = send;
  e->user = user;
  atomic_init(&e->sending, 1);
  atomic_init(&e->output_gain, 1.0f);
  atomic_init(&e->effects_changed, false);
  atomic_init(&e->pending_bitrate, 0);
  atomic_init(&e->gains_changed, false);
  for (int i = 0; i < GV_MAX_SENDERS; i++) {
    atomic_init(&e->speaking[i], 0);
    atomic_init(&e->slot_id[i], 0);
    atomic_init(&e->level_db[i], -INFINITY);
    atomic_init(&e->buffered_ms[i], 0);
    atomic_init(&e->rtt_id[i], 0);
    atomic_init(&e->rtt_ms[i], 0);
  }
  e->rng = (uint32_t)(uintptr_t)e ^ 0x9e3779b9u;
  /* The first ping goes with the first audio rather than a second in. */
  e->probe_at = -GV_PROBE_EVERY_MS;
  atomic_init(&e->mic_db, -INFINITY);
  atomic_init(&e->mic_speaking, false);
  return e->mono && e->stereo ? 0 : -1;
}

static void drop_sender(gv_sender *s) {
  if (s->decoder) gryt_decoder_destroy(s->decoder);
  memset(s, 0, sizeof *s);
}

void gv_engine_destroy(gv_engine *e) {
  if (e->mono) gryt_encoder_destroy(e->mono);
  if (e->stereo) gryt_encoder_destroy(e->stereo);
  for (int i = 0; i < GV_MAX_SENDERS; i++) drop_sender(&e->senders[i]);
}

void gv_engine_set_sending(gv_engine *e, int on) { atomic_store(&e->sending, on); }

int gv_engine_levels(gv_engine *e, uint32_t *ids, float *db, int max, float *mic_db, int *mic_speaking) {
  int n = 0;
  for (int i = 0; i < GV_MAX_SENDERS && n < max; i++) {
    uint32_t id = atomic_load(&e->slot_id[i]);
    if (!id) continue;
    ids[n] = id;
    db[n++] = atomic_load(&e->level_db[i]);
  }
  *mic_db = atomic_load(&e->mic_db);
  *mic_speaking = atomic_load(&e->mic_speaking);
  return n;
}

int gv_engine_buffered(gv_engine *e, uint32_t *ids, float *ms, int max) {
  int n = 0;
  for (int i = 0; i < GV_MAX_SENDERS && n < max; i++) {
    uint32_t id = atomic_load(&e->slot_id[i]);
    if (!id) continue;
    ids[n] = id;
    ms[n++] = atomic_load(&e->buffered_ms[i]);
  }
  return n;
}

int gv_engine_rtt(gv_engine *e, uint32_t *ids, float *ms, int max) {
  int n = 0;
  for (int i = 0; i < GV_MAX_SENDERS && n < max; i++) {
    uint32_t id = atomic_load(&e->rtt_id[i]);
    if (!id) continue;
    ids[n] = id;
    ms[n++] = atomic_load(&e->rtt_ms[i]);
  }
  return n;
}

/* Under the last audio packet's seq and timestamp, so a client from before drops it rather than decoding it. */
static void send_probe(gv_engine *e, uint8_t kind, uint32_t nonce, double hold_ms) {
  uint8_t body[7] = {kind, (uint8_t)(nonce >> 24), (uint8_t)(nonce >> 16), (uint8_t)(nonce >> 8), (uint8_t)nonce, 0, 0};
  double tenths = hold_ms * 10 < 0 ? 0 : hold_ms * 10 > 0xffff ? 0xffff : hold_ms * 10;
  body[5] = (uint8_t)((unsigned)lround(tenths) >> 8);
  body[6] = (uint8_t)lround(tenths);
  uint8_t packet[GV_HEADER_BYTES + sizeof body];
  gv_packet p = {GV_FLAG_PROBE, (uint16_t)(e->seq - 1), e->timestamp, body, kind == GV_PROBE_PING ? 5u : 7u};
  size_t n = gv_write_packet(&p, packet, sizeof packet);
  if (n && e->send) e->send(e->user, packet, n);
}

/* Pongs go out muted too, so someone listening still has a round trip; pings only while sending, once a second. */
static void probe(gv_engine *e) {
  for (int i = 0; i < e->n_pongs; i++) send_probe(e, GV_PROBE_PONG, e->pong_nonce[i], e->now_ms - e->pong_at[i]);
  e->n_pongs = 0;
  if (!atomic_load(&e->sending) || e->now_ms - e->probe_at < GV_PROBE_EVERY_MS) return;
  e->probe_at = e->now_ms;
  e->rng ^= e->rng << 13, e->rng ^= e->rng >> 17, e->rng ^= e->rng << 5;
  int at = e->next_ping++ % GV_PINGS;
  e->ping_nonce[at] = e->rng;
  e->ping_at[at] = e->now_ms;
  send_probe(e, GV_PROBE_PING, e->rng, 0);
}

static void heard_probe(gv_engine *e, uint32_t sender, const gv_packet *p) {
  if (p->opus_len < 5) return;
  const uint8_t *b = p->opus;
  uint32_t nonce = (uint32_t)b[1] << 24 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 8 | b[4];
  if (b[0] == GV_PROBE_PING && p->opus_len == 5 && e->n_pongs < GV_PINGS) {
    e->pong_nonce[e->n_pongs] = nonce;
    e->pong_at[e->n_pongs++] = e->now_ms;
    return;
  }
  if (b[0] != GV_PROBE_PONG || p->opus_len != 7) return;
  for (int i = 0; i < GV_PINGS; i++) {
    if (e->ping_nonce[i] != nonce || !nonce) continue;
    float rtt = (float)(e->now_ms - e->ping_at[i] - ((b[5] << 8) | b[6]) / 10.0);
    int slot = -1;
    for (int k = 0; k < GV_MAX_SENDERS && slot < 0; k++)
      if (atomic_load(&e->rtt_id[k]) == sender) slot = k;
    for (int k = 0; k < GV_MAX_SENDERS && slot < 0; k++)
      if (!atomic_load(&e->rtt_id[k])) slot = k;
    if (slot < 0) return;
    atomic_store(&e->rtt_ms[slot], rtt);
    atomic_store(&e->rtt_id[slot], sender);
    return;
  }
}

int gv_engine_speaking(gv_engine *e, uint32_t *ids, int max) {
  int n = 0;
  for (int i = 0; i < GV_MAX_SENDERS && n < max; i++) {
    uint32_t id = atomic_load(&e->speaking[i]);
    if (id) ids[n++] = id;
  }
  return n;
}

void gv_engine_set_output_gain(gv_engine *e, float gain) { atomic_store(&e->output_gain, gain); }

/* shortcut: two changes within one audio block can tear; settings move by hand, so that's a few ms of odd gate. */
void gv_engine_set_gains(gv_engine *e, const uint32_t *ids, const float *gains, int n) {
  if (n > GV_MAX_SENDERS) n = GV_MAX_SENDERS;
  for (int i = 0; i < n; i++) {
    e->pending_gain_ids[i] = ids[i];
    e->pending_gains[i] = gains[i];
  }
  e->pending_n_gains = n;
  atomic_store(&e->gains_changed, true);
}

static float gain_for(const gv_engine *e, uint32_t id) {
  for (int i = 0; i < e->n_gains; i++)
    if (e->gain_ids[i] == id) return e->gains[i];
  return 1.0f;
}

void gv_engine_set_effects(gv_engine *e, const gv_effect_settings *s) {
  e->pending_effects = *s;
  atomic_store(&e->effects_changed, true);
}

void gv_engine_set_bitrate(gv_engine *e, int bitrate) { atomic_store(&e->pending_bitrate, bitrate); }

void gv_engine_capture(gv_engine *e, const float *in, size_t frames, int channels) {
  float left[512], right[512];
  if (atomic_exchange(&e->effects_changed, false)) e->effects.s = e->pending_effects;
  int bitrate = atomic_exchange(&e->pending_bitrate, 0);
  if (bitrate > 0) {
    opus_encoder_ctl(e->mono, OPUS_SET_BITRATE(bitrate));
    opus_encoder_ctl(e->stereo, OPUS_SET_BITRATE(bitrate * 4 / 3));
  }
  probe(e);
  /* In chunks the effects take as one block, as the worklet gets 128 frames at a time. */
  for (size_t at = 0; at < frames; at += 128) {
    size_t n = frames - at < 128 ? frames - at : 128;
    int differ = 0;
    for (size_t i = 0; i < n; i++) {
      left[i] = in[(at + i) * channels];
      right[i] = channels == 2 ? in[(at + i) * 2 + 1] : left[i];
      if (fabsf(left[i] - right[i]) > 1e-4f) differ = 1;
    }
    if (differ) e->stereo_for = STEREO_HOLD_FRAMES;
    gv_effects_process(&e->effects, left, channels == 2 ? right : NULL, n);
    int on = atomic_load(&e->sending);
    double sum = 0;
    for (size_t i = 0; i < n; i++) sum += left[i] * left[i];
    atomic_store(&e->mic_db, on && sum > 0 ? (float)(10 * log10(sum / (double)n)) : -INFINITY);
    atomic_store(&e->mic_speaking, on && e->effects.gate_open);
    for (size_t i = 0; i < n; i++) {
      float r = channels == 2 ? right[i] : left[i];
      e->stereo_frame[2 * e->filled] = left[i];
      e->stereo_frame[2 * e->filled + 1] = r;
      e->frame[e->filled++] = (left[i] + r) / 2;
      if (e->filled < GV_FRAME) continue;
      e->filled = 0;
      int stereo = e->stereo_for > 0;
      if (e->stereo_for > 0) e->stereo_for--;
      /* The timestamp moves on while muted, so the far side's clock stays right across a pause. */
      if (atomic_load(&e->sending) && e->send) {
        uint8_t opus[GV_MAX_OPUS_BYTES], packet[GV_HEADER_BYTES + GV_MAX_OPUS_BYTES];
        int len = stereo ? gryt_encode(e->stereo, e->stereo_frame, GV_FRAME, opus, sizeof opus)
                         : gryt_encode(e->mono, e->frame, GV_FRAME, opus, sizeof opus);
        if (len > 0) {
          gv_packet p = {e->effects.gate_open ? GV_FLAG_SPEAKING : 0, e->seq, e->timestamp, opus, (size_t)len};
          size_t n_bytes = gv_write_packet(&p, packet, sizeof packet);
          if (n_bytes) e->send(e->user, packet, n_bytes);
          e->seq++;
        }
      }
      e->timestamp += GV_FRAME;
    }
  }
}

void gv_engine_receive(gv_engine *e, const uint8_t *bytes, size_t len) {
  uint32_t id;
  gv_packet p;
  if (gv_read_forwarded(bytes, len, &id, &p) != 0) return;
  if (p.flags & GV_FLAG_PROBE) {
    heard_probe(e, id, &p);
    return;
  }
  gv_sender *s = NULL, *free_slot = NULL;
  for (int i = 0; i < GV_MAX_SENDERS; i++) {
    if (e->senders[i].used && e->senders[i].id == id) s = &e->senders[i];
    else if (!e->senders[i].used && !free_slot) free_slot = &e->senders[i];
  }
  if (!s) {
    /* More talkers than slots: the newest waits until someone goes quiet. */
    if (!free_slot) return;
    s = free_slot;
    s->decoder = gryt_decoder_create(SAMPLE_RATE, 2);
    if (!s->decoder) return;
    s->used = 1;
    s->id = id;
    s->last_speaking_ms = -1e9;
    gv_jitter_init(&s->jitter, FRAME_MS, 5, 60);
  }
  s->last_heard_ms = e->now_ms;
  gv_jitter_push(&s->jitter, &p, e->now_ms);
}

/* One frame from a sender's jitter buffer into its pending stereo samples. */
static void pull_frame(gv_sender *s, double now_ms) {
  gv_packet p;
  float *out = s->pending + s->pending_frames * 2;
  gv_pull_kind k = gv_jitter_pull(&s->jitter, &p);
  int got = 0;
  if (k == GV_PULL_PACKET) {
    got = gryt_decode(s->decoder, p.opus, (int)p.opus_len, out, GV_FRAME);
    if (p.flags & GV_FLAG_SPEAKING) s->last_speaking_ms = now_ms;
  }
  else if (k == GV_PULL_LOST) got = gryt_decode(s->decoder, NULL, 0, out, GV_FRAME);
  if (got != GV_FRAME) memset(out, 0, GV_FRAME * 2 * sizeof(float));
  s->pending_frames += GV_FRAME;
}

int gv_engine_queue(gv_engine *e, const uint8_t *bytes, size_t len) {
  unsigned head = atomic_load_explicit(&e->queue_head, memory_order_relaxed);
  unsigned tail = atomic_load_explicit(&e->queue_tail, memory_order_acquire);
  if (len > GV_QUEUE_BYTES || head - tail >= GV_QUEUE_SLOTS) return -1;
  memcpy(e->queue[head % GV_QUEUE_SLOTS], bytes, len);
  e->queue_len[head % GV_QUEUE_SLOTS] = (uint16_t)len;
  atomic_store_explicit(&e->queue_head, head + 1, memory_order_release);
  return 0;
}

void gv_engine_render(gv_engine *e, float *out, size_t frames) {
  unsigned head = atomic_load_explicit(&e->queue_head, memory_order_acquire);
  for (unsigned t = atomic_load_explicit(&e->queue_tail, memory_order_relaxed); t != head; t++) {
    gv_engine_receive(e, e->queue[t % GV_QUEUE_SLOTS], e->queue_len[t % GV_QUEUE_SLOTS]);
    atomic_store_explicit(&e->queue_tail, t + 1, memory_order_release);
  }
  memset(out, 0, frames * 2 * sizeof(float));
  /* shortcut: a change landing mid-copy can mix two lists for one block; volumes move by hand, so that's inaudible. */
  if (atomic_exchange(&e->gains_changed, false)) {
    e->n_gains = e->pending_n_gains;
    memcpy(e->gain_ids, e->pending_gain_ids, sizeof e->gain_ids);
    memcpy(e->gains, e->pending_gains, sizeof e->gains);
  }
  for (int i = 0; i < GV_MAX_SENDERS; i++) {
    gv_sender *s = &e->senders[i];
    if (!s->used || e->now_ms - s->last_heard_ms > SENDER_TIMEOUT_MS) {
      if (s->used) drop_sender(s);
      atomic_store(&e->speaking[i], 0);
      atomic_store(&e->slot_id[i], 0);
      continue;
    }
    double sum = 0;
    float gain = gain_for(e, s->id);
    for (size_t done = 0; done < frames;) {
      if (s->pending_frames == 0) pull_frame(s, e->now_ms);
      size_t take = frames - done < s->pending_frames ? frames - done : s->pending_frames;
      for (size_t k = 0; k < take * 2; k++) {
        out[done * 2 + k] += s->pending[k] * gain;
        sum += s->pending[k] * s->pending[k];
      }
      memmove(s->pending, s->pending + take * 2, (s->pending_frames - take) * 2 * sizeof(float));
      s->pending_frames -= take;
      done += take;
    }
    /* A muted sender stops sending, so the ring goes out this long after its last speaking packet. */
    atomic_store(&e->speaking[i], e->now_ms - s->last_speaking_ms < SPEAKING_HOLD_MS ? s->id : 0);
    atomic_store(&e->level_db[i], sum > 0 ? (float)(10 * log10(sum / (double)(frames * 2))) : -INFINITY);
    atomic_store(&e->buffered_ms[i], (float)(gv_jitter_depth_ms(&s->jitter) + s->pending_frames * 1000.0 / SAMPLE_RATE));
    atomic_store(&e->slot_id[i], s->id);
  }
  float gain = atomic_load(&e->output_gain);
  if (gain != 1.0f)
    for (size_t k = 0; k < frames * 2; k++) out[k] *= gain;
  e->now_ms += frames * 1000.0 / SAMPLE_RATE;
}
