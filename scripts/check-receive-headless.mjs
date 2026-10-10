import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const root = resolve('dist');
const server = createServer((request, response) => {
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Synthetic receive DSP test</title>'); return; }
  const file = resolve(root, '.' + decodeURIComponent(request.url));
  if (!file.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
  try { response.setHeader('Content-Type', 'application/javascript'); response.end(readFileSync(file)); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => { throw new Error('Real microphone forbidden in this test'); }; });
  await page.goto(url);
  const rendered = await page.evaluate(async () => {
    const { loadReceiveProcessor, RECEIVE_PROCESSOR_NAME } = await import('/audio/processors/receiveProcessor.js');
    const { ReceiveLeveler, ReceiveLimiter } = await import('/audio/processors/receiveLevelingCore.js');
    const results = [];
    for (const rate of [44100, 48000]) {
      for (const enabled of [false, true]) {
        const frames = rate * 3, context = new OfflineAudioContext(2, frames, rate);
        await loadReceiveProcessor(context);
        const buffer = context.createBuffer(1, frames, rate), samples = buffer.getChannelData(0);
        for (let i = 0; i < frames; ++i) samples[i] = Math.sin(i * 230 * 2 * Math.PI / rate) * (i < rate ? 0.02 : i < 2 * rate ? 0.95 : 0.02);
        samples[0] = 4;
        const source = context.createBufferSource(); source.buffer = buffer;
        const nodes = ['leveler', 'limiter', 'limiter'].map(kind => new AudioWorkletNode(context, RECEIVE_PROCESSOR_NAME, {
          numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2],
          parameterData: { enabled: enabled ? 1 : 0 }, processorOptions: { kind },
        }));
        source.connect(nodes[0]); nodes[0].connect(nodes[1]); nodes[1].connect(nodes[2]); nodes[2].connect(context.destination); source.start();
        const rendered = await context.startRendering();
        const leveler = new ReceiveLeveler(rate), stream = new ReceiveLimiter(rate), bus = new ReceiveLimiter(rate);
        const expected = new Float32Array(frames);
        for (let i = 0; i < frames; i += 128) {
          const length = Math.min(128, frames - i);
          const input = [samples.subarray(i, i + length)], a = [new Float32Array(length)], b = [new Float32Array(length)], c = [new Float32Array(length)];
          leveler.process(input, a, enabled); stream.process(a, b, enabled); bus.process(b, c, enabled); expected.set(c[0], i);
        }
        let maxError = 0, maxPeak = 0, stereoError = 0, firstNonzero = -1;
        const left = rendered.getChannelData(0), right = rendered.getChannelData(1);
        for (let i = 0; i < frames; ++i) {
          maxError = Math.max(maxError, Math.abs(left[i] - expected[i]));
          maxPeak = Math.max(maxPeak, Math.abs(left[i])); stereoError = Math.max(stereoError, Math.abs(left[i] - right[i]));
          if (firstNonzero < 0 && left[i] !== 0) firstNonzero = i;
        }
        results.push({ rate, enabled, maxError, maxPeak, stereoError, firstNonzero, expectedDelaySamples: Math.ceil(rate * 0.003) * 2 });
      }
    }
    return results;
  });
  for (const row of rendered) {
    assert(row.maxError < 1e-6, JSON.stringify(row)); assert.equal(row.stereoError, 0);
    assert.equal(row.firstNonzero, row.expectedDelaySamples); if (row.enabled) assert(row.maxPeak <= 10 ** (-3 / 20) + 1e-7);
  }
  const lifecycle = await page.evaluate(async () => {
    const { getReceiveController } = await import('/audio/lib/receiveGraph.js');
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function waitFor(fn, label = 'state') { for (let i = 0; i < 250; ++i) { if (fn()) return; await sleep(20); } throw new Error(label + ' timeout ' + JSON.stringify({ current: controller.state, states, loads })); }
    const context = new AudioContext({ sampleRate: 48000 }); await context.resume();
    const realAddModule = context.audioWorklet.addModule.bind(context.audioWorklet);
    let loads = 0;
    context.audioWorklet.addModule = url => { ++loads; return loads === 1 ? Promise.reject(new Error('injected load failure')) : realAddModule(url); };
    const controller = getReceiveController(context, true), states = [];
    const unsubscribe = controller.subscribe(state => states.push({ ...state }));
    const source = context.createOscillator(), manual = context.createGain(); source.frequency.value = 230; manual.gain.value = 2;
    const route = controller.attach(source, manual); source.start(); route.setRole('microphone');
    await waitFor(() => states.some(state => state.status === 'degraded'), 'first load failure');
    const fallback = states.find(state => state.status === 'degraded');
    const fallbackGain = route.fallbackGain.gain.value;
    await waitFor(() => controller.state.status === 'active', 'first recovery');
    const active = controller.state;
    route.setRole('screen'); await sleep(40); const screenEnabled = route.leveler.parameters.get('enabled').value;
    route.setRole('unknown'); await sleep(40); const unknownEnabled = route.leveler.parameters.get('enabled').value;
    route.setRole('microphone'); await sleep(40); const micEnabled = route.leveler.parameters.get('enabled').value;
    route.setMuted(true); await sleep(40); const routeMuted = route.limiter.parameters.get('muted').value; route.setMuted(false);
    controller.setMuted(true); await sleep(40); const busMuted = controller.busLimiter.parameters.get('muted').value; controller.setMuted(false);
    controller.setEnabled(false); const disabled = controller.state; controller.setEnabled(true);
    const oldLeveler = route.leveler;
    oldLeveler.onprocessorerror(new Event('processorerror'));
    const failure = controller.state;
    const boostRemoved = !route.leveler && route.fallbackGain.gain.value === 0.5;
    await waitFor(() => controller.state.status === 'active');
    const newNode = oldLeveler !== route.leveler;
    controller.busLimiter.onprocessorerror(new Event('processorerror'));
    const busFailure = controller.state;
    await waitFor(() => controller.state.status === 'active');
    await context.suspend(); await waitFor(() => controller.state.status === 'suspended', 'context suspend'); const suspended = controller.state;
    await context.resume(); await waitFor(() => controller.state.status === 'active');
    const nativeWorklet = window.AudioWorkletNode;
    const bombUrl = URL.createObjectURL(new Blob([`class Bomb extends AudioWorkletProcessor {
      static get parameterDescriptors(){return [{name:'enabled',defaultValue:0},{name:'muted',defaultValue:0}];}
      process(){throw new Error('injected actual processor exception');}
    } registerProcessor('receive-test-bomb',Bomb);`], { type: 'application/javascript' }));
    await realAddModule(bombUrl); URL.revokeObjectURL(bombUrl);
    let injectBomb = true;
    window.AudioWorkletNode = class {
      constructor(ctx, name, options) {
        const node = new nativeWorklet(ctx, injectBomb ? 'receive-test-bomb' : name, options);
        injectBomb = false;
        return node;
      }
    };
    const actualFailureStart = states.length;
    controller.fail('test-force-rebuild'); await controller.recover();
    await waitFor(() => states.slice(actualFailureStart).some(state => state.reason === 'bus-processor-error'), 'actual processor exception');
    await waitFor(() => controller.state.status === 'active', 'actual exception recovery');
    window.AudioWorkletNode = nativeWorklet;
    route.dispose(); route.dispose(); const remainingRoutes = controller.chains.size;
    const nextSource = context.createOscillator(), nextManual = context.createGain();
    const recreated = controller.attach(nextSource, nextManual); nextSource.start();
    await waitFor(() => recreated.healthy);
    const newRoleUnknown = recreated.leveler.parameters.get('enabled').value;
    unsubscribe(); controller.dispose(); nextSource.stop(); source.stop(); await context.close();
    await sleep(40);
    return { states, loads, fallback, fallbackGain, active, screenEnabled, unknownEnabled, micEnabled, routeMuted, busMuted, disabled, failure, boostRemoved, newNode, busFailure, suspended, actualProcessorExceptionRecovered: true, remainingRoutes, newRoleUnknown, disposed: controller.disposed, timerCleared: !controller.timer };
  });
  writeFileSync('receive-headless-debug.json', JSON.stringify({ rendered, lifecycle }, null, 2) + '\n');
  assert.equal(lifecycle.fallback.status, 'degraded'); assert.equal(lifecycle.fallbackGain, 0.5);
  assert.equal(lifecycle.active.status, 'active'); assert.equal(lifecycle.active.latencyMs, 6);
  assert.equal(lifecycle.screenEnabled, 0); assert.equal(lifecycle.unknownEnabled, 0); assert.equal(lifecycle.micEnabled, 1);
  assert.equal(lifecycle.routeMuted, 1); assert.equal(lifecycle.busMuted, 1);
  assert.equal(lifecycle.disabled.status, 'disabled'); assert.equal(lifecycle.disabled.latencyMs, 6);
  assert.equal(lifecycle.failure.status, 'degraded'); assert(lifecycle.boostRemoved && lifecycle.newNode);
  assert.equal(lifecycle.busFailure.reason, 'bus-processor-error'); assert.equal(lifecycle.suspended.status, 'suspended');
  assert.equal(lifecycle.remainingRoutes, 0); assert.equal(lifecycle.newRoleUnknown, 0); assert(lifecycle.disposed && lifecycle.timerCleared);
  const result = { browser: browser.version(), rendered, lifecycle, note: 'Headless Chromium, muted output, synthetic buffers/oscillators, real AudioWorklet. Injected error callbacks and one actual throwing processor are covered; no physical device/microphone/voice listening.' };
  writeFileSync('receive-headless-results.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
