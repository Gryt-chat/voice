// The native engine on real devices (GRYT-1822) has to keep building on every OS CI runs. It can't run there: no
// sound card. On a Mac with BlackHole, native/build/voice_tool measure times a click through the engine.
import { execFileSync } from "node:child_process";

execFileSync("sh", ["native/opus/build.sh"], { stdio: "inherit" });
const libs = process.platform === "darwin"
  ? ["-framework", "CoreAudio", "-framework", "AudioToolbox", "-framework", "CoreFoundation"]
  : ["-lpthread", "-ldl"];
execFileSync("cc", [
  "-std=c11", "-O2", "-Wall", "-Wextra", "-D_DEFAULT_SOURCE", "-Inative/build/opus/include/opus", "-o", "native/build/voice_tool",
  "native/tools/voice_tool.c", "native/core/device.c", "native/core/engine.c", "native/core/effects.c", "native/core/jitter.c",
  "native/core/packet.c", "codec/opus/shim.c", "native/build/opus/lib/libopus.a", "-lm", ...libs,
], { stdio: "inherit" });
console.log(`native device ok: the engine and miniaudio build on ${process.platform}`);
