/* eslint-env node */

// Turns a camera off and on through the engine, around a screen share. A camera that came back
// got a new sender, which took the screen's m-line, so the share never reached the SFU (GRYT-1329).

import assert from "node:assert/strict";

// First, so the fake timers and sockets are in place before any engine module loads.
import {
  advance,
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
await advance(1_000);
const pc = phone.peers.at(-1);
await settle(() => pc.reach("connected"));
assert.equal(engine.current.connectionState, "connected", "the call never came up");

const added = [];
const removed = [];
// Published with addTransceiver rather than addTrack, so a paused sender is never reused
// for another role (GRYT-1337).
const addTransceiver = pc.addTransceiver.bind(pc);
pc.addTransceiver = (track, init) => {
  added.push(track.id);
  return addTransceiver(track, init);
};
const removeTrack = pc.removeTrack.bind(pc);
pc.removeTrack = (sender) => {
  removed.push(sender.track?.id ?? null);
  removeTrack(sender);
};
const renegotiations = () => FakeSocket.all.at(-1).sent.filter((message) => message.event === "renegotiate").length;

const camera = () => pc.senders.find((sender) => sender.role === "camera");
const cameraOn = (track) => settle(() => engine.current.addVideoTrack(track, fakeStream(track)));
const cameraOff = () => settle(() => engine.current.removeVideoTrack());

const first = fakeTrack("video", "camera");
await cameraOn(first);
pc.senders.at(-1).role = "camera";
assert.deepEqual(added, [first.id], "the first camera track was not added");
const offersAfterFirst = renegotiations();
assert.equal(offersAfterFirst, 1, "a new camera sender has to ask the SFU for an offer");

await cameraOff();
assert.deepEqual(removed, [], "turning the camera off removed its sender, and the next one takes another m-line");
assert.ok(camera(), "the camera's sender is gone");
assert.equal(camera().track, null, "turning the camera off left its track on the sender");
assert.equal(renegotiations(), offersAfterFirst, "pausing the camera renegotiated, which changes nothing in the SDP");

const again = fakeTrack("video", "camera");
await cameraOn(again);
assert.deepEqual(added, [first.id], "the camera came back on a new sender instead of its own");
assert.equal(camera().track, again, "the camera came back without its track on the sender");
assert.equal(renegotiations(), offersAfterFirst, "resuming the camera renegotiated, which changes nothing in the SDP");

// A share after that gets a sender of its own, and a second round reuses both.
const share = fakeTrack("video", "screen");
await settle(() => engine.current.addScreenVideoTrack(share, fakeStream(share)));
assert.deepEqual(added, [first.id, share.id], "the screen share did not get a sender of its own");

await settle(() => engine.current.removeScreenVideoTrack());
await cameraOff();
const third = fakeTrack("video", "camera");
const secondShare = fakeTrack("video", "screen");
await cameraOn(third);
await settle(() => engine.current.addScreenVideoTrack(secondShare, fakeStream(secondShare)));
assert.deepEqual(added, [first.id, share.id], "a second round made new senders");
assert.deepEqual(removed, [], "a second round removed a sender");
assert.equal(camera().track, third, "the camera's sender did not carry the third track");

await engine.unmount();

log("camera sender: paused when the camera goes off, and the same one carries it when it comes back");
