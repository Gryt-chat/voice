/**
 * React Native, through `react-native-webrtc`.
 *
 * Only reachable from the `@gryt/voice/native` entry point. Nothing the main
 * entry imports reaches this file, which is what keeps `react-native-webrtc`
 * out of a browser bundle and keeps the AudioWorklet and Worker code — which
 * Metro cannot parse, never mind run — out of a phone bundle.
 */

import {
  mediaDevices,
  RTCPeerConnection as NativeRTCPeerConnection,
} from "react-native-webrtc";

import type {
  AudioPipeline,
  AudioPipelineOptions,
  CameraConstraints,
  VoicePlatform,
} from "../types.js";

/**
 * No audio processing constraints, because there is nowhere to send them.
 *
 * The web platform passes `autoGainControl: false`, `echoCancellation: false`
 * and `noiseSuppression: false`, to stop the browser processing a signal the
 * engine's own graph is about to process. The obvious native version is the
 * same three flags set to true — there is no engine graph here, so the platform
 * should do the work instead.
 *
 * It would do nothing. `react-native-webrtc` 124 does not carry those three
 * constraints anywhere: they are absent from its `MediaTrackConstraints` type
 * and from its entire source, JavaScript and native alike. Passing them
 * compiles only if you widen the type yourself, and then they are dropped.
 *
 * The processing is real, it just is not reached from here. It comes from the
 * audio path the native module already sets up — the voice-processing audio
 * unit on iOS, the `VOICE_COMMUNICATION` source on Android — which is on by
 * default and not switchable from JavaScript. So this asks for a microphone
 * and takes what the platform gives it.
 *
 * Unverified on hardware. GRYT-335 is where "does a phone echo" gets an answer.
 */
const MIC_CONSTRAINTS = true as const;

/**
 * A pipeline that does nothing to the audio, which is the honest answer here.
 *
 * The processing that the web graph would apply has already happened, inside
 * libwebrtc, before this stream existed. Building something that looked like a
 * graph and applied nothing would be worse than saying so.
 *
 * What that costs, stated plainly rather than discovered later: no noise gate,
 * so there is no push-to-talk on a phone yet and no "is this person
 * transmitting" signal; no level meter, because measuring one needs an audio
 * graph; and no software gain, so the microphone volume slider does not move
 * anything. Every one of those reads as null or a no-op rather than a wrong
 * number.
 */
function createPassthroughPipeline({
  source,
}: AudioPipelineOptions): AudioPipeline {
  return {
    output: source,

    // Null rather than 0. Zero is a level, and a meter showing a steady zero
    // while somebody is talking is a bug report waiting to happen.
    getLevel: () => null,

    setGain: () => {
      // No software gain without a graph. Deliberately silent: this is called
      // on every slider drag, and a warning per event would bury the log.
    },

    setMuted: (muted) => {
      for (const track of source.getAudioTracks()) {
        track.enabled = !muted;
      }
    },

    destroy: () => {
      // Nothing to tear down, and specifically not the source tracks: the
      // engine opened that stream and stops it itself on release. Stopping it
      // here too would close the microphone out from under a pipeline rebuild.
    },
  };
}

export const nativePlatform: VoicePlatform = {
  name: "react-native",

  createPeerConnection(config) {
    // react-native-webrtc implements the same interface against its own class
    // rather than the DOM's, so the structural types do not line up even
    // though the runtime behaviour does. One cast, in one place, instead of
    // the engine being generic over two peer connection types.
    return new NativeRTCPeerConnection(
      config as ConstructorParameters<typeof NativeRTCPeerConnection>[0],
    ) as unknown as RTCPeerConnection;
  },

  async getMicrophone(deviceId) {
    const stream = await mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId } : MIC_CONSTRAINTS,
    });
    return stream as unknown as MediaStream;
  },

  async getCamera({ deviceId, width, height, fps }: CameraConstraints) {
    const stream = await mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId } : { facingMode: "user" }),
        frameRate: fps,
        ...(width && height ? { width, height } : {}),
      },
      audio: false,
    });
    return stream as unknown as MediaStream;
  },

  // getScreen is absent, which is what the optional method is for. iOS can
  // broadcast a screen through a ReplayKit extension and Android through
  // MediaProjection, and neither is `getDisplayMedia` — they are a separate
  // process and a foreground service respectively. Claiming the method and
  // throwing would make callers handle a rejection instead of checking a
  // property they already have to check.

  createAudioPipeline: createPassthroughPipeline,
};
