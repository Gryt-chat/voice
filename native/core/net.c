#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE
#endif
#include "net.h"

#include <netdb.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include "seal.h"

/* shortcut: POSIX sockets only; Windows needs Winsock here before the desktop app can use the native path. */
#define MAX_ADDRS 8

struct gv_net {
  gv_engine *engine;
  int fd;
  struct sockaddr_storage addrs[MAX_ADDRS];
  socklen_t addr_len[MAX_ADDRS];
  int n_addrs;
  atomic_int chosen, stop;
  uint32_t session, counter;
  uint8_t key[GV_KEY_BYTES];
  gv_replay replay;
  pthread_t thread;
};

static int resolve(const char *addr, struct sockaddr_storage *out, socklen_t *len) {
  char host[256];
  const char *colon = strrchr(addr, ':');
  if (!colon || (size_t)(colon - addr) >= sizeof host) return -1;
  size_t hl = (size_t)(colon - addr);
  memcpy(host, addr, hl);
  host[hl] = 0;
  char *h = host;
  if (h[0] == '[' && hl > 2 && h[hl - 1] == ']') {
    h[hl - 1] = 0;
    h++;
  }
  struct addrinfo hints = {.ai_family = AF_INET, .ai_socktype = SOCK_DGRAM}, *res;
  if (getaddrinfo(h, colon + 1, &hints, &res) != 0) return -1;
  memcpy(out, res->ai_addr, res->ai_addrlen);
  *len = res->ai_addrlen;
  freeaddrinfo(res);
  return 0;
}

static int same(const struct sockaddr_storage *a, const struct sockaddr_storage *b, socklen_t len) {
  return memcmp(a, b, len) == 0;
}

static void send_packet(void *user, const uint8_t *packet, size_t len) {
  gv_net *n = user;
  uint8_t out[GV_SEAL_PREFIX + GV_QUEUE_BYTES + GV_TAG_BYTES];
  size_t sealed = gv_seal(n->key, GV_TO_SFU, n->session, ++n->counter, packet, GV_HEADER_BYTES,
                          packet + GV_HEADER_BYTES, len - GV_HEADER_BYTES, out, sizeof out);
  if (!sealed) return;
  int chosen = atomic_load(&n->chosen);
  /* Until an address answers, every offered one gets the packet, as the browser races WebTransport (GRYT-1821). */
  for (int i = 0; i < n->n_addrs; i++)
    if (chosen < 0 || chosen == i) sendto(n->fd, out, sealed, 0, (struct sockaddr *)&n->addrs[i], n->addr_len[i]);
}

static void *receive_loop(void *arg) {
  gv_net *n = arg;
  uint8_t buf[2048];
  while (!atomic_load(&n->stop)) {
    struct sockaddr_storage from;
    socklen_t from_len = sizeof from;
    ssize_t got = recvfrom(n->fd, buf, sizeof buf, 0, (struct sockaddr *)&from, &from_len);
    if (got <= 0) continue;
    int which = -1;
    for (int i = 0; i < n->n_addrs; i++)
      if (from_len == n->addr_len[i] && same(&from, &n->addrs[i], from_len)) which = i;
    if (which < 0) continue;
    uint32_t session;
    uint8_t *secret;
    size_t secret_len;
    /* Clear part from the SFU: its sender id, then the packet header. */
    if (gv_open(n->key, GV_FROM_SFU, buf, (size_t)got, 4 + GV_HEADER_BYTES, &n->replay, &session, &secret, &secret_len) != 0) continue;
    if (session != n->session) continue;
    int none = -1;
    atomic_compare_exchange_strong(&n->chosen, &none, which);
    gv_engine_queue(n->engine, buf + GV_SEAL_PREFIX, 4 + GV_HEADER_BYTES + secret_len);
  }
  return NULL;
}

gv_net *gv_net_open(gv_engine *engine, const char *const *addrs, int n_addrs, uint32_t session, const uint8_t key[32]) {
  gv_net *n = calloc(1, sizeof *n);
  if (!n) return NULL;
  n->engine = engine;
  n->session = session;
  memcpy(n->key, key, GV_KEY_BYTES);
  atomic_init(&n->chosen, -1);
  atomic_init(&n->stop, 0);
  for (int i = 0; i < n_addrs && n->n_addrs < MAX_ADDRS; i++)
    if (resolve(addrs[i], &n->addrs[n->n_addrs], &n->addr_len[n->n_addrs]) == 0) n->n_addrs++;
  /* One socket for both families: an IPv6 socket that also takes IPv4 would differ per OS, so v4 only for now. */
  n->fd = socket(AF_INET, SOCK_DGRAM, 0);
  struct timeval tv = {0, 200000};
  if (n->n_addrs == 0 || n->fd < 0 || setsockopt(n->fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv) != 0 ||
      pthread_create(&n->thread, NULL, receive_loop, n) != 0) {
    if (n->fd >= 0) close(n->fd);
    free(n);
    return NULL;
  }
  engine->send = send_packet;
  engine->user = n;
  return n;
}

void gv_net_close(gv_net *n) {
  if (!n) return;
  atomic_store(&n->stop, 1);
  pthread_join(n->thread, NULL);
  close(n->fd);
  n->engine->send = NULL;
  free(n);
}

int gv_net_chosen(const gv_net *n) { return atomic_load(&((gv_net *)n)->chosen); }
