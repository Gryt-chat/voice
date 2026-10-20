/* Native libopus in and out for scripts/check-native-opus.ts, which compares it with the WASM build.
   encode <channels> <bitrate> <frame> <in.f32> <out.pkts> | decode <channels> <frame> <in.pkts> <out.f32> */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../core/codec.h"

int main(int argc, char **argv) {
  if (argc == 7 && !strcmp(argv[1], "encode")) {
    int ch = atoi(argv[2]), frame = atoi(argv[4]);
    OpusEncoder *e = gryt_encoder_create(48000, ch, GV_OPUS_RESTRICTED_LOWDELAY, atoi(argv[3]), 5);
    FILE *in = fopen(argv[5], "rb"), *out = fopen(argv[6], "wb");
    if (!e || !in || !out) return 3;
    float pcm[960 * 2];
    unsigned char pkt[1500];
    while (fread(pcm, sizeof(float), (size_t)(frame * ch), in) == (size_t)(frame * ch)) {
      int n = gryt_encode(e, pcm, frame, pkt, sizeof pkt);
      if (n < 0) return 4;
      unsigned char len[2] = {(unsigned char)(n >> 8), (unsigned char)n};
      fwrite(len, 1, 2, out);
      fwrite(pkt, 1, (size_t)n, out);
    }
    fclose(in);
    fclose(out);
    gryt_encoder_destroy(e);
  } else if (argc == 6 && !strcmp(argv[1], "decode")) {
    int ch = atoi(argv[2]), frame = atoi(argv[3]);
    OpusDecoder *d = gryt_decoder_create(48000, ch);
    FILE *in = fopen(argv[4], "rb"), *out = fopen(argv[5], "wb");
    if (!d || !in || !out) return 3;
    unsigned char len[2], pkt[1500];
    float pcm[960 * 2];
    while (fread(len, 1, 2, in) == 2) {
      int n = len[0] << 8 | len[1];
      if (n > (int)sizeof pkt || fread(pkt, 1, (size_t)n, in) != (size_t)n) return 4;
      int got = gryt_decode(d, pkt, n, pcm, frame);
      if (got < 0) return 5;
      fwrite(pcm, sizeof(float), (size_t)(got * ch), out);
    }
    fclose(in);
    fclose(out);
    gryt_decoder_destroy(d);
  } else return 2;
  return 0;
}
