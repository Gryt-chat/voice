/**
 * `@gryt/voice/native` — the React Native entry point.
 *
 * A separate entry rather than a runtime branch inside the main one. A branch
 * would still leave `import "react-native-webrtc"` in the module graph, and a
 * bundler resolves imports whether or not the branch is taken: the browser
 * would try to pull in a native module, and Metro would try to parse the
 * AudioWorklet code, whose `new URL("./rnnoiseWorker.js", import.meta.url)`
 * fails at parse time rather than at call time. Two entries, two graphs.
 *
 * Call `registerNativeVoicePlatform()` once, above everything else, in the same
 * breath as `registerGlobals()` from `react-native-webrtc`.
 */

import { setVoicePlatform } from "./platform/index.js";
import { nativePlatform } from "./platform/native.js";

setVoicePlatform(nativePlatform);

export { nativePlatform };

/**
 * Points the engine at `react-native-webrtc`.
 *
 * Safe to call more than once; it assigns rather than accumulates.
 */
export function registerNativeVoicePlatform(): void {
  setVoicePlatform(nativePlatform);
}
