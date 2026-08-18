// Only what has moved so far. The hooks this used to re-export — useCamera,
// useMicrophone, useSpeakers, useScreenShare, useVoiceLatency, useGlobalHotkeys
// and useNativeScreenCapture — all reach into the client's settings or its
// Electron bridge, so they arrive with the platform adapters rather than here.
export { useDeviceEnumeration } from "./hooks/useDeviceEnumeration";
export { useHandles } from "./hooks/useHandles";
export { getIsBrowserSupported } from "./utils/mediaDevices";
export {
  getCurrentVolume,
  getVolumeDb,
  isSpeaking,
  volumeToLevel,
} from "./utils/speaking";
