#include "share_capture.h"

#include <stdint.h>
#include <stdlib.h>

#if defined(__APPLE__)

#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <libproc.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <unistd.h>

/* Only declared for Objective-C; weak, so before macOS 14.2 there's no share sound rather than no helper. */
extern OSStatus AudioHardwareCreateProcessTap(void *description, AudioObjectID *tap) __attribute__((weak_import));
extern OSStatus AudioHardwareDestroyProcessTap(AudioObjectID tap) __attribute__((weak_import));

struct gv_share {
  AudioObjectID tap, device;
  AudioDeviceIOProcID proc;
  int frames, filled;
  gv_share_fn fn;
  void *user;
  float *block;
  /* Input samples per 48 kHz output sample, where the next output falls, and the sample before it. */
  double step, pos;
  float last[2];
};

static AudioObjectPropertyAddress at(AudioObjectPropertySelector what, AudioObjectPropertyScope scope) {
  return (AudioObjectPropertyAddress){what, scope, kAudioObjectPropertyElementMain};
}

static int descends_from(pid_t p, pid_t root) {
  for (int hops = 0; p > 1 && hops < 64; hops++) {
    if (p == root) return 1;
    struct proc_bsdinfo info;
    if (proc_pidinfo(p, PROC_PIDTBSDINFO, 0, &info, sizeof info) != sizeof info) return 0;
    p = (pid_t)info.pbi_ppid;
  }
  return p == root;
}

/* Core Audio's process objects for root and everything under it, as Windows' loopback takes a tree. */
static CFArrayRef tree(pid_t root) {
  AudioObjectPropertyAddress list = at(kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal);
  AudioObjectPropertyAddress pid_of = at(kAudioProcessPropertyPID, kAudioObjectPropertyScopeGlobal);
  CFMutableArrayRef out = CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &list, 0, NULL, &size) != noErr || !size) return out;
  AudioObjectID *all = malloc(size);
  if (all && AudioObjectGetPropertyData(kAudioObjectSystemObject, &list, 0, NULL, &size, all) == noErr) {
    for (UInt32 i = 0; i < size / sizeof *all; i++) {
      pid_t pid = 0;
      UInt32 n = sizeof pid;
      if (AudioObjectGetPropertyData(all[i], &pid_of, 0, NULL, &n, &pid) != noErr || !descends_from(pid, root)) continue;
      int64_t id = all[i];
      CFNumberRef number = CFNumberCreate(NULL, kCFNumberSInt64Type, &id);
      CFArrayAppendValue(out, number);
      CFRelease(number);
    }
  }
  free(all);
  return out;
}

static void push(gv_share *s, float l, float r) {
  /* Linear, from the output device's rate when it isn't 48 kHz. */
  for (; s->pos <= 1.0; s->pos += s->step) {
    float t = (float)s->pos;
    s->block[s->filled * 2] = s->last[0] + (l - s->last[0]) * t;
    s->block[s->filled * 2 + 1] = s->last[1] + (r - s->last[1]) * t;
    if (++s->filled == s->frames) s->fn(s->user, s->block, s->frames), s->filled = 0;
  }
  s->pos -= 1.0;
  s->last[0] = l, s->last[1] = r;
}

static OSStatus io(AudioObjectID device, const AudioTimeStamp *now, const AudioBufferList *in, const AudioTimeStamp *in_time,
                   AudioBufferList *out, const AudioTimeStamp *out_time, void *arg) {
  (void)device, (void)now, (void)in_time, (void)out, (void)out_time;
  gv_share *s = arg;
  if (!in || !in->mNumberBuffers) return noErr;
  const AudioBuffer *b = in->mBuffers;
  if (in->mNumberBuffers == 1) {
    UInt32 ch = b[0].mNumberChannels ? b[0].mNumberChannels : 1, n = b[0].mDataByteSize / sizeof(float) / ch;
    const float *d = b[0].mData;
    for (UInt32 i = 0; i < n; i++) push(s, d[i * ch], d[i * ch + (ch > 1)]);
  } else {
    const float *l = b[0].mData, *r = b[1].mData;
    for (UInt32 i = 0, n = b[0].mDataByteSize / sizeof(float); i < n; i++) push(s, l[i], r[i]);
  }
  return noErr;
}

static CFDictionaryRef dict(const void **keys, const void **values, CFIndex n) {
  return CFDictionaryCreate(NULL, keys, values, n, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
}

/* A private tap of the processes, and a private aggregate device it shows up as the input of. */
static int open_tap(gv_share *s, pid_t pid, int include) {
  Class cls = objc_getClass("CATapDescription");
  if (!AudioHardwareCreateProcessTap || !cls) return 0;
  CFArrayRef processes = tree(pid);
  id description = ((id(*)(id, SEL))objc_msgSend)((id)cls, sel_registerName("alloc"));
  SEL init = sel_registerName(include ? "initStereoMixdownOfProcesses:" : "initStereoGlobalTapButExcludeProcesses:");
  description = ((id(*)(id, SEL, CFArrayRef))objc_msgSend)(description, init, processes);
  CFRelease(processes);
  if (!description) return 0;
  ((void (*)(id, SEL, BOOL))objc_msgSend)(description, sel_registerName("setPrivate:"), YES);
  OSStatus made = AudioHardwareCreateProcessTap(description, &s->tap);
  ((void (*)(id, SEL))objc_msgSend)(description, sel_registerName("release"));
  if (made != noErr) return 0;

  CFStringRef tap_uid = NULL;
  UInt32 n = sizeof tap_uid;
  AudioObjectPropertyAddress uid_of = at(kAudioTapPropertyUID, kAudioObjectPropertyScopeGlobal);
  if (AudioObjectGetPropertyData(s->tap, &uid_of, 0, NULL, &n, &tap_uid) != noErr || !tap_uid) return 0;
  int one = 1;
  CFNumberRef yes = CFNumberCreate(NULL, kCFNumberIntType, &one);
  const void *sub_keys[] = {CFSTR(kAudioSubTapUIDKey), CFSTR(kAudioSubTapDriftCompensationKey)};
  const void *sub_values[] = {tap_uid, yes};
  CFDictionaryRef sub = dict(sub_keys, sub_values, 2);
  CFArrayRef taps = CFArrayCreate(NULL, (const void **)&sub, 1, &kCFTypeArrayCallBacks);
  CFStringRef uid = CFStringCreateWithFormat(NULL, NULL, CFSTR("chat.gryt.voice.share.%d.%u"), getpid(), s->tap);
  const void *keys[] = {CFSTR(kAudioAggregateDeviceUIDKey), CFSTR(kAudioAggregateDeviceNameKey), CFSTR(kAudioAggregateDeviceIsPrivateKey),
                        CFSTR(kAudioAggregateDeviceTapAutoStartKey), CFSTR(kAudioAggregateDeviceTapListKey)};
  const void *values[] = {uid, CFSTR("Gryt share"), yes, yes, taps};
  CFDictionaryRef aggregate = dict(keys, values, 5);
  OSStatus built = AudioHardwareCreateAggregateDevice(aggregate, &s->device);
  CFRelease(aggregate), CFRelease(uid), CFRelease(taps), CFRelease(sub), CFRelease(yes), CFRelease(tap_uid);
  if (built != noErr) return 0;

  Float64 rate = 48000;
  AudioObjectPropertyAddress nominal = at(kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal);
  AudioObjectSetPropertyData(s->device, &nominal, 0, NULL, sizeof rate, &rate);
  n = sizeof rate;
  if (AudioObjectGetPropertyData(s->device, &nominal, 0, NULL, &n, &rate) != noErr || rate <= 0) return 0;
  s->step = rate / 48000.0;
  return AudioDeviceCreateIOProcID(s->device, io, s, &s->proc) == noErr && AudioDeviceStart(s->device, s->proc) == noErr;
}

gv_share *gv_share_start(unsigned long pid, int include, int frames, gv_share_fn fn, void *user) {
  gv_share *s = calloc(1, sizeof *s);
  if (!s) return NULL;
  s->frames = frames, s->fn = fn, s->user = user;
  s->block = calloc((size_t)frames * 2, sizeof(float));
  if (!s->block || !open_tap(s, (pid_t)pid, include)) {
    gv_share_stop(s);
    return NULL;
  }
  return s;
}

void gv_share_stop(gv_share *s) {
  if (!s) return;
  if (s->proc) AudioDeviceStop(s->device, s->proc), AudioDeviceDestroyIOProcID(s->device, s->proc);
  if (s->device) AudioHardwareDestroyAggregateDevice(s->device);
  if (s->tap) AudioHardwareDestroyProcessTap(s->tap);
  free(s->block);
  free(s);
}

#elif !defined(_WIN32)

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
