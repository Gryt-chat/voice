/* eslint-env node */

// Drives a call on one server through recovery while another server is on screen. Recovery
// followed the server on screen, lost its STUN list, and rejoined calls it had given up on.

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

import { useMicrophone } from "../dist/audio/hooks/useMicrophone.js";
import { VoiceConfigProvider } from "../dist/config/index.js";
import { setVoicePlatform } from "../dist/platform/index.js";
import { VoiceSingletonHooks } from "../dist/shared/SingletonHooks.js";
import { useSFU } from "../dist/webrtc/hooks/useSFU.js";

const A_STUN = [{ urls: ["stun:a.test"] }];

/** A connected call on server A. `view` is what is on screen afterwards, and its STUN list. */
async function callOnA({ view = "b", viewStun = [] } = {}) {
  const phone = fakePhonePlatform();
  setVoicePlatform(phone);
  const rooms = { a: fakeRoom("server-a"), b: fakeRoom("server-b") };
  const targets = {
    a: { id: "server-a", room: rooms.a },
    b: { id: "server-b", room: rooms.b },
  };

  const engine = await mountEngine({
    provider: VoiceConfigProvider,
    runner: VoiceSingletonHooks,
    read: () => ({ sfu: useSFU(), mic: useMicrophone(false) }),
    config: voiceConfig({ stunHosts: ["stun:a.test"] }),
    target: targets.a,
  });

  await settle(() => {
    engine.current.sfu.connect("chan-a").catch(() => {});
  });
  await advance(1_000);
  await settle(() => phone.peers.at(-1).reach("connected"));
  assert.equal(engine.current.sfu.connectionState, "connected", "the call never came up");

  if (view === "b") {
    await engine.update({ target: targets.b, config: voiceConfig({ stunHosts: viewStun }) });
  }

  return {
    phone,
    rooms,
    engine,
    sfu: () => engine.current.sfu,
    dropSfu: () => settle(() => FakeSocket.all.at(-1).drop()),
  };
}

// A live call stays with its server. Server B coming back is none of its business, and
// server A coming back re-announces the call on A without touching the media.
{
  const { phone, rooms, engine, sfu } = await callOnA();
  assert.equal(rooms.b.listening, 0, "the server on screen took over the call's reconnect events");

  await settle(() => rooms.b.reconnect());
  await advance(10_000);
  assert.deepEqual(rooms.b.requests, [], "a reconnect of the server on screen reached the call");

  await settle(() => rooms.a.reconnect());
  await advance(10_000);
  assert.deepEqual(rooms.a.requests, ["chan-a", "chan-a"], "the call was not re-announced on its server");
  assert.deepEqual(rooms.a.joined, [true, true]);
  assert.deepEqual(rooms.b.requests, []);
  assert.equal(phone.peers.length, 1, "re-announcing rebuilt the media connection");
  assert.equal(sfu().connectionState, "connected");
  await engine.unmount();
}

// The SFU drops while B is on screen, and B has no STUN list yet. The retry goes back to A
// with A's list; it used to throw on B's empty one and sit on RECONNECTING with the mic open.
{
  const { phone, rooms, engine, sfu, dropSfu } = await callOnA();
  await dropSfu();
  await advance(2_000);

  assert.equal(phone.peers.length, 2, `the retry never reached a peer connection (${sfu().connectionState})`);
  assert.deepEqual(phone.peers[1].config.iceServers, A_STUN, "the retry used the wrong STUN list");
  assert.deepEqual(rooms.a.requests, ["chan-a", "chan-a"]);
  assert.deepEqual(rooms.b.requests, [], "the retry asked the server on screen for a room");

  await settle(() => phone.peers[1].reach("connected"));
  assert.equal(sfu().connectionState, "connected");
  assert.equal(sfu().currentServerConnected, "server-a");
  await engine.unmount();
}

// Signalling was down when the SFU dropped, so the engine waits for it. When A comes back,
// the full reconnect goes to A with A's list.
{
  const { phone, rooms, engine, sfu, dropSfu } = await callOnA();
  rooms.a.connected = false;
  await dropSfu();
  await advance(5_000);
  assert.equal(sfu().connectionState, "reconnecting");
  assert.equal(phone.peers.length, 1, "retried the SFU while signalling was down");

  await settle(() => rooms.a.reconnect());
  await advance(1_000);
  assert.equal(phone.peers.length, 2, `no reconnect after signalling came back (${sfu().connectionState})`);
  assert.deepEqual(phone.peers[1].config.iceServers, A_STUN);
  assert.deepEqual(rooms.b.requests, []);
  await engine.unmount();
}

// The same, but the person hangs up in the half second before that reconnect. They stay out.
{
  const { phone, rooms, engine, sfu, dropSfu } = await callOnA();
  rooms.a.connected = false;
  await dropSfu();
  await advance(5_000);

  await settle(() => rooms.a.reconnect());
  await advance(100);
  await settle(() => {
    sfu().disconnect();
  });
  await advance(5_000);
  assert.equal(phone.peers.length, 1, "a reconnect scheduled before the hang-up rejoined the call");
  assert.deepEqual(rooms.a.requests, ["chan-a"]);
  assert.equal(sfu().connectionState, "disconnected");
  await engine.unmount();
}

// A comes back and refuses the re-announce three times, so the engine rebuilds the call.
// That rebuild goes to A as well.
{
  const { phone, rooms, engine, sfu } = await callOnA();
  rooms.a.refusals = 3;
  await settle(() => rooms.a.reconnect());
  await advance(10_000);

  assert.equal(phone.peers.length, 2, `the fallback never reached a peer connection (${sfu().connectionState})`);
  assert.deepEqual(phone.peers[1].config.iceServers, A_STUN);
  assert.deepEqual(rooms.a.requests, Array(5).fill("chan-a"));
  assert.deepEqual(rooms.b.requests, []);
  await engine.unmount();
}

// A refuses every retry until the engine gives up. Giving up is leaving: B reconnecting
// afterwards used to put this person back in A's channel with the microphone live.
{
  const { phone, rooms, engine, sfu, dropSfu } = await callOnA({ viewStun: ["stun:b.test"] });
  rooms.a.refusals = Infinity;
  await dropSfu();
  await advance(60_000);

  assert.equal(sfu().connectionState, "disconnected");
  assert.equal(sfu().connectionError, "reconnect-failed");
  const attempts = rooms.a.requests.length;
  assert.equal(attempts, 6, "expected the first join and five retries");
  const [mic] = phone.microphone.requests;
  assert.equal(mic.stream.track.readyState, "ended", "the microphone stayed open after giving up");

  rooms.a.refusals = 0;
  await settle(() => rooms.b.reconnect());
  await advance(10_000);
  assert.equal(rooms.a.requests.length, attempts, "a reconnect of the server on screen rejoined the dead call");
  assert.deepEqual(rooms.b.requests, []);
  assert.equal(phone.microphone.requests.length, 1, "the microphone was opened again");
  assert.equal(sfu().connectionState, "disconnected");
  await engine.unmount();
}

// The same while A itself is on screen: A coming back does not rejoin either.
{
  const { phone, rooms, engine, sfu, dropSfu } = await callOnA({ view: "a" });
  rooms.a.refusals = Infinity;
  await dropSfu();
  await advance(60_000);
  assert.equal(sfu().connectionError, "reconnect-failed");
  const attempts = rooms.a.requests.length;

  rooms.a.refusals = 0;
  await settle(() => rooms.a.reconnect());
  await advance(10_000);
  assert.equal(rooms.a.requests.length, attempts, "the server it gave up on rejoined the call when it came back");
  assert.equal(phone.microphone.requests.length, 1);
  assert.equal(sfu().connectionState, "disconnected");
  await engine.unmount();
}

log("active call target: recovery stays on the call's server with its STUN list, and giving up is leaving");
