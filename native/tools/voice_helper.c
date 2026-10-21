/* gryt-voice: the native engine for the desktop app (GRYT-1837), as a process of its own so Chromium's audio
   stack is out of the path. Commands come one per line on stdin; a report line goes to stdout 20 times a second. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <pthread.h>
#endif

#include "../core/voice.h"

#define MAX_ADDRS 8
#define MAX_IDS 64

/* Commands and reports run on two threads; the lock keeps a stop from freeing the engine mid-report. */
#ifdef _WIN32
static CRITICAL_SECTION lock;
#define LOCK() EnterCriticalSection(&lock)
#define UNLOCK() LeaveCriticalSection(&lock)
#else
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
#define LOCK() pthread_mutex_lock(&lock)
#define UNLOCK() pthread_mutex_unlock(&lock)
#endif

static gv_voice *voice;
static gv_effect_settings effects = {100, 0, 200, 0.8, 0, -20, 0, 50, 0};
static volatile int quit;

static int b64(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+' || c == '-') return 62;
  if (c == '/' || c == '_') return 63;
  return -1;
}

/* Standard or URL-safe base64, padding optional. Returns the bytes written, or -1. */
static int unbase64(const char *in, uint8_t *out, int max) {
  int n = 0, bits = 0;
  unsigned acc = 0;
  for (; *in && *in != '='; in++) {
    int v = b64(*in);
    if (v < 0) return -1;
    acc = (acc << 6) | (unsigned)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (n == max) return -1;
      out[n++] = (uint8_t)(acc >> bits);
    }
  }
  return n;
}

static void parse_effects(char *rest) {
  double v[9];
  for (int i = 0; i < 9; i++) {
    char *tok = strtok(i ? NULL : rest, " ");
    if (!tok) return;
    v[i] = atof(tok);
  }
  effects = (gv_effect_settings){v[0], v[1], v[2], v[3], (int)v[4], v[5], (int)v[6], v[7], (int)v[8]};
  if (voice) gv_voice_set_effects(voice, &effects);
}

/* start <session> <key> <period> <addr>...: the room_joined offer's udp part. */
static void start(char *rest) {
  char *session = strtok(rest, " "), *key = strtok(NULL, " "), *period = strtok(NULL, " ");
  const char *addrs[MAX_ADDRS];
  int n = 0;
  for (char *a; n < MAX_ADDRS && (a = strtok(NULL, " "));) addrs[n++] = a;
  uint8_t k[32];
  if (voice) gv_voice_stop(voice), voice = NULL;
  if (session && key && period && n > 0 && unbase64(key, k, 32) == 32)
    voice = gv_voice_start(addrs, n, (uint32_t)strtoul(session, NULL, 10), k, &effects, (unsigned)atoi(period));
  printf("started %d\n", voice != NULL);
  fflush(stdout);
}

/* gains <id>=<gain> ...: everyone named plays at that, anyone else at 1. */
static void gains(char *rest) {
  uint32_t ids[MAX_IDS];
  float g[MAX_IDS];
  int n = 0;
  for (char *tok = strtok(rest, " "); tok && n < MAX_IDS; tok = strtok(NULL, " ")) {
    char *eq = strchr(tok, '=');
    if (!eq) continue;
    ids[n] = (uint32_t)strtoul(tok, NULL, 10);
    g[n++] = (float)atof(eq + 1);
  }
  if (voice) gv_voice_set_gains(voice, ids, g, n);
}

static void command(char *line) {
  line[strcspn(line, "\r\n")] = 0;
  char *rest = strchr(line, ' ');
  if (rest) *rest++ = 0;
  else rest = line + strlen(line);
  if (!strcmp(line, "start")) start(rest);
  else if (!strcmp(line, "stop")) {
    if (voice) gv_voice_stop(voice), voice = NULL;
  } else if (!strcmp(line, "sending") && voice) gv_voice_set_sending(voice, atoi(rest));
  else if (!strcmp(line, "output") && voice) gv_voice_set_output_gain(voice, (float)atof(rest));
  else if (!strcmp(line, "effects")) parse_effects(rest);
  else if (!strcmp(line, "gains")) gains(rest);
  else if (!strcmp(line, "quit")) quit = 1;
}

static double finite_db(float db) { return isfinite(db) ? db : -120; }

/* r <route> <mic_db> <mic_speaking> l=<id>:<db>,... b=<id>:<ms>,... s=<id>,... */
static void report(void) {
  if (!voice) return;
  uint32_t ids[MAX_IDS], speaking[MAX_IDS];
  float db[MAX_IDS], ms[MAX_IDS], mic;
  int mic_speaking;
  int nl = gv_voice_levels(voice, ids, db, MAX_IDS, &mic, &mic_speaking);
  printf("r %d %.1f %d l=", gv_voice_route(voice), finite_db(mic), mic_speaking);
  for (int i = 0; i < nl; i++) printf("%s%u:%.1f", i ? "," : "", ids[i], finite_db(db[i]));
  int nb = gv_voice_buffered(voice, ids, ms, MAX_IDS);
  printf(" b=");
  for (int i = 0; i < nb; i++) printf("%s%u:%.1f", i ? "," : "", ids[i], ms[i]);
  int ns = gv_voice_speaking(voice, speaking, MAX_IDS);
  printf(" s=");
  for (int i = 0; i < ns; i++) printf("%s%u", i ? "," : "", speaking[i]);
  printf("\n");
  fflush(stdout);
}

#ifdef _WIN32
static DWORD WINAPI reader(LPVOID arg) {
#else
static void *reader(void *arg) {
#endif
  (void)arg;
  char line[4096];
  while (!quit && fgets(line, sizeof line, stdin)) {
    LOCK();
    command(line);
    UNLOCK();
  }
  /* The app went away: stdin closed. */
  quit = 1;
  return 0;
}

int main(void) {
  setvbuf(stdout, NULL, _IOLBF, 0);
#ifdef _WIN32
  InitializeCriticalSection(&lock);
  CreateThread(NULL, 0, reader, NULL, 0, NULL);
#else
  pthread_t t;
  pthread_create(&t, NULL, reader, NULL);
#endif
  while (!quit) {
    LOCK();
    report();
    UNLOCK();
#ifdef _WIN32
    Sleep(50);
#else
    nanosleep(&(struct timespec){0, 50000000}, NULL);
#endif
  }
  LOCK();
  if (voice) gv_voice_stop(voice);
  UNLOCK();
  return 0;
}
