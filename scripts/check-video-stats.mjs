/* eslint-env node */

// Feeds useVideoStats the stats report Chromium actually produces. Its outbound-rtp has no
// trackIdentifier, so every outbound row read as the camera and the debug overlay showed dashes.

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
import { useVideoStats } from "../dist/webrtc/hooks/useVideoStats.js";

function statsReport(entries) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function outbound(id, ssrc, extra) {
  return {
    id,
    type: "outbound-rtp",
    kind: "video",
    ssrc,
    bytesSent: 50_000,
    framesPerSecond: 30,
    frameWidth: 1280,
    frameHeight: 720,
    ...extra,
  };
}

const phone = fakePhonePlatform();
setVoicePlatform(phone);
const room = fakeRoom("server-a");

const engine = await mountEngine({
  provider: VoiceConfigProvider,
  runner: VoiceSingletonHooks,
  read: (enabled) => ({ sfu: useSFU(), stats: useVideoStats(enabled) }),
  config: voiceConfig({ stunHosts: ["stun:a.test"] }),
  target: { id: "server-a", room },
  probe: false,
});

await settle(() => {
  engine.current.sfu.connect("chan-a").catch(() => {});
});
await advance(1_000);
const pc = phone.peers.at(-1);
await settle(() => pc.reach("connected"));

const camera = fakeTrack("video", "camera");
const screen = fakeTrack("video", "screen");
await settle(() => {
  engine.current.sfu.addVideoTrack(camera, fakeStream(camera));
  engine.current.sfu.addScreenVideoTrack(screen, fakeStream(screen));
});

// Chromium's shape: the track id is on media-source, reached through mediaSourceId. The
// screen is listed first so the order of the report cannot be what decides.
pc.stats = statsReport([
  { id: "SV2", type: "media-source", kind: "video", trackIdentifier: screen.id },
  outbound("OT2", 2002, { mediaSourceId: "SV2", codecId: "CV9" }),
  { id: "SV1", type: "media-source", kind: "video", trackIdentifier: camera.id },
  outbound("OT1", 1001, { mediaSourceId: "SV1", codecId: "CH264" }),
  { id: "CV9", type: "codec", mimeType: "video/VP9" },
  { id: "CH264", type: "codec", mimeType: "video/H264" },
]);

await engine.update({ probe: true });
await advance(1_000);

{
  const rows = engine.current.stats.outbound;
  assert.deepEqual(
    rows.map((row) => row.label).sort(),
    ["camera", "screen"],
    "outbound rows were not told apart by their track",
  );

  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.deepEqual(
    [byId.get("OT1")?.label, byId.get("OT1")?.trackId, byId.get("OT1")?.ssrc, byId.get("OT1")?.codec],
    ["camera", camera.id, 1001, "video/H264"],
  );
  assert.deepEqual(
    [byId.get("OT2")?.label, byId.get("OT2")?.trackId, byId.get("OT2")?.ssrc, byId.get("OT2")?.codec],
    ["screen", screen.id, 2002, "video/VP9"],
  );
}

// Engines that do put trackIdentifier on outbound-rtp still resolve.
{
  pc.stats = statsReport([outbound("OT3", 3003, { trackIdentifier: screen.id })]);
  await advance(1_000);
  const [row] = engine.current.stats.outbound;
  assert.deepEqual([row?.label, row?.trackId, row?.id], ["screen", screen.id, "OT3"]);
}

// Once a second, whatever else renders. A poll that restarted on each render read the stats
// several times a second.
{
  const before = pc.statsCalls;
  for (let i = 0; i < 6; i++) {
    await engine.update({ config: voiceConfig({ stunHosts: ["stun:a.test"] }) });
    await advance(500);
  }
  assert.equal(pc.statsCalls - before, 3, "the stats poll restarted on renders that changed nothing");
}

await engine.unmount();

log("video stats: outbound rows resolved through media-source and polled once a second");
