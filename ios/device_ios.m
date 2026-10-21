// The iOS device on Apple's voice-processing unit rather than miniaudio's RemoteIO: one duplex unit, so it
// cancels the speaker's echo out of the mic. Same gv_device API as native/core/device.c, which iOS doesn't build.
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>

#include <stdlib.h>
#include <string.h>

#include "../native/core/device.h"

#define MAX_FRAMES 4096

struct gv_device {
  AudioUnit unit;
  gv_engine *engine;
  gv_tap_fn tap;
  void *user;
  float mic[MAX_FRAMES];
  float out[MAX_FRAMES * 2];
};

static OSStatus render(void *ref, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *ts, UInt32 bus,
                       UInt32 frames, AudioBufferList *io) {
  gv_device *d = ref;
  float *speaker = io->mBuffers[0].mData;
  if (frames > MAX_FRAMES) {
    memset(speaker, 0, io->mBuffers[0].mDataByteSize);
    return noErr;
  }
  AudioBufferList in = {.mNumberBuffers = 1};
  in.mBuffers[0] = (AudioBuffer){.mNumberChannels = 1, .mDataByteSize = frames * sizeof(float), .mData = d->mic};
  if (AudioUnitRender(d->unit, flags, ts, 1, frames, &in) != noErr) memset(d->mic, 0, frames * sizeof(float));
  if (d->tap) d->tap(d->user, d->mic, d->out, frames, 1, 0);
  gv_engine_capture(d->engine, d->mic, frames, 1);
  gv_engine_render(d->engine, d->out, frames);
  if (d->tap) d->tap(d->user, d->mic, d->out, frames, 1, 1);
  // The voice unit plays mono, so the engine's stereo mix is folded down.
  for (UInt32 i = 0; i < frames; i++) speaker[i] = 0.5f * (d->out[2 * i] + d->out[2 * i + 1]);
  return noErr;
}

static int set(AudioUnit u, AudioUnitPropertyID id, AudioUnitScope scope, AudioUnitElement el, const void *v, UInt32 size) {
  return AudioUnitSetProperty(u, id, scope, el, v, size) == noErr;
}

gv_device *gv_device_start(gv_engine *engine, const char *name, unsigned period, gv_tap_fn tap, void *user) {
  (void)name;
  AVAudioSession *session = AVAudioSession.sharedInstance;
  [session setCategory:AVAudioSessionCategoryPlayAndRecord
                  mode:AVAudioSessionModeVoiceChat
               options:AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetoothHFP
                 error:nil];
  [session setPreferredSampleRate:48000 error:nil];
  [session setPreferredIOBufferDuration:(double)period / 48000 error:nil];
  if (![session setActive:YES error:nil]) return NULL;

  gv_device *d = calloc(1, sizeof *d);
  if (!d) return NULL;
  d->engine = engine;
  d->tap = tap;
  d->user = user;

  AudioComponentDescription desc = {
      .componentType = kAudioUnitType_Output,
      .componentSubType = kAudioUnitSubType_VoiceProcessingIO,
      .componentManufacturer = kAudioUnitManufacturer_Apple,
  };
  AudioComponent comp = AudioComponentFindNext(NULL, &desc);
  if (!comp || AudioComponentInstanceNew(comp, &d->unit) != noErr) return free(d), NULL;

  UInt32 on = 1, max = MAX_FRAMES;
  AudioStreamBasicDescription mono = {
      .mSampleRate = 48000,
      .mFormatID = kAudioFormatLinearPCM,
      .mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
      .mBytesPerPacket = sizeof(float),
      .mFramesPerPacket = 1,
      .mBytesPerFrame = sizeof(float),
      .mChannelsPerFrame = 1,
      .mBitsPerChannel = 32,
  };
  AURenderCallbackStruct cb = {.inputProc = render, .inputProcRefCon = d};
  int ok = set(d->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, sizeof on) &&
           set(d->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &mono, sizeof mono) &&
           set(d->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &mono, sizeof mono) &&
           set(d->unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &max, sizeof max) &&
           set(d->unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &cb, sizeof cb) &&
           AudioUnitInitialize(d->unit) == noErr && AudioOutputUnitStart(d->unit) == noErr;
  if (!ok) return gv_device_stop(d), NULL;
  return d;
}

void gv_device_stop(gv_device *d) {
  if (!d) return;
  AudioOutputUnitStop(d->unit);
  AudioUnitUninitialize(d->unit);
  AudioComponentInstanceDispose(d->unit);
  free(d);
}

int gv_device_mic_channels(const gv_device *d) {
  (void)d;
  return 1;
}
