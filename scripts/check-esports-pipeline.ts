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

function build(eSportsModeEnabled: boolean) {
  const { ctx, built } = fakeContext();
  createMicrophoneBuffer({
    audioContext: ctx,
    micStream: undefined,
    rnnoiseNode: null,
    noiseGateNode: null,
    eSportsModeEnabled,
    autoGainEnabled: true,
    compressorEnabled: true,
  });
  return built;
}

const normal = build(false);
assert.equal(normal.filter((k) => k === "compressor").length, 2, "the compressor and the limiter are both expected outside eSports mode");
assert.ok(normal.includes("shaper"), "the soft clipper is expected outside eSports mode");

const lean = build(true);
assert.ok(!lean.includes("compressor"), "eSports mode still builds a compressor or limiter");
assert.ok(!lean.includes("shaper"), "eSports mode still builds the soft clipper");
assert.ok(lean.includes("destination"), "eSports mode lost the send path");

console.log("esports pipeline: no compressor, limiter or clipper in eSports mode, all three otherwise");
