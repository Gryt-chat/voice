/* eslint-env node */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { acquireMicrophoneForRequest } = await import(
  "../dist/audio/hooks/microphoneRequest.js"
);

function fakeStream() {
  let stopped = false;
  return {
    stream: {
      getTracks() {
        return [{ stop: () => { stopped = true; } }];
      },
    },
    wasStopped: () => stopped,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The selected device succeeds normally.
{
  const request = { deviceId: "mic-a" };
  let current = request;
  const mic = fakeStream();
  const result = await acquireMicrophoneForRequest(
    request,
    () => current,
    async (deviceId) => {
      assert.equal(deviceId, "mic-a");
      return mic.stream;
    },
  );
  assert.equal(result.status, "ready");
  assert.equal(result.source, "selected");
  assert.equal(mic.wasStopped(), false);
}

// A selected-device failure falls back while the same request is still current.
{
  const request = { deviceId: "missing" };
  let current = request;
  let calls = 0;
  let primaryFailures = 0;
  const fallback = fakeStream();
  const result = await acquireMicrophoneForRequest(
    request,
    () => current,
    async (deviceId) => {
      calls += 1;
      if (deviceId === "missing") throw new Error("gone");
      assert.equal(deviceId, undefined);
      return fallback.stream;
    },
    () => { primaryFailures += 1; },
  );
  assert.equal(result.status, "ready");
  assert.equal(result.source, "fallback");
  assert.equal(calls, 2);
  assert.equal(primaryFailures, 1);
}

// A device change while the old request resolves must not put the old mic back.
{
  const request = { deviceId: "mic-a" };
  const replacement = { deviceId: "mic-b" };
  let current = request;
  const pending = deferred();
  const stale = fakeStream();

  const resultPromise = acquireMicrophoneForRequest(
    request,
    () => current,
    () => pending.promise,
  );

  current = replacement;
  pending.resolve(stale.stream);
  const result = await resultPromise;

  assert.equal(result.status, "stale");
  assert.equal(stale.wasStopped(), true, "a stale microphone stream was left live");
}

// A stale failure must not start the fallback and steal the new selection.
{
  const request = { deviceId: "mic-a" };
  const replacement = { deviceId: "mic-b" };
  let current = request;
  const pending = deferred();
  let calls = 0;

  const resultPromise = acquireMicrophoneForRequest(
    request,
    () => current,
    () => {
      calls += 1;
      return pending.promise;
    },
  );

  current = replacement;
  pending.reject(new Error("old device failed"));
  const result = await resultPromise;

  assert.equal(result.status, "stale");
  assert.equal(calls, 1, "a superseded request started a fallback");
}

// The fallback can itself become stale while its OS request is still open.
{
  const request = { deviceId: "mic-a" };
  const replacement = { deviceId: "mic-b" };
  let current = request;
  const pendingFallback = deferred();
  const staleFallback = fakeStream();
  let calls = 0;

  const resultPromise = acquireMicrophoneForRequest(
    request,
    () => current,
    async (deviceId) => {
      calls += 1;
      if (deviceId === "mic-a") throw new Error("selected failed");
      return pendingFallback.promise;
    },
  );

  await Promise.resolve();
  current = replacement;
  pendingFallback.resolve(staleFallback.stream);
  const result = await resultPromise;

  assert.equal(result.status, "stale");
  assert.equal(calls, 2);
  assert.equal(
    staleFallback.wasStopped(),
    true,
    "a stale fallback stream was left live",
  );
}

// The hook keeps the busy flag owned by the current request. An older request
// finishing is not allowed to clear it for the replacement.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const hook = readFileSync(
    join(here, "..", "src/audio/hooks/useMicrophone.ts"),
    "utf8",
  );

  const guardedFinish =
    /if \(micRequestRef\.current === request\) \{\s*micRequestRef\.current = null;\s*setIsAcquiring\(false\);\s*\}/;
  assert.match(
    hook,
    guardedFinish,
    "a superseded microphone request can clear the replacement's acquiring state",
  );

  const noConsumerCancel =
    /if \(micRequestRef\.current\) \{[\s\S]*?micRequestRef\.current = null;[\s\S]*?setIsAcquiring\(false\);[\s\S]*?\}\s*if \(!micStreamRef\.current\) return;/;
  assert.match(
    hook,
    noConsumerCancel,
    "a pending microphone request can outlive its last consumer",
  );

  const falseWrites = hook.match(/setIsAcquiring\(false\)/g) ?? [];
  assert.equal(
    falseWrites.length,
    2,
    "isAcquiring is cleared somewhere outside request completion or cancellation",
  );
}

// The connect loop must look for the stream before a just-finished request can
// shorten the busy deadline back to the idle one.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const flow = readFileSync(
    join(here, "..", "src/webrtc/hooks/sfuConnectFlow.ts"),
    "utf8",
  );
  const waitLog = flow.indexOf("No live stream yet");
  assert.notEqual(waitLog, -1, "microphone wait log moved; move this check with it");

  const loopStart = flow.indexOf("for (;;) {", waitLog);
  const timeoutBlock = flow.indexOf(
    "Microphone did not arrive within",
    loopStart,
  );
  assert.notEqual(loopStart, -1, "microphone wait loop is missing");
  assert.notEqual(timeoutBlock, -1, "microphone timeout block is missing");

  const loop = flow.slice(loopStart, timeoutBlock);
  const streamRead = loop.indexOf("microphoneBufferRef.current.processedStream");
  const deadlineRead = loop.indexOf("const deadline = micAcquiringRef.current");
  assert.ok(streamRead >= 0, "microphone wait loop no longer reads the current stream");
  assert.ok(deadlineRead >= 0, "microphone wait loop no longer reads the active deadline");
  assert.ok(
    streamRead < deadlineRead,
    "microphone wait can time out before checking a stream that just arrived",
  );
}

console.log("microphone request races: stale results discarded, fallback stays owned");
