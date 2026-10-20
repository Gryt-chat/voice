/* The native voice engine (GRYT-1822): what the transport worklets do (src/transport/processors.ts), in C.
   Audio in and out and the network stay with the host; the engine is called from the audio callback. */
#ifndef GRYT_VOICE_ENGINE_H
#define GRYT_VOICE_ENGINE_H

#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "codec.h"
#include "effects.h"
#include "jitter.h"

#define GV_FRAME 120
#define GV_MAX_SENDERS 16
/* Packets the network thread can hand over between two audio callbacks: a full second at 16 talkers would need 6400. */
#define GV_QUEUE_SLOTS 512
#define GV_QUEUE_BYTES (4 + GV_HEADER_BYTES + GV_MAX_OPUS_BYTES)

/* One packet, ready for the host to send to the SFU. Called on the audio thread, so it must not block. */
typedef void (*gv_send_fn)(void *user, const uint8_t *packet, size_t len);

typedef struct {
  uint32_t id;
  int used;
  double last_heard_ms;
  gv_jitter jitter;
  OpusDecoder *decoder;
  float pending[GV_FRAME * 2 * 2];
  size_t pending_frames;
} gv_sender;

typedef struct {
  gv_effects effects;
  OpusEncoder *mono, *stereo;
  float frame[GV_FRAME], stereo_frame[GV_FRAME * 2];
  size_t filled;
  int stereo_for;
  /* Set from the host's thread, read on the audio thread. */
  atomic_int sending;
  _Atomic float output_gain;
  gv_effect_settings pending_effects;
  atomic_bool effects_changed;
  uint16_t seq;
  uint32_t timestamp;
  gv_send_fn send;
  void *user;
  double now_ms;
  gv_sender senders[GV_MAX_SENDERS];
  /* One producer (the network thread), one consumer (render, on the audio thread). */
  uint8_t queue[GV_QUEUE_SLOTS][GV_QUEUE_BYTES];
  uint16_t queue_len[GV_QUEUE_SLOTS];
  atomic_uint queue_head, queue_tail;
} gv_engine;

/* 0 on success. Bitrates in bits per second: Gryt sends 192000 mono, 256000 stereo. */
int gv_engine_init(gv_engine *e, const gv_effect_settings *s, int bitrate, int stereo_bitrate, gv_send_fn send, void *user);
void gv_engine_destroy(gv_engine *e);
/* Mic samples, interleaved when channels is 2. */
void gv_engine_capture(gv_engine *e, const float *in, size_t frames, int channels);
/* A packet from the SFU: the sender's u32 id, then the packet as it was sent. */
void gv_engine_receive(gv_engine *e, const uint8_t *bytes, size_t len);
/* gv_engine_receive for another thread: the packet waits for the next render. -1 when the queue is full. */
int gv_engine_queue(gv_engine *e, const uint8_t *bytes, size_t len);
/* Everyone mixed, interleaved stereo. Also moves the engine's clock on. */
void gv_engine_render(gv_engine *e, float *out, size_t frames);
void gv_engine_set_sending(gv_engine *e, int on);
/* What everyone is heard at: 0 when deafened, 1 as sent. */
void gv_engine_set_output_gain(gv_engine *e, float gain);
/* Taken at the next capture, so the audio thread never reads half a change. */
void gv_engine_set_effects(gv_engine *e, const gv_effect_settings *s);

#endif
