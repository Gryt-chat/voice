// Builds gryt-voice (native/tools/voice_helper.c) for this machine, for the desktop app (GRYT-1837).
// Plain JS so it runs from node_modules. Usage: node native/tools/build-helper.mjs [out file] [cc]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = resolve(process.argv[2] ?? join(root, "native/build", process.platform === "win32" ? "gryt-voice.exe" : "gryt-voice"));
const cc = process.argv[3] ?? process.env.CC ?? "cc";
const opus = join(root, "native/build/opus-src");
if (!existsSync(opus)) execFileSync("sh", ["native/opus/source.sh"], { cwd: root, stdio: "inherit" });

// libopus from its source, as the podspec builds it, so no configure step runs on any OS.
const opusFiles = ["celt", "silk", "silk/float", "src"].flatMap((dir) =>
  readdirSync(join(opus, dir))
    .filter((f) => f.endsWith(".c") && !/^(opus_demo|opus_compare|repacketizer_demo|opus_custom_demo)\.c$/.test(f))
    .map((f) => join(opus, dir, f)),
);
const core = ["voice", "net", "seal", "engine", "effects", "jitter", "packet"].map((f) => join(root, `native/core/${f}.c`));
// macOS gets Apple's voice-processing unit for echo cancellation; elsewhere miniaudio, with none yet.
const device = process.platform === "darwin" ? "native/core/device_vpio.c" : "native/core/device.c";
const libs = {
  darwin: ["-framework", "AudioToolbox", "-framework", "CoreAudio", "-framework", "CoreFoundation"],
  linux: ["-lpthread", "-ldl"],
  win32: ["-lws2_32", "-lole32", "-lwinmm"],
}[process.platform] ?? [];

mkdirSync(dirname(out), { recursive: true });
execFileSync(cc, [
  "-std=c11", "-O2", "-D_DEFAULT_SOURCE", "-DOPUS_BUILD=1", "-DUSE_ALLOCA=1", "-DHAVE_LRINTF=1", "-DHAVE_LRINT=1",
  ...["include", "celt", "silk", "silk/float", "."].map((d) => `-I${join(opus, d)}`),
  "-o", out,
  join(root, "native/tools/voice_helper.c"), ...core, join(root, device), join(root, "codec/opus/shim.c"),
  join(root, "native/vendor/monocypher/monocypher.c"), ...opusFiles, "-lm", ...libs,
], { cwd: root, stdio: "inherit" });
console.log(out);
