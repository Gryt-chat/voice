import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ReceiveLimiter } from '../dist/audio/processors/receiveLevelingCore.js';
const data = readFileSync(process.argv[2]);
let position = 0;
const comparisons = [];
while (position < data.length) {
  const rate = data.readInt32LE(position); position += 4;
  const channels = [];
  for (let channel = 0; channel < 4; ++channel) {
    const values = new Float64Array(8192);
    for (let i = 0; i < values.length; ++i) { values[i] = data.readDoubleLE(position); position += 8; }
    channels.push(values);
  }
  const limiter = new ReceiveLimiter(rate);
  const input = channels.slice(0, 2).map(channel => Float32Array.from(channel));
  const output = [new Float32Array(8192), new Float32Array(8192)];
  const blocks = [1, 127, 128, 256, 512, 64];
  let offset = 0, block = 0;
  while (offset < 8192) {
    const count = Math.min(blocks[block++ % blocks.length], 8192 - offset);
    limiter.process(input.map(c => c.subarray(offset, offset + count)), output.map(c => c.subarray(offset, offset + count)), true);
    offset += count;
  }
  let maxError = 0;
  for (let c = 0; c < 2; ++c) for (let i = 0; i < 8192; ++i) maxError = Math.max(maxError, Math.abs(output[c][i] - channels[c + 2][i]));
  assert(maxError < 1e-6, `${rate} error ${maxError}`);
  comparisons.push({ rate, stereoSamples: 16384, maxError });
}
const result = { comparisons, basics: '369e906e03760ec219d07b06fa06dc4fd099f377', dsp: '4f62b0a8783c483c353d0232654fe0ffea3cd434', note: 'Original LimiterDouble, 3ms attack, 1-sample additional hold, 60ms release, full channel link, one FIR stage; TS adds final numerical clamp and nonfinite sanitization.' };
writeFileSync('receive-reference-results.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
