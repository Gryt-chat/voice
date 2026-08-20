/**
 * `@gryt/voice/native` — the React Native entry point.
 *
 * A React Native app imports **everything** from here, not from `@gryt/voice`.
 * That is not a style preference; the barrel cannot be made to work. It
 * registers the web platform on the way in, which means importing
 * `platform/web.js`, which reaches `RNNoiseProcessor` and its `new Worker(new
 * URL("./rnnoiseWorker.js", import.meta.url))`. Metro follows that as a
 * dependency into `@shiguredo/rnnoise-wasm`, which this package does not ship,
 * and the bundle fails after ~1165 modules with a resolution error pointing at
 * a file nothing on a phone would ever run.
 *
 * So the shared engine lives in `engine.ts`, both entry points re-export it,
 * and each registers its own platform. `scripts/check-native-entry.mjs` walks
 * the built graph from here and fails the build if anything a bundler can see
 * creeps back in.
 *
 * `registerGlobals()` from `react-native-webrtc` still has to be called by the
 * app, before this or anything else. The engine constructs a `MediaStream` in
 * `ontrack` when the SFU sends a track with no stream attached, and that is a
 * global rather than something the platform hands over.
 */

import { setVoicePlatform } from "./platform/index.js";
import { nativePlatform } from "./platform/native.js";

/**
 * Registered here rather than left to the app.
 *
 * `setVoicePlatform` rather than `setDefault`, so it wins over the web
 * registration whichever order a bundler evaluates the two entry points in —
 * which matters, because an app can easily end up importing both through a
 * dependency without meaning to.
 */
setVoicePlatform(nativePlatform);

export { nativePlatform };
export * from "./engine.js";

/**
 * Points the engine at `react-native-webrtc`.
 *
 * Importing this module already does it. The function exists so an app can say
 * so explicitly at its entry point, next to `registerGlobals()`, rather than
 * relying on import order and a side effect — and so there is something to
 * call when a linter removes an import whose only purpose was its side effect.
 *
 * Safe to call more than once; it assigns rather than accumulates.
 */
export function registerNativeVoicePlatform(): void {
  setVoicePlatform(nativePlatform);
}
