// Capture, the pipeline, device enumeration and the level helpers. Keyboard
// handling that writes mute and deafen has no audio graph in it and belongs to
// the embedder.
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
export { CENTRED, detectFraming, type Framing } from "./lib/faceFraming";
export { getIsBrowserSupported } from "./utils/mediaDevices";
export {
  getCurrentVolume,
  getVolumeDb,
  isSpeaking,
  volumeToLevel,
} from "./utils/speaking";
