// Only what has moved so far. The hooks still missing — useMicrophone,
// useSpeakers, useVoiceLatency, useGlobalHotkeys and useNativeScreenCapture —
// reach into the client's settings or its Electron bridge and arrive later.
export {
  CAMERA_FPS_OPTIONS,
  type CameraFps,
  type CameraQuality,
  QUALITY_CONSTRAINTS,
  useCamera,
} from "./hooks/useCamera";
export { useDeviceEnumeration } from "./hooks/useDeviceEnumeration";
export { useHandles } from "./hooks/useHandles";
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
