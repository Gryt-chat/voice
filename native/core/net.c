#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE
#endif
#include "net.h"

#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
/* winsock2.h before windows.h, or windows.h pulls the 1.1 headers and the
   two sets of declarations conflict. */
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#else
#include <netdb.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#endif

#include "seal.h"

#define MAX_ADDRS 8

/* One name per platform difference, so the body below reads the same on both.
   Winsock's socket is an unsigned handle rather than a small int, so "< 0" is
   never true for a failed one and INVALID_SOCKET is the only correct test. */
#ifdef _WIN32
typedef SOCKET gv_socket;
typedef HANDLE gv_thread;
typedef int gv_socklen;
#define GV_BAD_SOCKET INVALID_SOCKET
#define gv_close_socket closesocket
#else
typedef int gv_socket;
typedef pthread_t gv_thread;
typedef socklen_t gv_socklen;
#define GV_BAD_SOCKET (-1)
#define gv_close_socket close
#endif

#define GV_RECV_TIMEOUT_MS 200

struct gv_net {
  gv_engine *engine;
  gv_socket fd;
  struct sockaddr_storage addrs[MAX_ADDRS];
  gv_socklen addr_len[MAX_ADDRS];
  int n_addrs;
  atomic_int chosen, stop;
  uint32_t session, counter;
  uint8_t key[GV_KEY_BYTES];
  gv_replay replay;
  gv_thread thread;
};

#ifdef _WIN32
/* Winsock needs starting once per process and stopping as many times as it was
   started. Reference counted here rather than left to the caller, so a host
   that already called WSAStartup is not torn out from under. */
static atomic_int wsa_users = 0;

static int wsa_acquire(void) {
  if (atomic_fetch_add(&wsa_users, 1) == 0) {
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
      atomic_fetch_sub(&wsa_users, 1);
      return -1;
    }
  }
  return 0;
}

static void wsa_release(void) {
  if (atomic_fetch_sub(&wsa_users, 1) == 1) WSACleanup();
}
#else
static int wsa_acquire(void) { return 0; }
static void wsa_release(void) {}
#endif

static int resolve(const char *addr, struct sockaddr_storage *out, gv_socklen *len) {
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
  *len = (gv_socklen)res->ai_addrlen;
  freeaddrinfo(res);
  return 0;
}

static int same(const struct sockaddr_storage *a, const struct sockaddr_storage *b, gv_socklen len) {
  return memcmp(a, b, (size_t)len) == 0;
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
    if (chosen < 0 || chosen == i)
      /* Winsock takes a char* and an int length, so the casts are the price of
         one call site rather than two copies of this loop. */
      sendto(n->fd, (const char *)out, (int)sealed, 0, (struct sockaddr *)&n->addrs[i], (int)n->addr_len[i]);
}

static void receive_loop_body(gv_net *n) {
  uint8_t buf[2048];
  while (!atomic_load(&n->stop)) {
    struct sockaddr_storage from;
    gv_socklen from_len = sizeof from;
    int got = (int)recvfrom(n->fd, (char *)buf, (int)sizeof buf, 0, (struct sockaddr *)&from, &from_len);
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
}

#ifdef _WIN32
static DWORD WINAPI receive_loop(LPVOID arg) {
  receive_loop_body(arg);
  return 0;
}
#else
static void *receive_loop(void *arg) {
  receive_loop_body(arg);
  return NULL;
}
#endif

/* The receive thread has to come down before the socket closes, or it blocks
   in recvfrom on a handle that is gone. Both arms join first. */
static int start_thread(gv_net *n) {
#ifdef _WIN32
  n->thread = CreateThread(NULL, 0, receive_loop, n, 0, NULL);
  return n->thread == NULL ? -1 : 0;
#else
  return pthread_create(&n->thread, NULL, receive_loop, n) != 0 ? -1 : 0;
#endif
}

static void join_thread(gv_net *n) {
#ifdef _WIN32
  /* Worst case this waits one receive timeout, which is why that timeout
     exists rather than a blocking recvfrom. */
  WaitForSingleObject(n->thread, INFINITE);
  CloseHandle(n->thread);
#else
  pthread_join(n->thread, NULL);
#endif
}

/* SO_RCVTIMEO is a timeval on POSIX and a DWORD of milliseconds on Winsock.
   Passing the wrong one silently sets a nonsense timeout rather than failing. */
static int set_recv_timeout(gv_socket fd) {
#ifdef _WIN32
  DWORD ms = GV_RECV_TIMEOUT_MS;
  return setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&ms, sizeof ms);
#else
  struct timeval tv = {GV_RECV_TIMEOUT_MS / 1000, (GV_RECV_TIMEOUT_MS % 1000) * 1000};
  return setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
#endif
}

gv_net *gv_net_open(gv_engine *engine, const char *const *addrs, int n_addrs, uint32_t session, const uint8_t key[32]) {
  if (wsa_acquire() != 0) return NULL;
  gv_net *n = calloc(1, sizeof *n);
  if (!n) {
    wsa_release();
    return NULL;
  }
  n->engine = engine;
  n->session = session;
  n->fd = GV_BAD_SOCKET;
  memcpy(n->key, key, GV_KEY_BYTES);
  atomic_init(&n->chosen, -1);
  atomic_init(&n->stop, 0);
  for (int i = 0; i < n_addrs && n->n_addrs < MAX_ADDRS; i++)
    if (resolve(addrs[i], &n->addrs[n->n_addrs], &n->addr_len[n->n_addrs]) == 0) n->n_addrs++;
  /* One socket for both families: an IPv6 socket that also takes IPv4 would differ per OS, so v4 only for now. */
  n->fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (n->n_addrs == 0 || n->fd == GV_BAD_SOCKET || set_recv_timeout(n->fd) != 0 || start_thread(n) != 0) {
    if (n->fd != GV_BAD_SOCKET) gv_close_socket(n->fd);
    free(n);
    wsa_release();
    return NULL;
  }
  engine->send = send_packet;
  engine->user = n;
  return n;
}

void gv_net_close(gv_net *n) {
  if (!n) return;
  atomic_store(&n->stop, 1);
  join_thread(n);
  gv_close_socket(n->fd);
  n->engine->send = NULL;
  free(n);
  wsa_release();
}

int gv_net_chosen(const gv_net *n) { return atomic_load(&((gv_net *)n)->chosen); }
