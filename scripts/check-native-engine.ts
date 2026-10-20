// The native engine (GRYT-1822) end to end with no network: the same beep, stereo and mute checks the transport
// worklets get in check-transport-worklets, so the C engine and the browser one hold to the same promises.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

execFileSync("sh", ["native/opus/build.sh"], { stdio: "inherit" });
const bin = join(mkdtempSync(join(tmpdir(), "gv-engine-")), "engine_test");
execFileSync("cc", [
  "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-D_DEFAULT_SOURCE", "-Inative/build/opus/include/opus", "-o", bin,
  "native/test/engine_test.c", "native/core/engine.c", "native/core/effects.c", "native/core/jitter.c", "native/core/packet.c",
  "codec/opus/shim.c", "native/build/opus/lib/libopus.a", "-lm",
]);
process.stdout.write(execFileSync(bin, { encoding: "utf8" }));
