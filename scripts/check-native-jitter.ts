// The C jitter buffer (GRYT-1822) against the TypeScript one it ports: random calls with jitter, loss,
// reordering, duplicates and stalls go through both, and every pull has to match. Against dist.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { JitterBuffer } = await import("../dist/transport/jitterBuffer.js");

const bin = join(mkdtempSync(join(tmpdir(), "gv-jitter-")), "core_test");
execFileSync("cc", [
  "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", bin,
  "native/core/packet.c", "native/core/seal.c", "native/core/jitter.c", "native/core/effects.c", "native/vendor/monocypher/monocypher.c",
  "native/test/core_test.c", "-lm",
]);

let rng = 1;
const random = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

function scenario(seed: number): string[] {
  rng = seed;
  const events: { at: number; line: string }[] = [];
  let seq = Math.floor(random() * 65536);
  let ts = Math.floor(random() * 2 ** 32);
  let stallUntil = 0;
  for (let i = 0; i < 4000; i++) {
    const sent = i * 2.5;
    if (random() < 0.002) stallUntil = sent + 20 + random() * 120;
    if (random() < 0.001) i += 40 + Math.floor(random() * 80);
    const jitter = -Math.log(1 - random()) * (seed % 3 === 0 ? 8 : 2);
    const at = Math.max(sent + 1 + jitter, stallUntil);
    if (random() >= 0.03) events.push({ at, line: `push ${seq} ${ts} ${at.toFixed(3)}` });
    if (random() < 0.01) events.push({ at: at + random() * 10, line: `push ${seq} ${ts} ${(at + 5).toFixed(3)}` });
    seq = (seq + 1) & 0xffff;
    ts = (ts + 120) >>> 0;
  }
  for (let t = 0; t < 4300 * 2.5; t += 2.5) events.push({ at: t + 0.0001, line: "pull" });
  return events.sort((a, b) => a.at - b.at).map((e) => e.line);
}

function viaTs(lines: string[]): string[] {
  const jb = new JitterBuffer({ frameMs: 2.5, minMs: 5, maxMs: 60 });
  const out: string[] = [];
  for (const line of lines) {
    const [op, seq, ts, at] = line.split(" ");
    if (op === "push") jb.push({ flags: 0, seq: Number(seq), timestamp: Number(ts), opus: new Uint8Array(2) }, Number(at));
    else {
      const p = jb.pull();
      const short = { lost: "L", silence: "S" } as const;
      out.push(p.kind === "packet" ? `P ${p.packet.seq}` : short[p.kind]);
    }
  }
  const s = jb.stats;
  out.push(`stats ${s.late} ${s.duplicate} ${s.lost} ${s.drained} ${s.rebuffered}`);
  return out;
}

for (let seed = 1; seed <= 30; seed++) {
  const lines = scenario(seed);
  const c = execFileSync(bin, ["jitter"], { input: lines.join("\n"), encoding: "utf8" }).trim().split("\n");
  const ts = viaTs(lines);
  const first = ts.findIndex((l, i) => l !== c[i]);
  assert.equal(first, -1, `seed ${seed}: pull ${first} differs, TypeScript "${ts[first]}" vs C "${c[first]}"`);
}

console.log("native jitter ok: 30 random calls, every pull and counter the same as the TypeScript buffer");
