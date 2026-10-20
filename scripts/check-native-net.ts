// The native engine over real UDP (GRYT-1822): sealed packets to a fake SFU on localhost and back, the dead first
// address losing the race, and the beep coming out at its level. Doesn't need a sound card.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

execFileSync("sh", ["native/opus/build.sh"], { stdio: "inherit" });
const bin = join(mkdtempSync(join(tmpdir(), "gv-net-")), "net_test");
execFileSync("cc", [
  "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-D_DEFAULT_SOURCE", "-Inative/build/opus/include/opus", "-o", bin,
  "native/test/net_test.c", "native/core/net.c", "native/core/seal.c", "native/core/engine.c", "native/core/effects.c",
  "native/core/jitter.c", "native/core/packet.c", "native/vendor/monocypher/monocypher.c", "codec/opus/shim.c",
  "native/build/opus/lib/libopus.a", "-lm", "-lpthread",
]);
process.stdout.write(execFileSync(bin, { encoding: "utf8" }));
