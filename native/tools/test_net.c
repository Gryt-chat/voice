/* Exercises only the socket layer: engine, net open, net close. No audio
   device, so a hang here is the Winsock port and a hang elsewhere is not.
   The engine is heap allocated because gv_engine does not fit Windows'
   1MB default stack, where Linux gives 8MB. gv_voice callocs it too. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../core/engine.h"
#include "../core/net.h"

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  gv_engine *engine = calloc(1, sizeof *engine);
  if (!engine) return 1;
  gv_effect_settings fx = {100, 0, 200, 0.8f, 0, -20, 0, 50, 0};
  printf("engine_init ... ");
  if (gv_engine_init(engine, &fx, 192000, 256000, NULL, NULL) != 0) { printf("FAILED\n"); return 1; }
  printf("ok\n");

  const char *addrs[] = {"127.0.0.1:5005"};
  uint8_t key[32] = {0};
  printf("net_open ... ");
  gv_net *n = gv_net_open(engine, addrs, 1, 42, key);
  if (!n) { printf("FAILED\n"); gv_engine_destroy(engine); return 1; }
  printf("ok, chosen=%d\n", gv_net_chosen(n));

  printf("net_close ... ");
  gv_net_close(n);
  printf("ok\n");
  gv_engine_destroy(engine);
  free(engine);
  printf("ALL OK\n");
  return 0;
}
