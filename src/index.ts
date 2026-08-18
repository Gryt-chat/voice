/**
 * @gryt/voice
 *
 * Still mid-extraction — see GRYT-340. The boundary types are settled and the
 * camera and screen-share hooks now run on them; the microphone and the SFU
 * connection are the parts still living in the Gryt client.
 */
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
