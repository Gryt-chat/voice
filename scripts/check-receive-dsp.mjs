import assert from 'node:assert/strict';
import vm from 'node:vm';
import { writeFileSync } from 'node:fs';
import { ReceivePeakHold, ReceiveBoxFilter, ReceiveLimiter, ReceiveLeveler } from '../dist/audio/processors/receiveLevelingCore.js';
import { RECEIVE_WORKLET_CODE } from '../dist/audio/processors/receiveProcessor.js';

const checks = [];
function check(name, fn) { fn(); checks.push(name); }
let seed = 19;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; }
const ceiling = 10 ** (-3 / 20);
function peak(data) { let result = 0; for (const v of data) { assert(Number.isFinite(v)); result = Math.max(result, Math.abs(v)); } return result; }
function rms(data, from = 0, to = data.length) { from = Math.floor(from); to = Math.floor(to); let sum = 0; for (let i = from; i < to; ++i) sum += data[i] ** 2; return Math.sqrt(sum / (to - from)); }
function render(rate, input, manual = 1, enabled = true, blocks = [128], leveler = new ReceiveLeveler(rate), limiter = new ReceiveLimiter(rate)) {
  const result = new Float32Array(input.length);
  let offset = 0, block = 0;
  while (offset < input.length) {
    const length = Math.min(blocks[block++ % blocks.length], input.length - offset);
    const source = [input.subarray(offset, offset + length)];
    const leveled = [new Float32Array(length)];
    const output = [new Float32Array(length)];
    leveler.process(source, leveled, enabled);
    for (let i = 0; i < length; ++i) leveled[0][i] *= manual;
    limiter.process(leveled, output, enabled);
    result.set(output[0], offset); offset += length;
  }
  return result;
}
function sine(rate, seconds, amplitude) {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin(i * 2 * Math.PI * 230 / rate));
}

check('Signalsmith fixed PeakHold equals sliding-window max', () => {
  for (const length of [1, 2, 3, 7, 64, 133, 144, 145, 289]) {
    const hold = new ReceivePeakHold(length), naive = [];
    for (let i = 0; i < 4000; ++i) {
      const value = i < 1000 ? -i : i < 2000 ? i : random() * 2 - 1;
      naive.push(value); if (naive.length > length) naive.shift();
      assert.equal(hold.next(value), Math.max(...naive), `window ${length}, sample ${i}`);
    }
    hold.reset(); assert.equal(hold.next(-5), -5);
  }
});
check('Signalsmith BoxFilter equals filled moving average', () => {
  for (const length of [1, 2, 133, 145, 289]) {
    const box = new ReceiveBoxFilter(length), naive = Array(length).fill(1);
    for (let i = 0; i < 4000; ++i) {
      const value = random(); naive.shift(); naive.push(value);
      assert(Math.abs(box.next(value) - naive.reduce((a, b) => a + b) / length) < 1e-12);
    }
  }
});

const scenarios = [];
for (const rate of [8000, 16000, 44100, 48000, 96000]) {
  check(`impulse boundaries/cold clipping/sample ceiling ${rate}`, () => {
    const delay = Math.ceil(rate * 0.003);
    for (const position of [0, 1, 63, 127, 128, delay - 1, delay, delay + 1, 255, 511]) {
      const input = new Float32Array(4096); input[position] = position % 2 ? -8 : 8;
      const out = render(rate, input, 2, true, [1, 127, 64, 256, 128, 512]);
      assert(peak(out) <= ceiling + 1e-7);
      assert(Math.abs(out[position + delay]) > 0.1, 'first impulse must survive lookahead');
    }
    const clipped = Float32Array.from({ length: 4096 }, (_, i) => i % 2 ? -1 : 1);
    assert(peak(render(rate, clipped, 2)) <= ceiling + 1e-7);
  });
  check(`quiet→shout→quiet ${rate}`, () => {
    const input = new Float32Array(rate * 10);
    input.set(sine(rate, 4, 0.02)); input.set(sine(rate, 2, 0.95), rate * 4); input.set(sine(rate, 4, 0.02), rate * 6);
    const out = render(rate, input, 1, true, [128, 256, 64, 127]);
    const quietGainDb = 20 * Math.log10(rms(out, rate * 3, rate * 4) / rms(input, rate * 3, rate * 4));
    const shoutRms = rms(out, rate * 4.1, rate * 5.9);
    assert(quietGainDb > 3 && quietGainDb < 9.1);
    assert(shoutRms < 0.22, `rate ${rate}, shoutRms ${shoutRms}`);
    assert(peak(out) <= ceiling + 1e-7);
    assert(rms(out, rate * 9, rate * 10) > 0.008, 'quiet return must remain audible');
    scenarios.push({ rate, beforeQuietRms: rms(input, rate * 3, rate * 4), beforeShoutRms: rms(input, rate * 4.1, rate * 5.9), beforeSamplePeak: peak(input), quietGainDb, shoutRms, samplePeak: peak(out) });
  });
  check(`silence/low stationary noise no gain chasing ${rate}`, () => {
    for (const amplitude of [0, 0.001, 0.002]) {
      const leveler = new ReceiveLeveler(rate);
      const input = Float32Array.from({ length: rate * 2 }, () => amplitude * (random() * 2 - 1));
      render(rate, input, 1, true, [128], leveler);
      assert.equal(leveler.gainDb, 0);
    }
  });
  check(`manual 0/100/200 and disable raw samples ${rate}`, () => {
    const input = sine(rate, 0.4, 0.05);
    const zero = render(rate, input, 0), one = render(rate, input, 1), two = render(rate, input, 2);
    assert.equal(peak(zero), 0);
    for (let i = 0; i < one.length; ++i) assert.equal(two[i], Math.fround(2 * one[i]));
    const raw = render(rate, input, 2, false), delay = Math.ceil(rate * 0.003);
    for (let i = delay; i < raw.length; ++i) assert.equal(raw[i], Math.fround(input[i - delay] * 2));
  });
}

check('stereo/empty/missing channels and NaN/Inf remain finite', () => {
  const limiter = new ReceiveLimiter(48000), leveler = new ReceiveLeveler(48000);
  for (const input of [[], [new Float32Array([NaN, Infinity, -Infinity, 0.5])], [new Float32Array(128), new Float32Array(128).fill(1)]]) {
    const leveled = [new Float32Array(128), new Float32Array(128)];
    const output = [new Float32Array(128), new Float32Array(128)];
    leveler.process(input, leveled, true); limiter.process(leveled, output, true);
    for (const channel of output) assert(peak(channel) <= ceiling + 1e-7);
  }
  limiter.process([], [], true);
});
check('independent users/manual do not affect adaptive measurements', () => {
  const a = new ReceiveLeveler(48000), b = new ReceiveLeveler(48000);
  const input = sine(48000, 2, 0.02);
  render(48000, input, 0, true, [128], a); render(48000, input, 2, true, [128], b);
  assert.equal(a.gainDb, b.gainDb);
  assert.equal(new ReceiveLeveler(48000).gainDb, 0);
});
check('multi-route aligned sum has strict final ceiling', () => {
  const source = sine(48000, 0.5, 1), sum = new Float32Array(source.length);
  for (let route = 0; route < 8; ++route) {
    const out = render(48000, source, 2);
    for (let i = 0; i < sum.length; ++i) sum[i] += out[i];
  }
  const output = [new Float32Array(sum.length)]; new ReceiveLimiter(48000).process([sum], output, true);
  assert(peak(output[0]) <= ceiling + 1e-7);
});
check('disable drops adaptive boost and protects pending lookahead samples', () => {
  const leveler = new ReceiveLeveler(48000), limiter = new ReceiveLimiter(48000);
  render(48000, sine(48000, 7, 0.02), 2, true, [128], leveler, limiter);
  const input = new Float32Array(512).fill(0.1), mid = [new Float32Array(512)], out = [new Float32Array(512)];
  leveler.process([input], mid, false);
  assert.deepEqual(mid[0], input);
  limiter.process(mid, out, false);
  for (let i = limiter.latencySamples; i < out[0].length; ++i) assert.equal(out[0][i], input[i - limiter.latencySamples]);
  assert(peak(out[0]) <= ceiling + 1e-7);
});
check('stationary loud noise stays within bounded gain; music bypass does not boost', () => {
  const leveler = new ReceiveLeveler(48000), input = Float32Array.from({ length: 48000 * 10 }, () => (random() * 2 - 1) * 0.02);
  const out = render(48000, input, 1, true, [128], leveler);
  assert(leveler.gainDb <= 9 && leveler.gainDb >= -9 && peak(out) <= ceiling + 1e-7);
  const bypass = [new Float32Array(input.length)]; new ReceiveLeveler(48000).process([input], bypass, false);
  assert.deepEqual(bypass[0], input);
});
check('actual worklet program runs core and clears mute tail without allocation', () => {
  let Processor;
  vm.runInNewContext(RECEIVE_WORKLET_CODE, {
    sampleRate: 48000, Float32Array, Float64Array, Math, Number,
    AudioWorkletProcessor: class { port = { close() {} }; },
    registerProcessor: (_name, implementation) => { Processor = implementation; },
  });
  const processor = new Processor({ processorOptions: { kind: 'limiter' } });
  const source = [new Float32Array(128).fill(4)], output = [new Float32Array(128)];
  const parameters = { enabled: [1], muted: [0] };
  processor.process([source], [output], parameters);
  processor.process([source], [output], { enabled: [1], muted: [1] }); assert.equal(peak(output[0]), 0);
  processor.process([[new Float32Array(128)]], [output], parameters); assert.equal(peak(output[0]), 0);
  processor.port.onmessage({ data: 'dispose' }); assert.equal(processor.process([], [output], parameters), false);
});

const evidence = { checks: checks.length, passed: checks, scenarios, ceiling, note: 'Synthetic audio; no listening, microphone, server or hearing-safety validation.' };
writeFileSync('receive-dsp-results.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
