// Whether the own video transport may start: Safari 18 has the track processor and generator in a worker,
// Safari 16.4 to 17 has WebCodecs without them and must stay on WebRTC video (GRYT-2431).

import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import vm from "node:vm";

type Mode = { inWorker: boolean } | "throws" | "silent";
// What the probe sends and gets back.
type Message = { data: string | boolean };
type Scope = { onmessage?: (e: Message) => void; postMessage?: (v: string | boolean) => void };
let workers = 0;

// Runs the real worker source in a sandbox that has the worker APIs or doesn't.
function fakeWorker(mode: Mode) {
  return class {
    onmessage: ((e: Message) => void) | null = null;
    onerror: (() => void) | null = null;
    private ready: Promise<Scope>;
    constructor(url: string) {
      workers++;
      const blob = resolveObjectURL(url);
      if (!blob) throw new Error(`no blob at ${url}`);
      this.ready = blob.text().then((source) => {
        const self: Scope = {};
        self.postMessage = (data) => queueMicrotask(() => this.onmessage?.({ data }));
        const api = typeof mode === "object" && mode.inWorker ? { MediaStreamTrackProcessor: class {}, VideoTrackGenerator: class {} } : {};
        vm.runInNewContext(source, { self, ...api });
        return self;
      });
    }
    postMessage(data: string) {
      if (mode === "throws") return void queueMicrotask(() => this.onerror?.());
      if (mode === "silent") return;
      void this.ready.then((self) => self.onmessage?.({ data }));
    }
    terminate() {}
  };
}

async function supported(mode: Mode, main = false): Promise<boolean> {
  const onMain = main ? class {} : undefined;
  Object.assign(globalThis, { Worker: fakeWorker(mode), MediaStreamTrackProcessor: onMain, MediaStreamTrackGenerator: onMain });
  // A fresh copy of the module each time, so its cached answer starts empty.
  const { frameTracksSupported } = await import(`../dist/transport/frameTrack.js?${Math.random()}`);
  const first: boolean = await frameTracksSupported();
  const before = workers;
  assert.equal(await frameTracksSupported(), first, "the answer is cached");
  assert.equal(workers, before, "the worker is asked once");
  return first;
}

assert.equal(await supported({ inWorker: true }), true, "Safari 18: both in a worker");
assert.equal(await supported({ inWorker: false }), false, "Safari 17: WebCodecs, no worker processor");
assert.equal(await supported("throws"), false, "a worker that fails to load");
assert.equal(await supported("silent"), false, "a worker that never answers");
workers = 0;
assert.equal(await supported("silent", true), true, "Chromium: both on the main thread");
assert.equal(workers, 0, "Chromium starts no worker");

console.log("frame tracks: Safari 18 goes on the own transport, older Safari and broken workers stay on WebRTC, Chromium needs no worker");
