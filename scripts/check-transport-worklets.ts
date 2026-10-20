// The own transport's worklets, run in Node on the built source (GRYT-1818): a beep through send and
// receive with no network comes out a few milliseconds later, at its level, and mute sends nothing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TRANSPORT_WORKLET_SOURCE } from "../dist/transport/workletSource.js";
import { RECEIVE_PROCESSOR, SEND_PROCESSOR } from "../dist/transport/workletNames.js";

const SR = 48000;
const QUANTUM = 128;
const FRAME = 120;

// What an AudioWorkletGlobalScope gives a processor, and no more.
let clock = 0;
type Options = { processorOptions: object };
type Message = Uint8Array | { type: string; on?: boolean };
const registered = new Map<string, new (options: Options) => Processor>();
interface Port {
  sent: Uint8Array[];
  postMessage(message: Uint8Array): void;
  onmessage: ((e: { data: Message }) => void) | null;
}
interface Processor {
  port: Port;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
class AudioWorkletProcessor {
  port: Port = { sent: [], postMessage(m) { this.sent.push(m); }, onmessage: null };
}
const scope = { sampleRate: SR, AudioWorkletProcessor, registerProcessor: (name: string, ctor: new (o: Options) => Processor) => registered.set(name, ctor) };
Object.defineProperty(globalThis, "currentTime", { get: () => clock, configurable: true });
new Function(...Object.keys(scope), TRANSPORT_WORKLET_SOURCE)(...Object.values(scope));

const wasm = readFileSync(new URL("../dist/codec/opus.wasm", import.meta.url));
const settings = { volume: 100, gateThreshold: 0, gateReleaseMs: 200, gateSmoothing: 0.8, autoGain: false, autoGainTargetDb: -20, compressor: false, compressorAmount: 50, limiter: false };
const SendProcessor = registered.get(SEND_PROCESSOR);
const ReceiveProcessor = registered.get(RECEIVE_PROCESSOR);
assert.ok(SendProcessor && ReceiveProcessor, "the worklet source didn't register both processors");
const send = new SendProcessor({ processorOptions: { wasm: wasm.buffer.slice(0), frame: FRAME, bitrate: 64000, stereoBitrate: 256000, settings } });
const receive = new ReceiveProcessor({ processorOptions: { wasm: wasm.buffer.slice(0), frame: FRAME } });
await new Promise((r) => setTimeout(r, 100)); // both load Opus asynchronously

/** Runs `seconds` with a beep starting at `beepAt`; packets go straight across, as a perfect network. */
function run(seconds: number, beepAt: number, stereo = false) {
  const out = new Float32Array(Math.round(seconds * SR));
  const outRight = new Float32Array(out.length);
  const onsetIn = Math.round(beepAt * SR);
  for (let pos = 0; pos + QUANTUM <= out.length; pos += QUANTUM) {
    const mic = new Float32Array(QUANTUM);
    for (let i = 0; i < QUANTUM; i++) {
      const n = pos + i - onsetIn;
      mic[i] = n >= 0 && n < 0.08 * SR ? 0.5 * Math.sin((2 * Math.PI * 1000 * n) / SR) : 0;
    }
    // Stereo: the beep on the left only, so the sides differ and the sender switches to stereo.
    send.process([stereo ? [mic, new Float32Array(QUANTUM)] : [mic]], [[new Float32Array(QUANTUM)]]);
    for (const bytes of send.port.sent.splice(0)) {
      const forwarded = new Uint8Array(4 + bytes.length);
      new DataView(forwarded.buffer).setUint32(0, 7);
      forwarded.set(bytes, 4);
      receive.port.onmessage?.({ data: forwarded });
    }
    const block = new Float32Array(QUANTUM);
    const blockRight = new Float32Array(QUANTUM);
    receive.process([], [[block, blockRight]]);
    out.set(block, pos);
    outRight.set(blockRight, pos);
    clock += QUANTUM / SR;
  }
  return { out, outRight, onsetIn };
}

const { out, onsetIn } = run(1, 0.5);
const onsetOut = out.findIndex((v, i) => i >= onsetIn && Math.abs(v) > 0.05);
const delayMs = ((onsetOut - onsetIn) / SR) * 1000;
assert.ok(onsetOut > 0, "the beep never came out");
assert.ok(delayMs > 0 && delayMs < 15, `the pipeline alone took ${delayMs.toFixed(1)} ms`);
const peak = Math.max(...out.subarray(onsetOut, onsetOut + 0.05 * SR).map(Math.abs));
assert.ok(peak > 0.4 && peak < 0.6, `the beep came out at a peak of ${peak.toFixed(2)}, in at 0.5`);

// A stereo mic: the left-only beep comes out on the left, and the right stays quiet.
const stereoRun = run(1, 0.5, true);
const leftPeak = Math.max(...stereoRun.out.subarray(stereoRun.onsetIn, stereoRun.onsetIn + 0.1 * SR).map(Math.abs));
const rightPeak = Math.max(...stereoRun.outRight.subarray(stereoRun.onsetIn, stereoRun.onsetIn + 0.1 * SR).map(Math.abs));
assert.ok(leftPeak > 0.4 && leftPeak < 0.6, `the left beep came out at ${leftPeak.toFixed(2)}`);
assert.ok(rightPeak < 0.02, `the right side, silent going in, came out at ${rightPeak.toFixed(3)}`);

// Muted: the timestamp keeps moving, but nothing is sent.
send.port.onmessage?.({ data: { type: "sending", on: false } });
const before = send.port.sent.length;
send.process([[new Float32Array(QUANTUM).fill(0.3)]], [[new Float32Array(QUANTUM)]]);
send.process([[new Float32Array(QUANTUM).fill(0.3)]], [[new Float32Array(QUANTUM)]]);
assert.equal(send.port.sent.length, before, "a muted sender sent packets");

// Speaking (GRYT-1830): sender 7's packets carry the flag with the gate open, so the receiver named it,
// and once its packets stop the ring goes out.
const said = receive.port.sent as (Uint8Array | number[])[];
assert.ok(said.some((m) => Array.isArray(m) && m.join() === "7"), "the receiver never said sender 7 was speaking");
said.length = 0;
for (let t = 0; t < 0.3 * SR; t += QUANTUM) {
  receive.process([], [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]]);
  clock += QUANTUM / SR;
}
assert.deepEqual(said.at(-1), [], "sender 7 still speaking after its packets stopped");

console.log(`transport worklets: a beep through send and receive in ${delayMs.toFixed(1)} ms with no network, at its level; stereo kept apart; muted sends nothing; speaking named and cleared`);
