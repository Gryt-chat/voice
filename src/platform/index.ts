/**
 * Which platform's capture and peer construction the engine uses.
 *
 * A module-level singleton, for the same reason `setVoiceHost` is one: the
 * answer is fixed for the lifetime of the process. Nothing re-renders when the
 * platform changes, because the platform never changes. Config is the opposite
 * — it moves every time somebody drags a slider — which is why that goes
 * through a React context instead.
 *
 * This file deliberately imports neither implementation. Importing the web one
 * to use as a default is the obvious way to write it, and it is what this did
 * first: it means every bundle that reaches the registry also contains
 * `platform/web.js`, and on React Native that is the head of a chain ending in
 * the RNNoise worker, which Metro follows and cannot resolve. Measured, not
 * feared — `scripts/check-native-entry.mjs` is what caught it.
 *
 * So each entry point registers its own, on the way in.
 */

import type { VoicePlatform } from "../types.js";

let current: VoicePlatform | null = null;
let chosenExplicitly = false;

/**
 * Called by the embedder, or by `@gryt/voice/native` on its behalf.
 *
 * Wins over the default whichever order the imports happen to run in, which
 * matters because a React Native app that imports both entry points would
 * otherwise get whichever module the bundler evaluated last.
 */
export function setVoicePlatform(platform: VoicePlatform): void {
  current = platform;
  chosenExplicitly = true;
}

/**
 * What an entry point registers for anyone who does not choose.
 *
 * Not exported from the package: this is the barrel saying "if nobody says
 * otherwise, this is a browser", which is true of every embedder that existed
 * before the seam did.
 */
export function setDefaultVoicePlatform(platform: VoicePlatform): void {
  if (!chosenExplicitly) current = platform;
}

export function getVoicePlatform(): VoicePlatform {
  if (!current) {
    // Reachable only by importing a deep path and skipping both entry points.
    // Worth a sentence that says what to do rather than a TypeError about
    // reading a property of null, several frames further in.
    throw new Error(
      "@gryt/voice: no platform registered. Import the package from its entry " +
        "point — '@gryt/voice' in a browser, '@gryt/voice/native' on React " +
        "Native — or call setVoicePlatform() yourself before any voice code runs.",
    );
  }
  return current;
}
