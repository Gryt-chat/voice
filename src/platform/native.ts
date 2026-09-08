/**
 * React Native, through `react-native-webrtc`. Only reachable from `@gryt/voice/native`,
 * which is what keeps the AudioWorklet and Worker code out of a phone bundle.
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

/* Not the three `false` flags the web platform passes, and not `true`: react-native-webrtc
   124 drops those constraints silently, and the processing comes from native (GRYT-335). */
const MIC_CONSTRAINTS = true as const;

/* Genuinely nothing: libwebrtc processed the stream before it got here. No noise gate, no
   level meter and no software gain — each reads as null or a no-op, not a wrong number. */
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
      // Nothing to tear down, and specifically not the source tracks: the engine stops that
      // stream itself, and stopping it here would close the microphone mid-rebuild.
    },
  };
}

export const nativePlatform: VoicePlatform = {
  name: "react-native",

  createPeerConnection(config) {
    // react-native-webrtc implements the same interface against its own class, so the
    // structural types do not line up. One cast rather than a generic engine.
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

  // getScreen is absent, which is what the optional method is for: iOS broadcasts through a
  // ReplayKit extension and Android through MediaProjection, and neither is getDisplayMedia.

  createAudioPipeline: createPassthroughPipeline,
};
