/* eslint-env node */

// A room request the server refuses for good ends the call with its reason, once. It used to go
// to recovery and ask five more times over 30 seconds, then blame the network (GRYT-1476).

import assert from "node:assert/strict";

// First, so the fake timers and sockets are in place before any engine module loads.
import { advance, fakePhonePlatform, fakeRoom, log, mountEngine, settle, voiceConfig } from "./engine-harness.mjs";

import { VoiceConfigProvider } from "../dist/config/index.js";
import { setVoicePlatform } from "../dist/platform/index.js";
import { VoiceSingletonHooks } from "../dist/shared/SingletonHooks.js";
import { useSFU } from "../dist/webrtc/hooks/useSFU.js";

async function engineOn(room) {
  const phone = fakePhonePlatform();
  setVoicePlatform(phone);
  const seen = [];
  const engine = await mountEngine({
    provider: VoiceConfigProvider,
    runner: VoiceSingletonHooks,
    read: () => {
      const sfu = useSFU();
      seen.push(sfu.connectionState);
      return sfu;
    },
    config: voiceConfig({ stunHosts: ["stun:a.test"] }),
    target: { id: "server-a", room },
  });
  return { phone, engine, seen, sfu: () => engine.current };
}

async function join(sfu, channel) {
  const result = { error: null };
  await settle(() => {
    sfu().connect(channel).catch((error) => {
      result.error = error;
    });
  });
  await advance(1_000);
  return result;
}

// The codes the Gryt server refuses with and means it. What they say is the embedder's business.
for (const reason of ["forbidden", "not_found", "contact_refused", "unauthenticated", "server_full"]) {
  const room = fakeRoom("server-a");
  room.refusals = Infinity;
  room.refusal = { reason };
  const { phone, engine, seen, sfu } = await engineOn(room);

  const joined = await join(sfu, "chan-a");
  await advance(60_000);

  assert.ok(joined.error, `${reason}: connect resolved on a refusal`);
  assert.equal(joined.error.message, `Room access denied: ${reason}`);
  assert.equal(room.requests.length, 1, `${reason}: asked ${room.requests.length} times`);
  assert.equal(sfu().connectionState, "disconnected", `${reason}: ended in ${sfu().connectionState}`);
  assert.equal(sfu().connectionError, reason, `${reason}: reported ${sfu().connectionError}`);
  assert.ok(!seen.includes("failed") && !seen.includes("reconnecting"), `${reason}: went through ${[...new Set(seen)]}`);
  assert.equal(phone.peers.length, 0, `${reason}: built a peer connection for a refused room`);

  // Signalling coming back is not a reason to ask for a room that was refused.
  await settle(() => room.reconnect());
  await advance(10_000);
  assert.equal(room.requests.length, 1, `${reason}: asked again after signalling came back`);
  await engine.unmount();
}

// A refusal that says when to ask again is a hiccup, and recovery keeps asking until it is let in.
for (const reason of ["unidentified", "rate_limited", "unavailable"]) {
  const room = fakeRoom("server-a");
  room.refusals = 2;
  room.refusal = { reason, retryAfterMs: 2000 };
  const { phone, engine, sfu } = await engineOn(room);

  await join(sfu, "chan-a");
  await advance(20_000);

  assert.equal(room.requests.length, 3, `${reason}: asked ${room.requests.length} times`);
  assert.equal(phone.peers.length, 1, `${reason}: never got to a peer connection`);
  await settle(() => phone.peers.at(-1).reach("connected"));
  assert.equal(sfu().connectionState, "connected");
  await engine.unmount();
}

// A network failure after the grant is still recovered, with the room asked for again.
{
  const room = fakeRoom("server-a");
  const { phone, engine, seen, sfu } = await engineOn(room);
  await join(sfu, "chan-a");
  await settle(() => phone.peers.at(-1).reach("connected"));
  assert.equal(sfu().connectionState, "connected");

  seen.length = 0;
  await settle(() => phone.peers.at(-1).reach("failed"));
  await advance(10_000);

  assert.ok(seen.includes("reconnecting"), `a failed peer connection did not recover: ${[...new Set(seen)]}`);
  assert.equal(room.requests.length, 2, `asked ${room.requests.length} times`);
  assert.equal(phone.peers.length, 2, "no new peer connection after the failure");
  await settle(() => phone.peers.at(-1).reach("connected"));
  assert.equal(sfu().connectionState, "connected");
  await engine.unmount();
}

// Refused for good while re-announcing a live call, say the channel went, and the call ends.
{
  const room = fakeRoom("server-a");
  const { phone, engine, sfu } = await engineOn(room);
  await join(sfu, "chan-a");
  await settle(() => phone.peers.at(-1).reach("connected"));

  room.refusals = Infinity;
  room.refusal = { reason: "not_found" };
  await settle(() => room.reconnect());
  await advance(30_000);

  assert.equal(sfu().connectionState, "disconnected", `ended in ${sfu().connectionState}`);
  assert.equal(sfu().connectionError, "not_found");
  // The re-announce, and the one full reconnect it falls back to.
  assert.equal(room.requests.length, 3, `asked ${room.requests.length} times`);
  await engine.unmount();
}

log("room refusals: a refusal without retryAfterMs ends the call once with its reason; the rest still retry");
