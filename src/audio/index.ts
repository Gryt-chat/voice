// useGlobalHotkeys is staying in the client — keyboard handling that writes
// mute and deafen, with no audio graph in it. See GRYT-340.
export {
  CAMERA_FPS_OPTIONS,
  type CameraFps,
  type CameraQuality,
  QUALITY_CONSTRAINTS,
  useCamera,
} from "./hooks/useCamera";
export { useDeviceEnumeration } from "./hooks/useDeviceEnumeration";
export { useHandles } from "./hooks/useHandles";
export { useMicrophone } from "./hooks/useMicrophone";
export { useVoiceLatency } from "./hooks/useVoiceLatency";
export { type PushToTalkGate, usePushToTalkGate } from "./hooks/usePushToTalkGate";
export {
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
