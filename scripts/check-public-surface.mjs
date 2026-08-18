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
const REQUIRED = [
  "CAMERA_FPS_OPTIONS", "EXPERIMENTAL_FPS_OPTIONS", "QUALITY_CONSTRAINTS",
  "STANDARD_FPS_OPTIONS", "SFUConnectionState", "estimateBitrate",
  "getCurrentVolume", "getIsBrowserSupported", "getVoiceHost", "getVolumeDb",
  "isSpeaking", "setVoiceHost", "useCamera", "useDeviceEnumeration",
  "useHandles", "useMicrophone", "useNativeAudioCapture",
  "useNativeScreenCapture", "usePushToTalkGate", "useSFU", "useSFUStreams",
  "useScreenShare", "useSharedAudioContext", "useSpeakers", "useVideoStats",
  "useVoiceCallbacks", "useVoiceConfig", "useVoiceLatency", "useVoiceTarget",
  "voiceLog", "volumeToLevel", "webHost", "VoiceConfigProvider",
];

const mod = await import("../dist/index.js");
const missing = REQUIRED.filter((name) => !(name in mod));

if (missing.length > 0) {
  console.error(`Missing ${missing.length} export(s): ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`public surface ok: ${REQUIRED.length} required, ${Object.keys(mod).length} exported`);
