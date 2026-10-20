// libopus built to WASM by codec/opus/build.sh (GRYT-1818): a tone survives 2.5 ms frames, and a lost one is filled.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadOpus } from "../dist/codec/opus.js";

const SR = 48000;
const FRAME = 120;
const opus = await loadOpus(readFileSync(new URL("../dist/codec/opus.wasm", import.meta.url)));
const enc = opus.encoder({ frame: FRAME, bitrate: 64000 });
const dec = opus.decoder(FRAME);

const tone = (n: number) => Math.sin((2 * Math.PI * 1000 * n) / SR) * 0.5;
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

const frames = 200; // 0.5 s
let bytes = 0;
const out = new Float32Array(frames * FRAME);
for (let f = 0; f < frames; f++) {
  const pcm = Float32Array.from({ length: FRAME }, (_, i) => tone(f * FRAME + i));
  const packet = enc.encode(pcm);
  bytes += packet.length;
  const decoded = dec.decode(packet);
  assert.equal(decoded.length, FRAME, "a frame decoded to the wrong length");
  out.set(decoded, f * FRAME);
}

// 64 kbps at 400 packets a second is 20 bytes each; CELT keeps close to it.
const avg = bytes / frames;
assert.ok(avg > 10 && avg < 40, `packets averaged ${avg.toFixed(1)} bytes at 64 kbps`);

// Past the codec's own short delay the tone comes back at about the level it went in.
const settled = out.subarray(10 * FRAME);
const level = rms(settled) / 0.3536;
assert.ok(level > 0.85 && level < 1.15, `the tone came back at ${(level * 100).toFixed(0)}% of its level`);

// A packet that never came still gives a frame, filled in by Opus.
const filled = dec.decode(null);
assert.equal(filled.length, FRAME, "a lost packet left a gap");
assert.ok(rms(filled) > 0.05, "the lost frame was filled with silence");

enc.destroy();
dec.destroy();
console.log(`opus wasm: 2.5 ms frames at ${avg.toFixed(1)} bytes, the tone back at ${(level * 100).toFixed(0)}%, a lost frame filled`);
