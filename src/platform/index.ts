
import type { VoicePlatform } from "../types.js";

let current: VoicePlatform | null = null;
let chosenExplicitly = false;

export function setVoicePlatform(platform: VoicePlatform): void {
  current = platform;
  chosenExplicitly = true;
}

/* Does not overwrite a platform the embedder set explicitly. */
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
