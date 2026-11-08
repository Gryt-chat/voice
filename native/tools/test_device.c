/* engine + net already pass in test_net.c. This adds gv_device_start, so a
   crash here is device.c and its miniaudio backend rather than the socket
   layer. Engine on the heap: gv_engine does not fit Windows' 1MB stack. */
#include <stdio.h>
#include <stdlib.h>
#include "../core/device.h"
#include "../core/engine.h"
#include "../core/net.h"

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  unsigned period = argc > 1 ? (unsigned)atoi(argv[1]) : 960;
  gv_engine *engine = calloc(1, sizeof *engine);
  if (!engine) return 1;
  gv_effect_settings fx = {100, 0, 200, 0.8f, 0, -20, 0, 50, 0};

  printf("engine_init ... ");
  if (gv_engine_init(engine, &fx, 192000, 256000, NULL, NULL) != 0) { printf("FAILED\n"); return 1; }
  printf("ok\n");

  printf("device_start(period=%u) ... ", period);
  gv_device *d = gv_device_start(engine, NULL, period, NULL, NULL);
  if (!d) { printf("returned NULL\n"); gv_engine_destroy(engine); return 1; }
  printf("ok, mic channels=%d\n", gv_device_mic_channels(d));

  printf("device_stop ... ");
  gv_device_stop(d);
  printf("ok\n");
  gv_engine_destroy(engine);
  free(engine);
  printf("ALL OK\n");
  return 0;
}
