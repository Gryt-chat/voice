/* eslint-env node */

// Microphone requests racing device changes, consumers leaving and the connect flow's wait.
// The hook half runs useMicrophone itself on a phone-shaped platform (0.5.6 broke there).

import assert from "node:assert/strict";

// First, so the fake timers and sockets are in place before any engine module loads.
import {
  advance,
  fakePhonePlatform,
  fakeRoom,
  log,
  mountEngine,
  settle,
  voiceConfig,
} from "./engine-harness.mjs";

import {
  acquireMicrophoneForRequest,
  isSameMicrophoneRequest,
} from "../dist/audio/hooks/microphoneRequest.js";
import { useMicrophone } from "../dist/audio/hooks/useMicrophone.js";
import { VoiceConfigProvider } from "../dist/config/index.js";
import { setVoicePlatform } from "../dist/platform/index.js";
import { VoiceSingletonHooks } from "../dist/shared/SingletonHooks.js";
import { useSFU } from "../dist/webrtc/hooks/useSFU.js";

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

// No request and "the platform default" are both represented with undefined.
// They are not the same state: native must start its first default-device request.
{
  assert.equal(isSameMicrophoneRequest(null, undefined), false);
  assert.equal(isSameMicrophoneRequest({ deviceId: undefined }, undefined), true);
  assert.equal(isSameMicrophoneRequest({ deviceId: "mic-a" }, "mic-a"), true);
  assert.equal(isSameMicrophoneRequest({ deviceId: "mic-a" }, "mic-b"), false);
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

// ── The hook, on a phone-shaped platform ─────────────────────────────────────

/** useMicrophone with one consumer, switched on after mount the way a call takes it. */
async function microphoneWith({ deviceId, manual = false } = {}) {
  const phone = fakePhonePlatform();
  phone.microphone.manual = manual;
  setVoicePlatform(phone);

  const engine = await mountEngine({
    provider: VoiceConfigProvider,
    runner: VoiceSingletonHooks,
    read: (wanted) => useMicrophone(wanted),
    config: voiceConfig({ deviceId }),
    target: null,
    probe: false,
  });
  await engine.update({ probe: true });
  return { phone, engine, mic: () => engine.current };
}

// No device named on a phone means the platform default. 0.5.6 read "no request in flight"
// as "the default is already in flight" and never called getUserMedia at all.
{
  const { phone, engine, mic } = await microphoneWith();
  assert.deepEqual(
    phone.microphone.requests.map((request) => request.deviceId),
    [undefined],
    "a phone with no device named never asked for the microphone",
  );
  assert.equal(mic().microphoneBuffer.processedStream, phone.microphone.requests[0].stream);
  assert.equal(mic().isAcquiring, false);
  await engine.unmount();
}

// A device change while the old request is still open. The old one finishing is stopped,
// and does not clear the busy flag the replacement owns.
{
  const { phone, engine, mic } = await microphoneWith({ deviceId: "mic-a", manual: true });
  const [first] = phone.microphone.requests;
  assert.equal(mic().isAcquiring, true);

  await engine.update({ config: voiceConfig({ deviceId: "mic-b" }) });
  const second = phone.microphone.requests[1];
  assert.equal(second?.deviceId, "mic-b", "the device change did not start its own request");

  await settle(() => first.resolve());
  assert.equal(first.stream.track.readyState, "ended", "the superseded microphone was left open");
  assert.equal(mic().isAcquiring, true, "a superseded request cleared the replacement's busy flag");
  assert.equal(mic().microphoneBuffer.processedStream, undefined, "the superseded microphone was used");

  await settle(() => second.resolve());
  assert.equal(mic().isAcquiring, false);
  assert.equal(mic().microphoneBuffer.processedStream, second.stream);
  await engine.unmount();
}

// The last consumer leaves while a request is open. The busy flag goes with it, and the
// stream that arrives later is stopped rather than kept for nobody.
{
  const { phone, engine, mic } = await microphoneWith({ deviceId: "mic-a", manual: true });
  const [pending] = phone.microphone.requests;

  await engine.update({ probe: false });
  assert.equal(mic().isAcquiring, false, "a request with no consumer left kept the busy flag");

  await settle(() => pending.resolve());
  assert.equal(pending.stream.track.readyState, "ended", "a microphone nobody wanted was left open");
  assert.equal(mic().microphoneBuffer.processedStream, undefined);
  await engine.unmount();
}

// Joining while a permission prompt is up. The request outlasts the idle wait, so the connect
// flow must keep waiting on the busy one and then use the microphone when it arrives.
{
  const phone = fakePhonePlatform();
  phone.microphone.manual = true;
  setVoicePlatform(phone);
  const room = fakeRoom("server-a");

  const engine = await mountEngine({
    provider: VoiceConfigProvider,
    runner: VoiceSingletonHooks,
    read: () => useSFU(),
    config: voiceConfig({ stunHosts: ["stun:a.test"] }),
    target: { id: "server-a", room },
  });
  await settle(() => {
    engine.current.connect("chan-a").catch(() => {});
  });

  await advance(10_000);
  assert.equal(phone.microphone.requests.length, 1);
  assert.equal(engine.current.connectionState, "connecting", "gave up while the request was still open");

  await settle(() => phone.microphone.requests[0].resolve());
  await advance(1_000);
  assert.deepEqual(room.requests, ["chan-a"], "the join never used the microphone that arrived");
  assert.equal(engine.current.connectionError, null);
  await engine.unmount();
}

log("microphone request races: stale results stopped, busy flag owned, phones ask for the default");
