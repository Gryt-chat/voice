/**
 * Everything the engine is, minus which platform it runs on.
 *
 * Both entry points re-export this, and neither can import the other's. That
 * is the whole reason it is a separate file: `index.ts` registers the web
 * platform on the way in, which means importing `platform/web.js`, which
 * reaches `RNNoiseProcessor` and its `new Worker(new URL(...))` — and Metro
 * follows that into a package this one does not ship. So a React Native app
 * importing the barrel fails to bundle no matter how carefully the hooks
 * themselves are written.
 *
 * Measured: it fails after 1165 modules on "Unable to resolve module
 * @shiguredo/rnnoise-wasm", with the stack running index.js → platform/web.js →
 * rnnoiseProcessor.js → rnnoiseWorker.js. Splitting here is what fixes it.
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
