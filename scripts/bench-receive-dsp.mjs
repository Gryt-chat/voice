import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { ReceiveLeveler, ReceiveLimiter } from '../dist/audio/processors/receiveLevelingCore.js';
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const rate = 48000, frames = 128, trials = 400;
const rows = [];
for (const count of [1, 4, 8, 16, 32]) {
  const routes = Array.from({ length: count }, () => ({
    leveler: new ReceiveLeveler(rate), limiter: new ReceiveLimiter(rate),
    input: [new Float32Array(frames), new Float32Array(frames)],
    mid: [new Float32Array(frames), new Float32Array(frames)],
    out: [new Float32Array(frames), new Float32Array(frames)],
  }));
  for (const route of routes) for (let c = 0; c < 2; ++c) for (let i = 0; i < frames; ++i) route.input[c][i] = Math.sin(i * 0.071) * 0.8;
  const bus = new ReceiveLimiter(rate), sum = [new Float32Array(frames), new Float32Array(frames)], output = [new Float32Array(frames), new Float32Array(frames)];
  function block() {
    sum[0].fill(0); sum[1].fill(0);
    for (const route of routes) {
      route.leveler.process(route.input, route.mid, true);
      for (let c = 0; c < 2; ++c) for (let i = 0; i < frames; ++i) route.mid[c][i] *= 2;
      route.limiter.process(route.mid, route.out, true);
      for (let c = 0; c < 2; ++c) for (let i = 0; i < frames; ++i) sum[c][i] += route.out[c][i];
    }
    bus.process(sum, output, true);
  }
  for (let i = 0; i < 200; ++i) block();
  const times = [];
  for (let i = 0; i < trials; ++i) { const start = performance.now(); block(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  const meanMs = times.reduce((a, b) => a + b) / trials;
  rows.push({ routes: count, meanMs, p95Ms: times[Math.floor(trials * 0.95)], p99Ms: times[Math.floor(trials * 0.99)], maximumMs: times[trials - 1], meanBudgetPercent: meanMs / (frames / rate * 1000) * 100 });
}
const result = { runtime: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unavailable', logicalCpus: os.cpus().length, rate, frames, stereo: true, priority: 'requested BelowNormal', blockBudgetMs: frames / rate * 1000, trials, rows, note: 'Sequential Node synthetic core benchmark under current concurrent system load. Excludes Chromium worklet scheduling/GC, graph nodes, decoding and device costs; this is not proof of glitch-free playback.' };
writeFileSync('receive-benchmark.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
