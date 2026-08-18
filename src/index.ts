/**
 * @gryt/voice
 *
 * Still mid-extraction — see GRYT-340. The boundary types are settled and the
 * capture hooks run on them; the SFU connection is the part still living in
 * the Gryt client.
 */
export * from "./audio/index.js";
export * from "./webrtc/index.js";
export {
  useVoiceCallbacks,
  useVoiceConfig,
  type VoiceConfigCallbacks,
  VoiceConfigProvider,
  type VoiceConfigProviderProps,
} from "./config";
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
  VoiceDevice,
  VoiceEngineOptions,
  VoiceLogger,
  VoicePlatform,
} from "./types.js";
