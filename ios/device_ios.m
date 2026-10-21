// The iOS device: the audio session, then the shared voice-processing device in native/core/device_vpio.c.
// It's included rather than compiled on its own, so the podspec needn't list it.
#import <AVFoundation/AVFoundation.h>

#define GV_VPIO_HAS_PREPARE
static int gv_vpio_prepare(unsigned period) {
  AVAudioSession *session = AVAudioSession.sharedInstance;
  // Left active by WebRTC after an earlier call, it keeps that call's rate: 48 kHz only takes on activation.
  [session setActive:NO error:nil];
  // Not defaultToSpeaker: with it, the app's route picker can't move the call to the earpiece.
  [session setCategory:AVAudioSessionCategoryPlayAndRecord
                  mode:AVAudioSessionModeVoiceChat
               options:AVAudioSessionCategoryOptionAllowBluetoothHFP
                 error:nil];
  [session setPreferredSampleRate:48000 error:nil];
  [session setPreferredIOBufferDuration:(double)period / 48000 error:nil];
  if (![session setActive:YES error:nil]) return 0;
  [session overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:nil];
  return 1;
}

#include "../native/core/device_vpio.c"
