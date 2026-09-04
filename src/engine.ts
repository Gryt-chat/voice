export { VoiceSingletonHooks } from "./shared/SingletonHooks.js";
export * from "./audio/index.js";
export * from "./webrtc/index.js";
export {
  useVoiceCallbacks,
  useVoiceConfig,
  useVoiceTarget,
  type VoiceConfigCallbacks,
  VoiceConfigProvider,
  type VoiceConfigProviderProps,
  type VoiceTarget,
} from "./config";
export { getVoicePlatform, setVoicePlatform } from "./platform";
export {
  type NativeAudioCapture,
  type NativeScreenCapture,
  type NativeScreenFrame,
  getVoiceHost,
  setVoiceHost,
  type VoiceHost,
  webHost,
} from "./host";
export type {
  AudioPipeline,
  AudioPipelineOptions,
  CameraConstraints,
  CameraFps,
  CaptureQuality,
  RoomAccess,
  RoomCoordinator,
  ScreenConstraints,
  ScreenShareFps,
  SfuInbound,
  SfuOutbound,
  SfuTransport,
  VoiceConfig,
  VoiceEngineOptions,
  VoiceLogger,
  VoicePlatform,
} from "./types.js";
