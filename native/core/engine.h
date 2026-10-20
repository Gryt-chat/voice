/* The native voice engine (GRYT-1822): what the transport worklets do (src/transport/processors.ts), in C.
   Audio in and out and the network stay with the host; the engine is called from the audio callback. */
#ifndef GRYT_VOICE_ENGINE_H
#define GRYT_VOICE_ENGINE_H

#include <stddef.h>
#include <stdint.h>

#include "codec.h"
#include "effects.h"
#include "jitter.h"

#define GV_FRAME 120
#define GV_MAX_SENDERS 16

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
  int stereo_for, sending;
  uint16_t seq;
  uint32_t timestamp;
  gv_send_fn send;
  void *user;
  double now_ms;
  gv_sender senders[GV_MAX_SENDERS];
} gv_engine;

/* 0 on success. Bitrates in bits per second: Gryt sends 192000 mono, 256000 stereo. */
int gv_engine_init(gv_engine *e, const gv_effect_settings *s, int bitrate, int stereo_bitrate, gv_send_fn send, void *user);
void gv_engine_destroy(gv_engine *e);
/* Mic samples, interleaved when channels is 2. */
void gv_engine_capture(gv_engine *e, const float *in, size_t frames, int channels);
/* A packet from the SFU: the sender's u32 id, then the packet as it was sent. */
void gv_engine_receive(gv_engine *e, const uint8_t *bytes, size_t len);
/* Everyone mixed, interleaved stereo. Also moves the engine's clock on. */
void gv_engine_render(gv_engine *e, float *out, size_t frames);
void gv_engine_set_sending(gv_engine *e, int on);

#endif
