// eSports mode says it disables all audio processing. The compressor, limiter and clipper still ran,
// and their lookahead and oversampling added 16 ms to every word (voice#53).

import assert from "node:assert/strict";

import { createMicrophoneBuffer } from "../dist/audio/hooks/microphonePipeline.js";

/** An AudioContext that records which nodes the pipeline builds. Nothing is rendered. */
function fakeContext() {
  const built: string[] = [];
  const node = (kind: string) => {
    built.push(kind);
    const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });
    return {
      connect() {},
      disconnect() {},
      gain: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
      fftSize: 0, smoothingTimeConstant: 0, curve: null, oversample: "none", stream: {},
    };
  };
  const ctx = {
    createGain: () => node("gain"),
    createAnalyser: () => node("analyser"),
    createDynamicsCompressor: () => node("compressor"),
    createWaveShaper: () => node("shaper"),
    createMediaStreamDestination: () => node("destination"),
    createMediaStreamSource: () => node("source"),
  };
  // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-restricted-types -- a fake with only the factories the pipeline calls
  return { ctx: ctx as unknown as AudioContext, built };
}

globalThis.MediaStream ??= class {} as typeof MediaStream;

interface Settings {
  eSportsModeEnabled: boolean;
  rnnoise: boolean;
  autoGainEnabled: boolean;
  compressorEnabled: boolean;
}

function build({ rnnoise, ...settings }: Settings) {
  const { ctx, built } = fakeContext();
  createMicrophoneBuffer({
    audioContext: ctx,
    micStream: undefined,
    // Only its presence matters to the pipeline, and connect() is all it calls.
    // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-restricted-types -- a stand-in for the RNNoise worklet
    rnnoiseNode: rnnoise ? ({ connect() {} } as unknown as AudioWorkletNode) : null,
    noiseGateNode: null,
    ...settings,
  });
  return built;
}

const everything = { eSportsModeEnabled: false, rnnoise: true, autoGainEnabled: true, compressorEnabled: true };
const nothing = { eSportsModeEnabled: false, rnnoise: false, autoGainEnabled: false, compressorEnabled: false };

const normal = build(everything);
assert.equal(normal.filter((k) => k === "compressor").length, 2, "the compressor and the limiter are both expected outside eSports mode");
assert.ok(normal.includes("shaper"), "the soft clipper is expected outside eSports mode");

const lean = build({ ...everything, eSportsModeEnabled: true });
assert.ok(!lean.includes("compressor"), "eSports mode still builds a compressor or limiter");
assert.ok(!lean.includes("shaper"), "eSports mode still builds the soft clipper");
assert.ok(lean.includes("destination"), "eSports mode lost the send path");

// Turning every process off by hand is eSports mode's chain too.
const off = build(nothing);
assert.ok(!off.includes("compressor") && !off.includes("shaper"), "with everything off, the limiter and clipper still ran");

// Any one process back on brings the limiter back, since it guards what they add.
for (const one of ["rnnoise", "autoGainEnabled", "compressorEnabled"] as const) {
  assert.ok(build({ ...nothing, [one]: true }).includes("shaper"), `${one} on its own lost the limiter and clipper`);
}

console.log("esports pipeline: no compressor, limiter or clipper in eSports mode or with every process off; any process brings them back");
