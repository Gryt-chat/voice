/* eslint-env node */

// Signalling comes back and finds the SFU dead, so the engine tears the call down and rejoins.
// That passed through DISCONNECTED, which the client reads as leaving, and it stopped the camera.

import assert from "node:assert/strict";

// First, so the fake timers and sockets are in place before any engine module loads.
import {
  advance,
  FakeSocket,
  fakePhonePlatform,
  fakeRoom,
  log,
  mountEngine,
  settle,
  voiceConfig,
} from "./engine-harness.mjs";

import { VoiceConfigProvider } from "../dist/config/index.js";
import { setVoicePlatform } from "../dist/platform/index.js";
import { VoiceSingletonHooks } from "../dist/shared/SingletonHooks.js";
import { useSFU } from "../dist/webrtc/hooks/useSFU.js";

/** A connected call, and every state and server the engine reported from then on. */
async function connectedCall() {
  const phone = fakePhonePlatform();
  setVoicePlatform(phone);
  const room = fakeRoom("server-a");
  const seen = [];

  const engine = await mountEngine({
    provider: VoiceConfigProvider,
    runner: VoiceSingletonHooks,
    read: () => {
      const sfu = useSFU();
      seen.push({ state: sfu.connectionState, server: sfu.currentServerConnected });
      return sfu;
    },
    config: voiceConfig({ stunHosts: ["stun:a.test"] }),
    target: { id: "server-a", room },
  });

  await settle(() => {
    engine.current.connect("chan-a").catch(() => {});
  });
  await advance(1_000);
  await settle(() => phone.peers.at(-1).reach("connected"));
  assert.equal(engine.current.connectionState, "connected", "the call never came up");
  seen.length = 0;

  return { phone, room, engine, seen, sfu: () => engine.current };
}

const states = (seen) => [...new Set(seen.map((s) => s.state))];

// The server restarts and the SFU went with it: the socket is gone before anything noticed.
{
  const { phone, room, engine, seen, sfu } = await connectedCall();
  FakeSocket.all.at(-1).close();
  await settle(() => room.reconnect());
  await advance(1_000);

  assert.equal(phone.peers.length, 2, `no full reconnect (${sfu().connectionState})`);
  await settle(() => phone.peers.at(-1).reach("connected"));
  assert.equal(sfu().connectionState, "connected");

  assert.ok(!states(seen).includes("disconnected"), `a recovery reported the call ended: ${states(seen)}`);
  assert.ok(states(seen).includes("reconnecting"), `a recovery did not say it was reconnecting: ${states(seen)}`);
  assert.ok(seen.every((s) => s.server === "server-a"), "a recovery forgot which server the call is on");
  await engine.unmount();
}

// The SFU is alive, but the server refuses the re-announce three times, so the engine rebuilds.
{
  const { phone, room, engine, seen, sfu } = await connectedCall();
  room.refusals = 3;
  await settle(() => room.reconnect());
  await advance(10_000);

  assert.equal(phone.peers.length, 2, `the fallback never reached a peer connection (${sfu().connectionState})`);
  assert.ok(!states(seen).includes("disconnected"), `the fallback reported the call ended: ${states(seen)}`);
  await engine.unmount();
}

// Hanging up in the half second before the rejoin is still leaving.
{
  const { phone, room, engine, sfu } = await connectedCall();
  FakeSocket.all.at(-1).close();
  await settle(() => room.reconnect());
  await advance(100);
  assert.equal(sfu().connectionState, "reconnecting");

  await settle(() => {
    sfu().disconnect();
  });
  await advance(5_000);
  assert.equal(sfu().connectionState, "disconnected");
  assert.equal(sfu().currentServerConnected, "");
  assert.equal(phone.peers.length, 1, "the rejoin went ahead after a hang-up");
  await engine.unmount();
}

log("recovery disconnect: a rejoin after signalling returns reports RECONNECTING, and a hang-up still ends the call");
