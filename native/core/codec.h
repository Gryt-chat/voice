/* libopus through the same shim the WASM build exports (codec/opus/shim.c), so the browser and the native
   engine make the same calls. Float PCM, interleaved when stereo. GRYT-1822. */
#ifndef GRYT_VOICE_CODEC_H
#define GRYT_VOICE_CODEC_H

#include <opus.h>

/* CELT only: the lowest delay Opus has, and the only mode that takes 2.5 ms frames. */
#define GV_OPUS_RESTRICTED_LOWDELAY OPUS_APPLICATION_RESTRICTED_LOWDELAY

OpusEncoder *gryt_encoder_create(int rate, int channels, int application, int bitrate, int complexity);
int gryt_encode(OpusEncoder *e, const float *pcm, int frame, unsigned char *out, int max);
void gryt_encoder_destroy(OpusEncoder *e);
OpusDecoder *gryt_decoder_create(int rate, int channels);
/* len 0 asks for packet-loss concealment: a frame that never arrived. */
int gryt_decode(OpusDecoder *d, const unsigned char *data, int len, float *pcm, int frame);
void gryt_decoder_destroy(OpusDecoder *d);

#endif
