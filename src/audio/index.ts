// useGlobalHotkeys is staying in the client — keyboard handling that writes
// mute and deafen, with no audio graph in it. See GRYT-340.
export {
  CAMERA_FPS_OPTIONS,
  type CameraFps,
  type CameraQuality,
  QUALITY_CONSTRAINTS,
  useCamera,
} from "./hooks/useCamera";
export {
  type SharedAudioContextValue,
  useSharedAudioContext,
} from "./hooks/useAudioContext";
export { useDeviceEnumeration } from "./hooks/useDeviceEnumeration";
export { useHandles } from "./hooks/useHandles";
export { useNativeAudioCapture } from "./hooks/useNativeAudioCapture";
export {
  type EncodedFrameCallback,
  useNativeScreenCapture,
} from "./hooks/useNativeScreenCapture";
export { useMicrophone } from "./hooks/useMicrophone";
export { useSpeakers } from "./hooks/useSpeakers";
export { type LatencyBreakdown, useVoiceLatency } from "./hooks/useVoiceLatency";
export { type PushToTalkGate, usePushToTalkGate } from "./hooks/usePushToTalkGate";
export {
  estimateBitrate,
  EXPERIMENTAL_FPS_OPTIONS,
  type ScreenShareFps,
  type ScreenShareQuality,
  STANDARD_FPS_OPTIONS,
  useScreenShare,
} from "./hooks/useScreenShare";
export { getIsBrowserSupported } from "./utils/mediaDevices";
export {
  getCurrentVolume,
  getVolumeDb,
  isSpeaking,
  volumeToLevel,
} from "./utils/speaking";
