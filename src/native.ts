/* `@gryt/voice/native`. Separate entry point so a bundler never follows the
   web platform's worker imports — see `createNoiseSuppressor` in types.ts. */

import { setVoicePlatform } from "./platform/index.js";
import { nativePlatform } from "./platform/native.js";

setVoicePlatform(nativePlatform);

export { nativePlatform };
export * from "./engine.js";

/* Idempotent: safe to call again. */
export function registerNativeVoicePlatform(): void {
  setVoicePlatform(nativePlatform);
}
