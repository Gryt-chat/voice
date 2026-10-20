/* The libopus calls the voice engine makes, with fixed signatures: opus_*_ctl is variadic,
   which a WASM export can't carry. Float PCM in and out, as an AudioWorklet has it. */
#include <opus.h>

OpusEncoder *gryt_encoder_create(int rate, int channels, int application, int bitrate, int complexity) {
  int err = 0;
  OpusEncoder *e = opus_encoder_create(rate, channels, application, &err);
  if (err != OPUS_OK) return 0;
  opus_encoder_ctl(e, OPUS_SET_BITRATE(bitrate));
  opus_encoder_ctl(e, OPUS_SET_COMPLEXITY(complexity));
  return e;
}

int gryt_encode(OpusEncoder *e, const float *pcm, int frame, unsigned char *out, int max) {
  return opus_encode_float(e, pcm, frame, out, max);
}

void gryt_encoder_destroy(OpusEncoder *e) { opus_encoder_destroy(e); }

OpusDecoder *gryt_decoder_create(int rate, int channels) {
  int err = 0;
  OpusDecoder *d = opus_decoder_create(rate, channels, &err);
  return err == OPUS_OK ? d : 0;
}

/* len 0 asks for packet-loss concealment: a frame that never arrived. */
int gryt_decode(OpusDecoder *d, const unsigned char *data, int len, float *pcm, int frame) {
  return opus_decode_float(d, len ? data : 0, len, pcm, frame, 0);
}

void gryt_decoder_destroy(OpusDecoder *d) { opus_decoder_destroy(d); }
