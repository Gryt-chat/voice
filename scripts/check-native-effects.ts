// The C microphone effects (GRYT-1822) against the TypeScript ones they port: noise, tones and bursts at many
// settings, mono and stereo, through both, sample by sample. Against dist.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { VoiceEffects } = await import("../dist/audio/voiceEffects.js");

const dir = mkdtempSync(join(tmpdir(), "gv-effects-"));
const bin = join(dir, "core_test");
execFileSync("cc", [
  "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", bin,
  "native/core/packet.c", "native/core/seal.c", "native/core/jitter.c", "native/core/effects.c",
  "native/vendor/monocypher/monocypher.c", "native/test/core_test.c", "-lm",
]);

const SR = 48000;
const BLOCK = 128;
let rng = 3;
const random = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

/** Quiet noise, then speech-like bursts, then a loud tone, so the gate, auto gain and compressor all move. */
function signal(seconds: number, phase: number): Float32Array {
  const out = new Float32Array(seconds * SR);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const burst = Math.sin(2 * Math.PI * 3 * t + phase) > 0.3 ? 0.4 : 0.01;
    out[i] = (random() * 2 - 1) * 0.005 + burst * Math.sin(2 * Math.PI * (220 + phase * 50) * t) + (t > seconds * 0.7 ? 0.9 * Math.sin(2 * Math.PI * 900 * t) : 0);
  }
  return out;
}

const bools = [false, true];
let cases = 0;
let worst = 0;
for (const stereo of bools) {
  for (const autoGain of bools) {
    for (const compressor of bools) {
      for (const limiter of bools) {
        for (const [volume, gateThreshold] of [[100, 0], [150, 30], [60, 55]]) {
          const settings = { volume, gateThreshold, gateReleaseMs: 200, gateSmoothing: 0.8, autoGain, autoGainTargetDb: -18, compressor, compressorAmount: 70, limiter };
          const left = signal(2, 0), right = stereo ? signal(2, 1) : null;
          writeFileSync(join(dir, "in.f32"), Buffer.concat([Buffer.from(left.buffer), ...(right ? [Buffer.from(right.buffer)] : [])]));
          execFileSync(bin, ["effects", ...[volume, gateThreshold, 200, 0.8, +autoGain, -18, +compressor, 70, +limiter, +stereo, BLOCK].map(String), join(dir, "in.f32"), join(dir, "out.f32")]);
          const c = new Float32Array(readFileSync(join(dir, "out.f32")).buffer.slice(0));

          const fx = new VoiceEffects(SR, settings);
          for (let at = 0; at < left.length; at += BLOCK) fx.process(left.subarray(at, at + BLOCK), right?.subarray(at, at + BLOCK));
          const ts = right ? [...left, ...right] : [...left];
          assert.equal(c.length, ts.length, "C and TypeScript gave different lengths");
          for (let i = 0; i < ts.length; i++) worst = Math.max(worst, Math.abs(c[i] - ts[i]));
          cases++;
        }
      }
    }
  }
}
// Last-bit differences between V8's and libm's exp, log10 and tanh are fine; a wrong rule is not.
assert.ok(worst < 1e-5, `C and TypeScript differ by up to ${worst} in some sample`);
console.log(`native effects ok: ${cases} setting combinations, mono and stereo, within ${worst.toExponential(1)} of the TypeScript`);
