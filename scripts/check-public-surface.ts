// Asserts the package exports everything the Gryt client imports. Two releases shipped
// missing exports that built, typechecked and published. This is the client's list.
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REQUIRED = [
  "CAMERA_FPS_OPTIONS", "CENTRED", "EXPERIMENTAL_FPS_OPTIONS",
  "QUALITY_CONSTRAINTS", "SFUConnectionState", "STANDARD_FPS_OPTIONS",
  "VoiceConfigProvider", "VoiceSingletonHooks", "connectToSfuWebSocket",
  "detectFraming", "estimateBitrate", "getCachedSfuUrl", "getCurrentVolume",
  "getIsBrowserSupported", "getVoiceHost", "getVoicePlatform", "getVolumeDb",
  "isSpeaking", "performSfuCleanup", "performUnmountCleanup",
  "selectBestSfuUrl", "setVoiceHost", "setVoicePlatform", "webPlatform",
  "sfuConnect", "useCamera", "useDeviceEnumeration",
  "useHandles", "useMicrophone", "useNativeAudioCapture",
  "useNativeScreenCapture", "usePushToTalkGate", "useSFU", "useSFUStreams",
  "useScreenShare", "useSharedAudioContext", "useSpeakers", "useVideoStats",
  "useVoiceCallbacks", "useVoiceConfig", "useVoiceLatency", "useVoiceTarget",
  "voiceLog", "volumeToLevel", "warmSfuSelection", "webHost"
];

const mod = await import("../dist/index.js");
const missing = REQUIRED.filter((name) => !(name in mod));

if (missing.length > 0) {
  console.error(`Missing ${missing.length} export(s): ${missing.join(", ")}`);
  process.exit(1);
}

// Every singleton hook needs its body run by VoiceSingletonHooks. A hook whose body never
// runs returns its initialValue forever: useSFU() hands back a connect() that does nothing.
const usesSingletons = (await readFile(resolve(import.meta.dirname, "../dist/shared/singletonHook.js"), "utf8")).length > 0;
if (usesSingletons && !("VoiceSingletonHooks" in mod)) {
  console.error("singletonHook is in the bundle but VoiceSingletonHooks is not exported — every hook body would be dead");
  process.exit(1);
}

// Worker and asset URLs are plain strings tsc copies through, so a path written against
// src points at nothing once published. `new URL('./rnnoiseWorker.ts')` shipped once.
const sourceExtensions = [];
for (const file of await readdir(resolve(import.meta.dirname, "../dist"), { recursive: true })) {
  if (!file.endsWith(".js")) continue;
  const contents = await readFile(resolve(import.meta.dirname, "../dist", file), "utf8");
  for (const [, url] of contents.matchAll(/new URL\(\s*["'`](\.[^"'`]+)["'`]/g)) {
    if (/\.(ts|tsx|mts|cts)$/.test(url)) sourceExtensions.push(`${file}: ${url}`);
  }
}

if (sourceExtensions.length > 0) {
  console.error(`URLs pointing at source files that are not published:`);
  for (const hit of sourceExtensions) console.error(`  ${hit}`);
  process.exit(1);
}

console.log(
  `public surface ok: ${REQUIRED.length} required, ${Object.keys(mod).length} exported, no source-path URLs`,
);
