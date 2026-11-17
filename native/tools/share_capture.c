#include "share_capture.h"

#include <stdint.h>
#include <stdlib.h>

#ifndef _WIN32

gv_share *gv_share_start(unsigned long pid, int include, int frames, gv_share_fn fn, void *user) {
  (void)pid, (void)include, (void)frames, (void)fn, (void)user;
  return NULL;
}

void gv_share_stop(gv_share *s) { (void)s; }

#else

#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>

/* AUDIOCLIENT_ACTIVATION_PARAMS with a process loopback, which older SDK headers lack. */
typedef struct {
  DWORD type;
  DWORD pid;
  DWORD mode;
} activation_params;

static const GUID iid_unknown = {0x00000000, 0x0000, 0x0000, {0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};
static const GUID iid_completion = {0x41d949ab, 0x9862, 0x444a, {0x80, 0xf6, 0xc2, 0x61, 0x33, 0x4d, 0xa5, 0xeb}};
static const GUID iid_agile = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};
static const GUID iid_audio_client = {0x1cb9ad4c, 0xdbfa, 0x4c32, {0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2}};
static const GUID iid_capture_client = {0xc8adbd64, 0xe71e, 0x48a0, {0xa4, 0xde, 0x18, 0x5c, 0x39, 0x5c, 0xd3, 0x17}};

typedef HRESULT(WINAPI *activate_fn)(LPCWSTR, REFIID, PROPVARIANT *, IActivateAudioInterfaceCompletionHandler *,
                                     IActivateAudioInterfaceAsyncOperation **);

typedef struct {
  IActivateAudioInterfaceCompletionHandler iface;
  LONG refs;
  HANDLE done;
  HRESULT hr;
  IAudioClient *client;
} handler;

static HRESULT STDMETHODCALLTYPE h_query(IActivateAudioInterfaceCompletionHandler *self, REFIID riid, void **out) {
  if (IsEqualGUID(riid, &iid_unknown) || IsEqualGUID(riid, &iid_completion) || IsEqualGUID(riid, &iid_agile)) {
    *out = self;
    InterlockedIncrement(&((handler *)self)->refs);
    return S_OK;
  }
  *out = NULL;
  return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE h_add(IActivateAudioInterfaceCompletionHandler *self) {
  return InterlockedIncrement(&((handler *)self)->refs);
}

static ULONG STDMETHODCALLTYPE h_release(IActivateAudioInterfaceCompletionHandler *self) {
  handler *h = (handler *)self;
  LONG left = InterlockedDecrement(&h->refs);
  if (left == 0) {
    CloseHandle(h->done);
    free(h);
  }
  return (ULONG)left;
}

static HRESULT STDMETHODCALLTYPE h_completed(IActivateAudioInterfaceCompletionHandler *self,
                                             IActivateAudioInterfaceAsyncOperation *op) {
  handler *h = (handler *)self;
  HRESULT activated = E_FAIL;
  IUnknown *unk = NULL;
  HRESULT hr = IActivateAudioInterfaceAsyncOperation_GetActivateResult(op, &activated, &unk);
  if (SUCCEEDED(hr) && SUCCEEDED(activated) && unk) IUnknown_QueryInterface(unk, &iid_audio_client, (void **)&h->client);
  if (unk) IUnknown_Release(unk);
  h->hr = SUCCEEDED(hr) ? activated : hr;
  SetEvent(h->done);
  return S_OK;
}

static IActivateAudioInterfaceCompletionHandlerVtbl handler_vtbl = {h_query, h_add, h_release, h_completed};

struct gv_share {
  DWORD pid, mode;
  int frames;
  gv_share_fn fn;
  void *user;
  HANDLE thread, ready, stop;
  volatile int ok;
};

static IAudioClient *activate(DWORD pid, DWORD mode) {
  HMODULE mmdev = LoadLibraryW(L"mmdevapi.dll");
  activate_fn fn = mmdev ? (activate_fn)(void *)GetProcAddress(mmdev, "ActivateAudioInterfaceAsync") : NULL;
  if (!fn) return NULL;
  handler *h = calloc(1, sizeof *h);
  if (!h) return NULL;
  h->iface.lpVtbl = &handler_vtbl;
  h->refs = 1;
  h->hr = E_FAIL;
  h->done = CreateEventW(NULL, FALSE, FALSE, NULL);
  activation_params params = {1, pid, mode};
  PROPVARIANT pv = {0};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof params;
  pv.blob.pBlobData = (BYTE *)&params;
  IActivateAudioInterfaceAsyncOperation *op = NULL;
  IAudioClient *client = NULL;
  if (SUCCEEDED(fn(L"VAD\\Process_Loopback", &iid_audio_client, &pv, &h->iface, &op)) &&
      WaitForSingleObject(h->done, 3000) == WAIT_OBJECT_0 && SUCCEEDED(h->hr)) {
    client = h->client;
    h->client = NULL;
  }
  if (op) IActivateAudioInterfaceAsyncOperation_Release(op);
  if (h->client) IAudioClient_Release(h->client);
  h_release(&h->iface);
  return client;
}

static DWORD WINAPI capture(LPVOID arg) {
  gv_share *s = arg;
  CoInitializeEx(NULL, COINIT_MULTITHREADED);
  IAudioClient *client = activate(s->pid, s->mode);
  IAudioCaptureClient *cap = NULL;
  HANDLE wake = CreateEventW(NULL, FALSE, FALSE, NULL);
  /* 16-bit like the old helper: AUTOCONVERTPCM holds WASAPI to it whatever the app plays. */
  WAVEFORMATEX fmt = {WAVE_FORMAT_PCM, 2, 48000, 48000 * 4, 4, 16, 0};
  if (client &&
      SUCCEEDED(IAudioClient_Initialize(client, AUDCLNT_SHAREMODE_SHARED,
                                        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                        0, 0, &fmt, NULL)) &&
      SUCCEEDED(IAudioClient_SetEventHandle(client, wake)) &&
      SUCCEEDED(IAudioClient_GetService(client, &iid_capture_client, (void **)&cap)) &&
      SUCCEEDED(IAudioClient_Start(client)))
    s->ok = 1;
  SetEvent(s->ready);

  float *block = calloc((size_t)s->frames * 2, sizeof(float));
  int filled = 0;
  HANDLE waits[2] = {wake, s->stop};
  while (s->ok && block && WaitForMultipleObjects(2, waits, FALSE, 2000) != WAIT_OBJECT_0 + 1) {
    UINT32 next = 0;
    while (SUCCEEDED(IAudioCaptureClient_GetNextPacketSize(cap, &next)) && next > 0) {
      BYTE *data = NULL;
      UINT32 got = 0;
      DWORD flags = 0;
      if (FAILED(IAudioCaptureClient_GetBuffer(cap, &data, &got, &flags, NULL, NULL))) break;
      const int16_t *pcm = (const int16_t *)data;
      for (UINT32 i = 0; i < got; i++) {
        int silent = flags & AUDCLNT_BUFFERFLAGS_SILENT;
        block[filled * 2] = silent ? 0 : pcm[i * 2] / 32768.0f;
        block[filled * 2 + 1] = silent ? 0 : pcm[i * 2 + 1] / 32768.0f;
        if (++filled == s->frames) {
          s->fn(s->user, block, s->frames);
          filled = 0;
        }
      }
      IAudioCaptureClient_ReleaseBuffer(cap, got);
    }
  }
  free(block);
  if (client) IAudioClient_Stop(client);
  if (cap) IAudioCaptureClient_Release(cap);
  if (client) IAudioClient_Release(client);
  CloseHandle(wake);
  CoUninitialize();
  return 0;
}

gv_share *gv_share_start(unsigned long pid, int include, int frames, gv_share_fn fn, void *user) {
  gv_share *s = calloc(1, sizeof *s);
  if (!s) return NULL;
  /* PROCESS_LOOPBACK_MODE: 0 includes the target's tree, 1 excludes it. */
  *s = (gv_share){(DWORD)pid, include ? 0u : 1u, frames, fn, user, NULL, CreateEventW(NULL, FALSE, FALSE, NULL),
                  CreateEventW(NULL, TRUE, FALSE, NULL), 0};
  s->thread = CreateThread(NULL, 0, capture, s, 0, NULL);
  if (s->thread) WaitForSingleObject(s->ready, INFINITE);
  if (!s->ok) {
    gv_share_stop(s);
    return NULL;
  }
  return s;
}

void gv_share_stop(gv_share *s) {
  if (!s) return;
  SetEvent(s->stop);
  if (s->thread) WaitForSingleObject(s->thread, INFINITE), CloseHandle(s->thread);
  CloseHandle(s->ready);
  CloseHandle(s->stop);
  free(s);
}

#endif
