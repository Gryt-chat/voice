/* eslint-env node */

// The client's camera effect listed useSFU's getters, which were new on every render, and each run
// replaced the camera's track with itself. That held a camera on a thin link at 1080p (GRYT-1333).

import assert from "node:assert/strict";
import { useEffect } from "react";

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

const GETTERS = ["getPeerConnection", "getScreenVideoSender", "getCameraSenderTrackId", "getScreenSenderTrackId"];

const phone = fakePhonePlatform();
setVoicePlatform(phone);
const room = fakeRoom("server-a");
let effectRuns = 0;

const engine = await mountEngine({
  provider: VoiceConfigProvider,
  runner: VoiceSingletonHooks,
  read: () => {
    const sfu = useSFU();
    // Shaped like the client's camera effect, which listed getPeerConnection.
    useEffect(() => {
      effectRuns += 1;
    }, GETTERS.map((name) => sfu[name]));
    return sfu;
  },
  config: voiceConfig({ stunHosts: ["stun:a.test"] }),
  target: { id: "server-a", room },
});

await settle(() => {
  engine.current.connect("chan-a").catch(() => {});
});
await advance(1_000);
const pc = phone.peers.at(-1);
await settle(() => pc.reach("connected"));
const sfu = () => engine.current;

// Renders that change nothing hand out the same getters, so an effect listing them stays put.
{
  const before = Object.fromEntries(GETTERS.map((name) => [name, sfu()[name]]));
  const runs = effectRuns;
  for (let i = 0; i < 5; i++) {
    await engine.update({ config: voiceConfig({ stunHosts: ["stun:a.test"] }) });
  }
  for (const name of GETTERS) assert.equal(sfu()[name], before[name], `${name} changed on a render`);
  assert.equal(effectRuns, runs, "an effect listing the getters re-ran on renders that changed nothing");
  assert.equal(sfu().getPeerConnection(), pc, "a stable getter has to read the live connection");
}

// Adding the camera again with the track it already sends replaces nothing.
const camera = fakeTrack("video", "camera");
await settle(() => sfu().addVideoTrack(camera, fakeStream(camera)));
const cameraSender = pc.getSenders().find((sender) => sender.track === camera);
assert.ok(cameraSender, "the camera never reached a sender");
for (let i = 0; i < 4; i++) {
  await settle(() => sfu().addVideoTrack(camera, fakeStream(camera)));
}
assert.equal(cameraSender.replaces, 0, "the camera's track was replaced with itself");
assert.equal(pc.getSenders().length, 2, "adding the camera again made another sender");

// A new track, which is what a quality change opens, is swapped in once.
const reopened = fakeTrack("video", "camera");
await settle(() => sfu().addVideoTrack(reopened, fakeStream(reopened)));
assert.equal(cameraSender.replaces, 1);
assert.equal(cameraSender.track, reopened);
assert.equal(sfu().getCameraSenderTrackId(), reopened.id, "the getter read a stale track");

// A codec change on the same track still asks the SFU for a new offer, and replaces nothing.
{
  const socket = FakeSocket.all.at(-1);
  const offers = () => socket.sent.filter((message) => message.event === "renegotiate").length;
  const before = offers();
  await settle(() => sfu().addVideoTrack(reopened, fakeStream(reopened), "vp9"));
  await advance(500);
  assert.equal(offers(), before + 1, "a codec change on the same track did not renegotiate");
  assert.equal(cameraSender.replaces, 1);
}

// The screen share's sender works the same way, and a stopped share still gets its next track.
{
  const screen = fakeTrack("video", "screen");
  await settle(() => sfu().addScreenVideoTrack(screen, fakeStream(screen)));
  const screenSender = sfu().getScreenVideoSender();
  assert.equal(screenSender?.track, screen);
  for (let i = 0; i < 4; i++) {
    await settle(() => sfu().addScreenVideoTrack(screen, fakeStream(screen)));
  }
  assert.equal(screenSender.replaces, 0, "the screen's track was replaced with itself");

  await settle(() => sfu().removeScreenVideoTrack());
  assert.equal(screenSender.track, null);
  const next = fakeTrack("video", "screen");
  await settle(() => sfu().addScreenVideoTrack(next, fakeStream(next)));
  assert.equal(screenSender.track, next, "the next share did not go out on the paused sender");
  assert.equal(screenSender.replaces, 2);
  assert.equal(sfu().getScreenSenderTrackId(), next.id);
}

await engine.unmount();

log("camera resync: getters stable across renders, and a track is only replaced by a different one");
