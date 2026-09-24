/* eslint-env node */

// Sending video at the size viewers draw it (GRYT-1432): the rule on its own clock, then the
// engine against a fake SFU, including one that never sends video_wanted.

import assert from "node:assert/strict";

// First, so the fake timers and sockets are in place before any engine module loads.
import {
  advance,
  FakeSocket,
  fakePhonePlatform,
  fakeRoom,
  fakeStream,
  fakeTrack,
  mountEngine,
  settle,
  voiceConfig,
} from "./engine-harness.mjs";

import { VoiceConfigProvider } from "../dist/config/index.js";
import { setVoicePlatform } from "../dist/platform/index.js";
import { VoiceSingletonHooks } from "../dist/shared/SingletonHooks.js";
import {
  cameraBitrate,
  HOLD_DOWN_MS,
  INITIAL_PLAN_STATE,
  MAX_REKICKS,
  PAUSE_AFTER_MS,
  planVideoEncoding,
  RESUME_CHECK_MS,
  rungFor,
  screenBitrate,
} from "../dist/webrtc/hooks/videoDemand.js";
import { useSFU } from "../dist/webrtc/hooks/useSFU.js";

// ── The rule ─────────────────────────────────────────────────────────────────

const HD = { width: 1920, height: 1080 };
const wanted = (width, height, { fps = 60, watchers = 1, unknown = 0 } = {}) => ({ width, height, fps, watchers, unknown });

/** Runs the plan from `start` over a list of [ms from start, wanted, framesEncoded] steps. */
function run(steps, { role = "camera", settings = {}, source = HD } = {}) {
  let state = INITIAL_PLAN_STATE;
  const plans = [];
  for (const [now, w, frames = null] of steps) {
    const plan = planVideoEncoding({ role, source, settings, wanted: w, now, framesEncoded: frames }, state);
    state = plan.state;
    plans.push(plan);
  }
  return plans;
}

// An SFU that never says anything leaves the encoding exactly as the settings ask.
{
  const settings = { maxSize: { width: 1280, height: 720 }, maxFramerate: 30, maxBitrate: 3_000_000 };
  const [plan] = run([[0, null]], { role: "screen", settings });
  assert.deepEqual(
    { active: plan.active, scale: plan.scaleResolutionDownBy, maxBitrate: plan.maxBitrate, maxFramerate: plan.maxFramerate },
    { active: true, scale: 1.5, maxBitrate: 3_000_000, maxFramerate: 30 },
    "with no video_wanted the encoding moved away from the settings",
  );
  const later = run([[0, null], [60_000, null]], { settings: {} }).at(-1);
  assert.equal(later.active, true, "an old SFU's silence paused the stream");
  assert.equal(later.maxBitrate, undefined, "an old SFU's silence capped a camera that had no cap");
}

// The ladder: the largest scale that still covers the wanted size, never above the source.
assert.equal(rungFor(HD, { width: 640, height: 360 }), 3);
assert.equal(rungFor(HD, { width: 700, height: 394 }), 2);
assert.equal(rungFor(HD, { width: 2560, height: 1440 }), 1);
assert.equal(rungFor(HD, { width: 100, height: 56 }), 8);
assert.equal(rungFor(HD, { width: 320, height: 192 }), 6, "a 180p tile, rounded up to 192, didn't get 180p");

// Up at once, down only after five seconds at the lower rung.
{
  const plans = run([
    [0, wanted(1920, 1080)],
    [1_000, wanted(640, 360)],
    [1_000 + HOLD_DOWN_MS - 1, wanted(640, 360)],
    [1_000 + HOLD_DOWN_MS, wanted(640, 360)],
    [7_000, wanted(1920, 1080)],
  ]);
  assert.deepEqual(plans.map((p) => p.scaleResolutionDownBy), [1, 1, 1, 3, 1], "the size didn't hold on the way down or went up late");
}

// A shrunk camera carries a bitrate to match, since Chrome keeps its 2.5 Mbps target otherwise.
{
  const plans = run([[0, wanted(640, 360, { fps: 30 })], [HOLD_DOWN_MS, wanted(640, 360, { fps: 30 })]]);
  assert.equal(plans[0].maxBitrate, undefined, "a camera drawn at full size got a cap it doesn't have today");
  assert.equal(plans[1].maxBitrate, cameraBitrate(640, 360, 30));
  const sixty = run([[0, wanted(640, 360)], [HOLD_DOWN_MS, wanted(640, 360)]], { source: { ...HD, frameRate: 30 } }).at(-1);
  assert.equal(sixty.maxBitrate, cameraBitrate(640, 360, 30), "a 60 Hz viewer bought a 30 fps camera a 60 fps bitrate");
  assert.ok(Math.abs(cameraBitrate(640, 360, 30) - 500_000) < 20_000, `360p camera at ${cameraBitrate(640, 360, 30)} bps`);
  const share = run([[0, wanted(1280, 720, { fps: 30 })], [HOLD_DOWN_MS, wanted(1280, 720, { fps: 30 })]], { role: "screen", settings: { maxBitrate: 50_000_000, maxFramerate: 30 } });
  assert.equal(share[1].maxBitrate, screenBitrate(720, 30), "a shrunk share didn't take the picker's bitrate");
}

// The user's picks are ceilings: demand goes below them, never above.
{
  const settings = { maxSize: { width: 1280, height: 720 }, maxFramerate: 30, maxBitrate: 400_000 };
  const big = run([[0, wanted(3840, 2160, { fps: 144 })]], { settings })[0];
  assert.equal(big.scaleResolutionDownBy, 1.5, "demand pushed the size above the user's ceiling");
  assert.equal(big.maxFramerate, 30, "demand pushed the frame rate above the user's pick");
  assert.equal(big.maxBitrate, 400_000, "the user's own bitrate was lifted");
  const small = run([[0, wanted(320, 180)], [HOLD_DOWN_MS, wanted(320, 180)]], { settings }).at(-1);
  assert.equal(small.scaleResolutionDownBy, 6);
  assert.ok(small.maxBitrate <= 400_000, "a smaller rung raised the bitrate over the user's");
  const display = run([[0, wanted(1920, 1080, { fps: 60 })], [HOLD_DOWN_MS, wanted(1920, 1080, { fps: 60 })]], { settings: { maxFramerate: 144 } });
  assert.deepEqual(display.map((p) => p.maxFramerate), [144, 60], "sending faster than any viewer's display");
}

// A viewer that never reported wants everything, and one of them is enough.
{
  const plan = run([[0, wanted(320, 180, { unknown: 1 })], [HOLD_DOWN_MS * 3, wanted(320, 180, { unknown: 1 })]]).at(-1);
  assert.equal(plan.scaleResolutionDownBy, 1, "an old client got a shrunk stream");
  const idle = run([[0, wanted(0, 0, { watchers: 0, unknown: 1 })], [PAUSE_AFTER_MS * 2, wanted(0, 0, { watchers: 0, unknown: 1 })]]).at(-1);
  assert.equal(idle.active, true, "an old client got a paused stream");
}

// Pause after ten seconds with nobody watching; resume at once; re-kick an encoder that stays silent.
{
  const nobody = wanted(0, 0, { watchers: 0 });
  const plans = run([
    [0, nobody],
    [PAUSE_AFTER_MS - 1, nobody],
    [PAUSE_AFTER_MS, nobody, 500],
    [40_000, wanted(640, 360), 500],
    [40_000 + RESUME_CHECK_MS, wanted(640, 360), 500],
    [40_000 + 2 * RESUME_CHECK_MS, wanted(640, 360), 530],
    [40_000 + 3 * RESUME_CHECK_MS, wanted(640, 360), 560],
  ]);
  assert.deepEqual(plans.map((p) => p.active), [true, true, false, true, true, true, true], "pause or resume at the wrong time");
  assert.deepEqual(plans.map((p) => p.rekick), [false, false, false, false, true, false, false], "the watchdog didn't re-kick exactly the frozen resume");

  const frozen = [[0, nobody], [PAUSE_AFTER_MS, nobody, 9], [20_000, wanted(640, 360), 9]];
  for (let i = 1; i <= MAX_REKICKS + 2; i++) frozen.push([20_000 + i * RESUME_CHECK_MS, wanted(640, 360), 9]);
  const kicks = run(frozen).filter((p) => p.rekick).length;
  assert.equal(kicks, MAX_REKICKS, "the watchdog gave up too early or never");

  // One frame and then nothing, which is how a resumed share froze in the design's runs.
  const once = run([[0, nobody], [PAUSE_AFTER_MS, nobody, 9], [20_000, wanted(640, 360), 9], [21_000, wanted(640, 360), 10], [22_000, wanted(640, 360), 40]]);
  assert.deepEqual(once.map((p) => p.rekick), [false, false, false, true, false], "a resume that froze after its first frame wasn't re-kicked");
  const quiet = run([[0, nobody], [PAUSE_AFTER_MS, nobody, 9], [20_000, wanted(640, 360), 9], [21_000, wanted(640, 360), 40], [30_000, wanted(640, 360), 40]]);
  assert.equal(quiet.at(-1).rekick, false, "the watchdog still re-kicked long after the resume");
}

// An encoder setParameters can't reach, like the native H.264 share: settings only, never paused.
{
  const plan = run([[0, wanted(0, 0, { watchers: 0 })], [PAUSE_AFTER_MS * 2, wanted(0, 0, { watchers: 0 })]], {
    role: "screen", settings: { followDemand: false, maxBitrate: 8_000_000 },
  }).at(-1);
  assert.equal(plan.active, true);
  assert.equal(plan.scaleResolutionDownBy, 1);
  assert.equal(plan.maxBitrate, 8_000_000);
}

// ── The engine ───────────────────────────────────────────────────────────────

let clock = 1_000_000;
Date.now = () => clock;
async function wait(ms) {
  for (let left = ms; left > 0; left -= 500) {
    clock += Math.min(500, left);
    await advance(Math.min(500, left));
  }
}

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
await wait(1_000);
const pc = phone.peers.at(-1);
await settle(() => pc.reach("connected"));
assert.equal(engine.current.connectionState, "connected", "the call never came up");
const socket = FakeSocket.all.at(-1);

const track = { ...fakeTrack("video", "camera"), getSettings: () => ({ width: 1280, height: 720 }) };
await settle(() => engine.current.addVideoTrack(track, fakeStream(track)));
await settle(() => engine.current.setVideoSendSettings("camera", { priority: "medium", degradationPreference: "maintain-framerate" }));
await wait(1_000);
const sender = pc.getSenders().find((candidate) => candidate.track === track);
assert.ok(sender, "the camera has no sender");
const mid = pc.getTransceivers().find((t) => t.sender === sender).mid;
const writes = [];
const setParameters = sender.setParameters;
sender.setParameters = (parameters) => {
  writes.push(parameters.encodings[0].active);
  return setParameters(parameters);
};
const encoding = () => sender.parameters.encodings[0];

// Nothing from the SFU yet, which is what an old SFU does for good: today's encoding.
await wait(15_000);
assert.equal(encoding().active, true);
assert.equal(encoding().scaleResolutionDownBy, 1);
assert.equal(encoding().maxBitrate, undefined, "the camera got a cap with no SFU asking");
assert.equal(encoding().priority, "medium", "the embedder's priority didn't reach the sender");
assert.equal(sender.parameters.degradationPreference, "maintain-framerate");

const say = (w) => settle(() => socket.deliver("video_wanted", { mid, ...w }));

await say(wanted(320, 180, { fps: 30 }));
await wait(HOLD_DOWN_MS + 1_000);
assert.equal(encoding().scaleResolutionDownBy, 4, "a 180p viewer didn't shrink a 720p camera");
assert.equal(encoding().maxBitrate, cameraBitrate(320, 180, 30));

await say(wanted(0, 0, { watchers: 0 }));
await wait(PAUSE_AFTER_MS - 1_000);
assert.equal(encoding().active, true, "paused before ten seconds");
await wait(2_000);
assert.equal(encoding().active, false, "nobody watching for ten seconds and still sending");

pc.stats = new Map([["out", { type: "outbound-rtp", mid, framesEncoded: 77 }]]);
writes.length = 0;
await say(wanted(1280, 720, { fps: 30 }));
await settle();
assert.equal(encoding().active, true, "didn't resume at once");
await wait(1_500);
assert.deepEqual(writes, [true, false, true], "a resume that encoded nothing wasn't toggled off and on");
assert.equal(encoding().scaleResolutionDownBy, 1);

// What this viewer draws goes out once per change, increases fast and decreases slow.
const demands = () => socket.sent.filter((m) => m.event === "video_demand").map((m) => JSON.parse(m.data));
await settle(() => engine.current.reportVideoDemand("their-camera-stream", { width: 631, height: 355, fps: 60 }));
await wait(500);
assert.deepEqual(demands(), [{ stream_id: "their-camera-stream", width: 640, height: 368, fps: 60 }]);
await settle(() => engine.current.reportVideoDemand("their-camera-stream", { width: 640, height: 360, fps: 60 }));
await wait(1_500);
assert.equal(demands().length, 1, "the same size went out twice");
await settle(() => engine.current.reportVideoDemand("their-camera-stream", { width: 0, height: 0, fps: 60 }));
await wait(500);
assert.equal(demands().length, 1, "a decrease went out before a second had passed");
await wait(1_000);
assert.deepEqual(demands().at(-1), { stream_id: "their-camera-stream", width: 0, height: 0, fps: 60 });

// A stream first reported hidden waits like any decrease, so a tile that mounts a moment later wins.
await settle(() => engine.current.reportVideoDemand("late-tile", { width: 0, height: 0, fps: 60 }));
await wait(500);
await settle(() => engine.current.reportVideoDemand("late-tile", { width: 640, height: 360, fps: 60 }));
await wait(1_500);
assert.deepEqual(demands().filter((d) => d.stream_id === "late-tile"), [{ stream_id: "late-tile", width: 640, height: 368, fps: 60 }], "a hidden first report went out before the tile mounted");

// A new SFU socket after a drop starts with no reports, so it gets every track's last one again.
await settle(() => socket.drop());
await wait(3_000);
const next = phone.peers.at(-1);
assert.notEqual(next, pc, "the call wasn't rebuilt after the SFU dropped");
await settle(() => next.reach("connected"));
await wait(500);
const again = FakeSocket.all.at(-1).sent.filter((m) => m.event === "video_demand").map((m) => JSON.parse(m.data));
assert.deepEqual(again.find((d) => d.stream_id === "their-camera-stream"), { stream_id: "their-camera-stream", width: 0, height: 0, fps: 60 }, "the new SFU socket wasn't told what this viewer draws");

await engine.unmount();
process.stdout.write("video demand: ok, the ladder, holds, pause, re-kick and demand reports; nothing changes against an old SFU\n");
process.exit(0);
