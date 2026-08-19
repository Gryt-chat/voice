// Asserts the package exports everything the Gryt client imports from it.
//
// Two releases in a row shipped a package that built, typechecked and published
// while missing exports the client needed — useSpeakers, useNativeScreenCapture,
// useNativeAudioCapture, estimateBitrate, then useSharedAudioContext. Each was
// found by installing the package and waiting for tsc to complain, which is a
// slow way to learn something a list can check.
//
// This is that list. It is deliberately the client's requirements rather than
// "everything in src": the point is to catch a barrel that forgot a file, not to
// force every internal into the public surface.
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REQUIRED = [
  "CAMERA_FPS_OPTIONS", "CENTRED", "EXPERIMENTAL_FPS_OPTIONS",
  "QUALITY_CONSTRAINTS", "SFUConnectionState", "STANDARD_FPS_OPTIONS",
  "VoiceConfigProvider", "VoiceSingletonHooks", "connectToSfuWebSocket",
  "detectFraming", "estimateBitrate", "getCachedSfuUrl", "getCurrentVolume",
  "getIsBrowserSupported", "getVoiceHost", "getVolumeDb", "isSpeaking",
  "performSfuCleanup", "performUnmountCleanup", "selectBestSfuUrl",
  "setVoiceHost", "sfuConnect", "useCamera", "useDeviceEnumeration",
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

// Every singleton hook needs its body run by VoiceSingletonHooks. A hook whose
// body never runs returns its initialValue forever, which is silent: useSFU()
// hands back a connect() that does nothing. If singletonHook is used at all, the
// host has to be exported.
const usesSingletons = (await readFile(resolve(import.meta.dirname, "../dist/shared/singletonHook.js"), "utf8")).length > 0;
if (usesSingletons && !("VoiceSingletonHooks" in mod)) {
  console.error("singletonHook is in the bundle but VoiceSingletonHooks is not exported — every hook body would be dead");
  process.exit(1);
}

// Worker and asset URLs are plain strings that tsc copies through unchanged, so
// a path written against the source tree points at nothing once published. That
// shipped once: `new URL('./rnnoiseWorker.ts')` survived into dist and broke the
// client's build after tsc, this check and a publish had all passed.
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
