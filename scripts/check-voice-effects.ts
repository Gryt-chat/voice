// The own transport's microphone effects (GRYT-1819): sample by sample, so none may delay a sound.

import assert from "node:assert/strict";

import { type VoiceEffectSettings, VoiceEffects } from "../dist/audio/voiceEffects.js";

const SR = 48000;
const BLOCK = 128;
const off: VoiceEffectSettings = {
  volume: 100, gateThreshold: 0, gateReleaseMs: 200, gateSmoothing: 0.8,
  autoGain: false, autoGainTargetDb: -20, compressor: false, compressorAmount: 50, limiter: false,
};
const all: VoiceEffectSettings = { ...off, gateThreshold: 20, autoGain: true, compressor: true, limiter: true };

/** Runs `signal` through in 128-sample blocks, as an AudioWorklet would. */
function run(settings: VoiceEffectSettings, signal: Float32Array, fx = new VoiceEffects(SR, settings)) {
  const out = Float32Array.from(signal);
  for (let i = 0; i < out.length; i += BLOCK) fx.process(out.subarray(i, Math.min(out.length, i + BLOCK)));
  return out;
}
const tone = (seconds: number, amp: number, from = 0) => {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = from; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * 1000 * (i - from)) / SR);
  return x;
};
const rms = (x: Float32Array, from = 0) => {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length - from));
};
const firstLoud = (x: Float32Array, over: number) => x.findIndex((v) => Math.abs(v) > over);

// Everything off at 100 %: the sound comes out untouched.
{
  const x = tone(0.1, 0.5);
  assert.deepEqual(run(off, x), x, "with everything off the signal changed");
}

// No lookahead: with every effect on, a sound starting at sample n is heard from sample n.
{
  const quietThenLoud = tone(1, 0.5, 24000);
  const fx = new VoiceEffects(SR, { ...all, gateThreshold: 0 });
  const out = run({ ...all, gateThreshold: 0 }, quietThenLoud, fx);
  const onset = firstLoud(quietThenLoud, 0.01);
  assert.equal(firstLoud(out, 0.001), onset, "an effect delayed the onset");
}

// The gate: room noise stays out, speech gets through, and threshold 0 is no gate.
{
  const gated = { ...off, gateThreshold: 40 };
  assert.ok(rms(run(gated, tone(1, 0.0003)), SR / 2) < 1e-6, "noise at -70 dB got through a gate at 40");
  assert.ok(rms(run(gated, tone(1, 0.3)), SR / 2) > 0.2, "speech at -10 dB was gated");
  assert.ok(rms(run(off, tone(1, 0.0003)), SR / 2) > 0.0002, "threshold 0 still gated");
}

// The compressor: a loud tone comes down, and the slider at 0 leaves it alone.
{
  const loud = tone(1, 0.9);
  const squeezed = rms(run({ ...off, compressor: true, compressorAmount: 80 }, loud), SR / 2);
  assert.ok(squeezed < rms(loud) * 0.5, `the compressor barely touched a loud tone (${squeezed.toFixed(3)})`);
}

// Auto gain: quiet speech is lifted towards the target, by +12 dB at most.
{
  const quiet = tone(6, 0.01);
  const lifted = rms(run({ ...off, autoGain: true, autoGainTargetDb: -20 }, quiet), 5 * SR);
  assert.ok(lifted > rms(quiet) * 3, `auto gain didn't lift quiet speech (${lifted.toFixed(4)})`);
  assert.ok(lifted <= rms(quiet) * 4.01, "auto gain went past +12 dB");
}

// The limiter: nothing passes -1 dBFS, even pushed to 200 %.
{
  const out = run({ ...off, volume: 200, limiter: true }, tone(0.2, 1));
  assert.ok(Math.max(...out.map(Math.abs)) <= Math.pow(10, -1 / 20) + 1e-6, "the limiter let a peak past -1 dBFS");
}

console.log("voice effects: untouched when off, no onset delay when on; gate, compressor, auto gain and limiter do their jobs");
