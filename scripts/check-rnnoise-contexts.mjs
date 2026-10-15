import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

class FakeContext {
  registrations = new Set();
  loads = 0;
  beforeLoad = async () => {};
  audioWorklet = {
    addModule: async (url) => {
      this.loads++;
      await this.beforeLoad();
      const code = await (await fetch(url)).text();
      runInNewContext(code, {
        AudioWorkletProcessor: class {},
        registerProcessor: (name) => {
          assert(!this.registrations.has(name), 'processor registered twice');
          this.registrations.add(name);
        },
      });
    },
  };
}

globalThis.AudioWorkletNode = class {
  constructor(context, name) {
    assert(context.registrations.has(name), 'processor is not registered in this context');
  }
  port = { postMessage() {} };
  disconnect() {}
};
globalThis.Worker = class {
  postMessage({ type }) {
    if (type === 'init') queueMicrotask(() => this.onmessage({ data: { type: 'ready' } }));
  }
  terminate() {}
};
globalThis.MessageChannel = class {
  port1 = {};
  port2 = {};
};

const moduleFor = async (scenario) => (await import(
  `../dist/audio/processors/rnnoiseProcessor.js?${scenario}`
)).RNNoiseProcessor;

// Replacing the AudioContext must load its own module, even after an earlier context succeeded.
{
  const Processor = await moduleFor('successive');
  const firstContext = new FakeContext(), secondContext = new FakeContext();
  const first = new Processor(), second = new Processor(), repeated = new Processor();
  await first.initialize(firstContext);
  first.destroy();
  await second.initialize(secondContext);
  await repeated.initialize(secondContext);
  assert.equal(firstContext.loads, 1);
  assert.equal(secondContext.loads, 1);
  second.destroy();
  repeated.destroy();
}

// Two initializers must share one pending addModule instead of registering twice.
{
  const Processor = await moduleFor('concurrent');
  const context = new FakeContext();
  let release;
  context.beforeLoad = () => new Promise(resolve => { release = resolve; });
  const first = new Processor(), second = new Processor();
  const pending = [first.initialize(context), second.initialize(context)];
  assert.equal(context.loads, 1);
  release();
  await Promise.all(pending);
  first.destroy();
  second.destroy();
}

// A rejected pending load reaches both callers and does not prevent retry on that context.
{
  const Processor = await moduleFor('retry');
  const context = new FakeContext();
  let rejectLoad;
  context.beforeLoad = () => new Promise((_, reject) => { rejectLoad = reject; });
  const first = new Processor(), second = new Processor();
  const settled = Promise.allSettled([first.initialize(context), second.initialize(context)]);
  assert.equal(context.loads, 1);
  rejectLoad(new Error('injected registration failure'));
  const results = await settled;
  assert(results.every(result => result.status === 'rejected'
    && result.reason.message === 'injected registration failure'));
  context.beforeLoad = async () => {};
  await first.initialize(context);
  await second.initialize(context);
  assert.equal(context.loads, 2);
  first.destroy();
  second.destroy();
}

// addModule can also fail before it returns a promise; that failure must remain retryable.
{
  const Processor = await moduleFor('synchronous-failure');
  const context = new FakeContext();
  const addModule = context.audioWorklet.addModule;
  context.audioWorklet.addModule = () => { throw new Error('synchronous load failure'); };
  const processor = new Processor();
  await assert.rejects(processor.initialize(context), /synchronous load failure/);
  context.audioWorklet.addModule = addModule;
  await processor.initialize(context);
  assert.equal(context.loads, 1);
  processor.destroy();
}

console.log('RNNoise context registration: successive, repeated, concurrent and retry checks passed');
