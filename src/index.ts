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
import { setDefaultVoicePlatform } from "./platform/index.js";
import { webPlatform } from "./platform/web.js";

/**
 * This entry point is the browser's, so it says so on the way in.
 *
 * A side effect in a barrel is worth being uncomfortable about, so: the
 * alternative is a default baked into the registry, and that puts the web
 * implementation in every bundle including React Native's, where it drags in
 * the RNNoise worker and the build fails. `setDefault` rather than `set`, so an
 * embedder that has already chosen keeps its choice no matter which module the
 * bundler evaluates first.
 */
setDefaultVoicePlatform(webPlatform);

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
export { webPlatform };
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
