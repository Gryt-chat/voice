/* net and device both pass on their own. This drives gv_voice_start/stop,
   so a crash here is voice.c and a crash only in gryt-voice is voice_helper.c. */
#include <stdio.h>
#include <stdlib.h>
#include "../core/voice.h"

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  unsigned period = argc > 1 ? (unsigned)atoi(argv[1]) : 960;
  const char *addrs[] = {"127.0.0.1:5005"};
  uint8_t key[32] = {0};
  gv_effect_settings fx = {100, 0, 200, 0.8f, 0, -20, 0, 50, 0};

  printf("voice_start(period=%u) ... ", period);
  gv_voice *v = gv_voice_start(addrs, 1, 42, key, &fx, period);
  if (!v) { printf("returned NULL\n"); return 1; }
  printf("ok, route=%d\n", gv_voice_route(v));

  uint32_t ids[64];
  float db[64], mic;
  int mic_speaking;
  printf("voice_levels ... ");
  int n = gv_voice_levels(v, ids, db, 64, &mic, &mic_speaking);
  printf("ok, %d senders, mic %.1f\n", n, mic);

  printf("voice_stop ... ");
  gv_voice_stop(v);
  printf("ok\nALL OK\n");
  return 0;
}
