/**
 * @gryt/voice
 *
 * Gryt's voice engine: signalling, ICE, tracks, capture, the audio graph and
 * the connection state machine. `types.ts` has the seams for the things it
 * cannot know for itself.
 *
 * `VoiceSingletonHooks` has to be mounted above anything that consumes a hook
 * from here. Without it every hook returns its initial value forever and
 * nothing says so.
 */
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
