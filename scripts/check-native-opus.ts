// Native libopus (GRYT-1822) against the WASM build: same tarball, same shim, so a phone and a browser in one call
// must understand each other. Each decodes the other's packets, mono and stereo, at the shipping settings.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOpus } from "../dist/codec/opus.js";

execFileSync("sh", ["native/opus/build.sh"], { stdio: "inherit" });
const dir = mkdtempSync(join(tmpdir(), "gv-opus-"));
const bin = join(dir, "opus_test");
execFileSync("cc", [
  "-std=c99", "-O2", "-Wall", "-Wextra", "-Werror", "-Inative/build/opus/include/opus", "-o", bin,
  "native/test/opus_test.c", "codec/opus/shim.c", "native/build/opus/lib/libopus.a", "-lm",
]);

const SR = 48000;
const FRAME = 120;
const opus = await loadOpus(readFileSync(new URL("../dist/codec/opus.wasm", import.meta.url)));

/** Two seconds of chords and noise, different on each side when stereo. */
function signal(channels: 1 | 2): Float32Array {
  const n = 2 * SR;
  const out = new Float32Array(n * channels);
  let seed = 11;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const t = i / SR;
      out[i * channels + c] = 0.3 * Math.sin(2 * Math.PI * (220 + 110 * c) * t) + 0.15 * Math.sin(2 * Math.PI * 1760 * t) + 0.02 * (seed / 2 ** 31 - 0.5);
    }
  }
  return out;
}

function packets(bytes: Buffer): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const n = bytes.readUInt16BE(at);
    out.push(bytes.subarray(at + 2, at + 2 + n));
    at += 2 + n;
  }
  return out;
}
const framed = (list: Uint8Array[]) => Buffer.concat(list.flatMap((p) => [Buffer.from([p.length >> 8, p.length & 0xff]), Buffer.from(p)]));

for (const [channels, bitrate] of [[1, 192000], [2, 256000]] as const) {
  const pcm = signal(channels);
  writeFileSync(join(dir, "in.f32"), Buffer.from(pcm.buffer));
  execFileSync(bin, ["encode", String(channels), String(bitrate), String(FRAME), join(dir, "in.f32"), join(dir, "native.pkts")]);
  const nativePackets = packets(readFileSync(join(dir, "native.pkts")));

  const enc = opus.encoder({ frame: FRAME, bitrate, channels });
  const wasmPackets: Uint8Array[] = [];
  for (let at = 0; at + FRAME * channels <= pcm.length; at += FRAME * channels) wasmPackets.push(enc.encode(pcm.subarray(at, at + FRAME * channels)));
  enc.destroy();
  assert.equal(nativePackets.length, wasmPackets.length, "native and WASM made a different number of packets");
  const identical = nativePackets.filter((p, i) => Buffer.compare(Buffer.from(p), Buffer.from(wasmPackets[i])) === 0).length;

  // Each side decodes the other's packets; what comes out has to match what the sender's own decoder makes.
  const decodeWasm = (list: Uint8Array[]) => {
    const dec = opus.decoder(FRAME, channels);
    const out = list.flatMap((p) => Array.from(dec.decode(p)));
    dec.destroy();
    return out;
  };
  const decodeNative = (list: Uint8Array[]) => {
    writeFileSync(join(dir, "x.pkts"), framed(list));
    execFileSync(bin, ["decode", String(channels), String(FRAME), join(dir, "x.pkts"), join(dir, "x.f32")]);
    return Array.from(new Float32Array(readFileSync(join(dir, "x.f32")).buffer.slice(0)));
  };
  const worst = (a: number[], b: number[]) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
  const wasmByNative = worst(decodeNative(wasmPackets), decodeWasm(wasmPackets));
  const nativeByWasm = worst(decodeWasm(nativePackets), decodeNative(nativePackets));
  assert.ok(wasmByNative < 1e-3 && nativeByWasm < 1e-3, `cross-decoding differed by ${wasmByNative} / ${nativeByWasm}`);

  // And the tone survives: past the codec's own short delay, the level matches what went in.
  const back = decodeNative(nativePackets).slice(SR * channels);
  const rms = (v: ArrayLike<number>) => {
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
    return Math.sqrt(sum / v.length);
  };
  const level = rms(back) / rms(pcm.subarray(SR * channels));
  assert.ok(level > 0.9 && level < 1.1, `${channels === 2 ? "stereo" : "mono"} came back at ${(level * 100).toFixed(0)}%`);
  console.log(`  ${channels === 2 ? "stereo" : "mono"} ${bitrate / 1000} kbps: ${identical}/${nativePackets.length} packets byte-identical, cross-decoded within ${Math.max(wasmByNative, nativeByWasm).toExponential(1)}, level ${(level * 100).toFixed(0)}%`);
}

console.log("native opus ok: the native build and the WASM build understand each other, mono and stereo");
