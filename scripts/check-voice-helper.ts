// gryt-voice, the desktop's native engine process (GRYT-1837), builds here and speaks its line protocol. A bad key
// is refused without touching a sound card, which CI hasn't got.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(mkdtempSync(join(tmpdir(), "gv-helper-")), "gryt-voice");
execFileSync("node", ["native/tools/build-helper.mjs", bin], { stdio: "inherit" });
// The test CA override is for test builds only; a shipped helper that reads it can have its voice intercepted.
assert.ok(!readFileSync(bin).includes("GV_TLS_CA"), "the release helper reads GV_TLS_CA");
const out = execFileSync(bin, { input: "start 1 not-a-key 64 127.0.0.1:9\nquit\n", encoding: "utf8", timeout: 10_000 });
assert.equal(out.trim(), "started 0", `a bad key started the engine: ${out}`);
console.log("voice helper ok: gryt-voice builds, refuses a bad key, and quits when told");
