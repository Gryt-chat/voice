/**
 * The browser, and Electron, which is a browser. Each method is the call the engine used to
 * make inline, moved behind the seam with its constraints unchanged.
 */

import { RNNoiseProcessor } from "../audio/processors/rnnoiseProcessor.js";
import type {
  CameraConstraints,
  ScreenConstraints,
  VoicePlatform,
} from "../types.js";

/**
 * Capture constraints, in one place because they are load-bearing. Every browser-side
 * switch is off: gating a signal the browser already levelled breaks the threshold.
 */
const MIC_CONSTRAINTS: MediaTrackConstraints = {
  autoGainControl: false,
  echoCancellation: false,
  noiseSuppression: false,
  channelCount: 1,
  sampleRate: 48000,
  sampleSize: 16,
};

export const webPlatform: VoicePlatform = {
  name: "web",

  createPeerConnection(config) {
    return new RTCPeerConnection(config);
  },

  getMicrophone(deviceId) {
    return navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? { deviceId: { exact: deviceId }, ...MIC_CONSTRAINTS }
        : MIC_CONSTRAINTS,
    });
  },

  getCamera({ deviceId, width, height, fps }: CameraConstraints) {
    const video: MediaTrackConstraints = {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      frameRate: { ideal: fps, max: fps },
    };

    // Left unset for "native", where the point is to take whatever the camera
    // offers rather than ask it to scale.
    if (width && height) {
      video.width = { ideal: width, max: width };
      video.height = { ideal: height, max: height };
    }

    return navigator.mediaDevices.getUserMedia({ video, audio: false });
  },

  getScreen({ width, height, fps, withAudio }: ScreenConstraints) {
    const video: MediaTrackConstraints = {
      frameRate: { ideal: fps, max: fps },
    };

    if (width && height) {
      video.width = { ideal: width, max: width };
      video.height = { ideal: height, max: height };
    }

    return navigator.mediaDevices.getDisplayMedia({
      video,
      audio: withAudio,
    });
  },

  createNoiseSuppressor() {
    return new RNNoiseProcessor();
  },

  // createAudioPipeline is deliberately absent. The web graph is not a
  // standalone object — see the comment on VoicePlatform in types.ts.
};
