/* eslint-env node */

// Turns one video role off before its first renegotiation lands, then starts the other. addTrack
// would hand the second role the first one's sender, and both would sit on one m-line (GRYT-1337).

import assert from "node:assert/strict";

// First, so the fake timers and sockets are in place before any engine module loads.
import {
  advance,
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

const video = () => pc.senders.filter((sender) => sender.kind === "video");
const cameraOn = (track) => settle(() => engine.current.addVideoTrack(track, fakeStream(track)));
const cameraOff = () => settle(() => engine.current.removeVideoTrack());
const shareOn = (track) => settle(() => engine.current.addScreenVideoTrack(track, fakeStream(track)));
const shareOff = () => settle(() => engine.current.removeScreenVideoTrack());

// ---- camera first: on, off, then a share, all inside one round trip to the SFU ----
const camera = fakeTrack("video", "camera");
await cameraOn(camera);
const cameraSender = video().at(-1);
assert.equal(cameraSender.track, camera, "the camera never reached a sender");

await cameraOff();
assert.equal(cameraSender.track, null, "turning the camera off left its track on the sender");

const share = fakeTrack("video", "screen");
await shareOn(share);
const shareSender = engine.current.getScreenVideoSender();
assert.notEqual(shareSender, cameraSender, "the share took over the camera's paused sender");
assert.equal(video().length, 2, "the camera and the share are sharing one m-line");
assert.equal(shareSender.track, share, "the share never reached its own sender");

// The stream each sender was made with is the id the apps announce for that role, and
// replaceTrack leaves it alone. Two roles on one sender means one of them announced a stranger.
assert.equal(cameraSender.stream.id, fakeStream(camera).id, "the camera's sender changed stream");
assert.equal(shareSender.stream.id, fakeStream(share).id, "the share's sender changed stream");

const backAgain = fakeTrack("video", "camera");
await cameraOn(backAgain);
assert.equal(cameraSender.track, backAgain, "the camera came back on something other than its sender");
assert.equal(shareSender.track, share, "the camera coming back took the share's track off the wire");
assert.equal(video().length, 2, "the camera coming back made a third m-line");

// ---- share first: the same two moves the other way round ----
await shareOff();
await cameraOff();
const secondCamera = fakeTrack("video", "camera");
await cameraOn(secondCamera);
assert.equal(cameraSender.track, secondCamera, "the camera did not resume on its own sender");
assert.equal(video().length, 2, "a second round made another m-line");

const secondShare = fakeTrack("video", "screen");
await shareOn(secondShare);
assert.equal(engine.current.getScreenVideoSender(), shareSender, "the share did not resume on its own sender");
assert.equal(cameraSender.track, secondCamera, "the share landed on the camera's sender");
assert.equal(video().length, 2, "a second round made another m-line");

await engine.unmount();

log("transceiver reuse: the camera and the screen keep separate m-lines across a held renegotiation");
