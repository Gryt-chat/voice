/* eslint-env node */

// Each role has to go out on one of the m-lines the SFU offered, one of its own. A camera paused
// before its renegotiation landed gave its slot to the share, and #67's own m-lines never sent (GRYT-1337).

import assert from "node:assert/strict";

// First, so the fake timers and sockets are in place before any engine module loads.
import {
  advance,
  answered,
  FakeSocket,
  fakePhonePlatform,
  fakeRoom,
  fakeStream,
  fakeTrack,
  log,
  mountEngine,
  settle,
  voiceConfig,
} from "./engine-harness.mjs";

import { VoiceConfigProvider } from "../dist/config/index.js";
import { setVoicePlatform } from "../dist/platform/index.js";
import { VoiceSingletonHooks } from "../dist/shared/SingletonHooks.js";
import { useSFU } from "../dist/webrtc/hooks/useSFU.js";

const phone = fakePhonePlatform();
setVoicePlatform(phone);

async function call() {
  const engine = await mountEngine({
    provider: VoiceConfigProvider,
    runner: VoiceSingletonHooks,
    read: () => useSFU(),
    config: voiceConfig({ stunHosts: ["stun:a.test"] }),
    target: { id: "server-a", room: fakeRoom("server-a") },
  });
  await settle(() => {
    engine.current.connect("chan-a").catch(() => {});
  });
  await advance(1_000);
  const pc = phone.peers.at(-1);
  await settle(() => pc.reach("connected"));
  assert.equal(engine.current.connectionState, "connected", "the call never came up");
  const socket = FakeSocket.all.at(-1);
  assert.equal(answered(socket).length, 4, "the SFU's first offer was never answered");

  const streams = new Map();
  const stream = (track) => streams.get(track) ?? streams.set(track, fakeStream(track)).get(track);
  const on = {
    camera: (track) => settle(() => engine.current.addVideoTrack(track, stream(track))),
    screen: (track) => settle(() => engine.current.addScreenVideoTrack(track, stream(track))),
    screenAudio: (track) => settle(() => engine.current.addScreenAudioTrack(track, stream(track))),
  };
  const off = {
    camera: () => settle(() => engine.current.removeVideoTrack()),
    screen: () => settle(() => engine.current.removeScreenVideoTrack()),
    screenAudio: () => settle(() => engine.current.removeScreenAudioTrack()),
  };
  const midOf = (track) => pc.getTransceivers().find((t) => t.sender.track === track)?.mid;
  /** What the SFU is told a mid carries, from the last answer. */
  const wire = (mid) => answered(socket).find((line) => line.mid === mid);
  return { engine, pc, socket, stream, on, off, midOf, wire };
}

// ---- the camera alone goes out on the SFU's first video slot, under its own stream ----
{
  const { engine, pc, stream, on, midOf, wire } = await call();
  const camera = fakeTrack("video", "camera");
  await on.camera(camera);
  assert.equal(midOf(camera), "1", "the camera is not on the SFU's first video slot");
  assert.equal(wire("1").direction, "sendonly", "the answer does not send the camera");
  assert.equal(wire("1").stream, stream(camera).id, "the camera went out under another stream id");
  assert.equal(pc.getTransceivers().length, 4, "the camera made an m-line of its own");
  await engine.unmount();
}

// ---- the bug: camera off before its renegotiation lands, then a share ----
for (const [first, second] of [["camera", "screen"], ["screen", "camera"]]) {
  const { engine, pc, socket, stream, on, off, midOf, wire } = await call();
  socket.hold = true;
  const a = fakeTrack("video", first);
  await on[first](a);
  const slotA = pc.getTransceivers().find((t) => t.sender.track === a);
  await off[first]();
  const b = fakeTrack("video", second);
  await on[second](b);
  socket.release();
  await advance(100);

  assert.ok(midOf(b), `the ${second} is on an m-line the SFU never offered`);
  assert.notEqual(midOf(b), slotA?.mid, `the ${second} took the paused ${first}'s slot`);
  assert.equal(wire(midOf(b)).stream, stream(b).id, `the ${second} went out under another stream id`);
  assert.equal(wire(slotA.mid).stream, stream(a).id, `the paused ${first}'s slot lost its stream id`);

  const back = fakeTrack("video", first);
  await on[first](back);
  await advance(100);
  assert.equal(midOf(back), slotA.mid, `the ${first} came back somewhere other than its own slot`);
  assert.equal(pc.getTransceivers().find((t) => t.mid === midOf(b)).sender.track, b, `the ${first} coming back took the ${second} off the wire`);
  assert.equal(wire(slotA.mid).stream, stream(a).id, `the ${first} came back under a new stream id`);
  assert.equal(pc.getTransceivers().length, 4, "a role made an m-line of its own");
  await engine.unmount();
}

// ---- toggling grows nothing, and screen audio keeps off the microphone's m-line ----
{
  const { engine, pc, stream, on, off, midOf, wire } = await call();
  let camera;
  for (let i = 0; i < 10; i++) {
    camera = fakeTrack("video", "camera");
    await on.camera(camera);
    await off.camera();
  }
  await on.camera(camera);
  let screen;
  let screenAudio;
  const shares = [];
  for (let i = 0; i < 5; i++) {
    screen = fakeTrack("video", "screen");
    screenAudio = fakeTrack("audio", "screen");
    shares.push(screen);
    await on.screen(screen);
    await on.screenAudio(screenAudio);
    await off.screen();
    await off.screenAudio();
  }
  await on.screen(screen);
  await on.screenAudio(screenAudio);
  await advance(100);
  assert.equal(pc.getTransceivers().length, 4, "toggling made new m-lines");
  assert.deepEqual([midOf(camera), midOf(screen), midOf(screenAudio)], ["1", "2", "3"], "a role moved slot");
  assert.notEqual(wire("0").stream, wire("3").stream, "screen audio went out on the microphone's m-line");
  assert.ok(pc.getTransceivers().every((t) => t.mid !== null), "a transceiver sits outside the SFU's offer");
  // A resumed slot keeps the stream it first went out under, which is the id the client announces.
  assert.equal(wire("2").stream, stream(shares[0]).id, "the share's slot changed stream id");
  await engine.unmount();
}

// ---- tracks the SFU forwards arrive on sendonly m-lines, and nothing is published on those ----
{
  const { engine, pc, socket, on, midOf, wire } = await call();
  socket.forwarded = ["video", "video"];
  socket.offer();
  await advance(100);
  const screen = fakeTrack("video", "screen");
  const camera = fakeTrack("video", "camera");
  await on.screen(screen);
  await on.camera(camera);
  await advance(100);
  assert.ok(["1", "2"].includes(midOf(screen)) && ["1", "2"].includes(midOf(camera)), "a role went out on a forwarded m-line");
  assert.notEqual(midOf(screen), midOf(camera));
  assert.equal(wire("4").direction, "recvonly");
  assert.equal(pc.getTransceivers().length, 6);
  await engine.unmount();
}

log("sfu slots: each role on an SFU slot of its own, kept across pauses, toggles and a held renegotiation");
