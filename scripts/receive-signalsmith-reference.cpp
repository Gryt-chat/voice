#include <cstdio>
#include <vector>
#include <cstdint>
#include "signalsmith-basics/limiter.h"

int main(int argc, char **argv) {
  if (argc != 2) return 1;
  FILE *output = std::fopen(argv[1], "wb");
  if (!output) return 2;
  const int rates[] = {8000, 16000, 44100, 48000, 96000};
  for (int rate : rates) {
    constexpr int length = 8192;
    signalsmith::basics::LimiterDouble limiter;
    limiter.attackMs = 3;
    limiter.holdMs = 500.0/rate;
    limiter.releaseMs = 60;
    limiter.linkChannels = 1;
    limiter.smoothingStages = 1;
    limiter.outputLimit = std::pow(10.0, -3.0/20);
    if (!limiter.configure(rate, 512, 2)) return 3;
    std::vector<double> left(length), right(length), outL(length), outR(length);
    uint32_t seed = 91;
    for (int i = 0; i < length; ++i) {
      seed = seed * 1664525u + 1013904223u;
      float value = (float(double(seed)/4294967296.0) * 2 - 1) * 2.5f;
      left[i] = value;
      right[i] = i % 127 ? float(value * 0.3f) : 4;
    }
    const int blocks[] = {1, 127, 128, 256, 512, 64};
    int offset = 0, block = 0;
    while (offset < length) {
      int count = std::min(blocks[block++ % 6], length - offset);
      double *input[] = {left.data() + offset, right.data() + offset};
      double *out[] = {outL.data() + offset, outR.data() + offset};
      limiter.process(input, out, count);
      offset += count;
    }
    fwrite(&rate, sizeof(rate), 1, output);
    fwrite(left.data(), sizeof(double), length, output);
    fwrite(right.data(), sizeof(double), length, output);
    fwrite(outL.data(), sizeof(double), length, output);
    fwrite(outR.data(), sizeof(double), length, output);
  }
  fclose(output);
}
