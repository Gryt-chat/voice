/* eslint-env node */

// Splitting the uplink between the camera and the share (GRYT-1483): the rule on its own clock,
// then the engine against a fake send estimate.

import assert from "node:assert/strict";

import {
  advance,
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
import { cameraBitrate, screenBitrate } from "../dist/webrtc/hooks/videoDemand.js";
import {
  DRASTIC_AFTER_MS,
  followEstimate,
  INITIAL_BUDGET_STATE,
  learnRate,
  MIN_CAMERA_FPS,
  MIN_SCREEN_FPS,
  planVideoBudget,
  RISE_AFTER_MS,
  SPEND,
  splitVideoBudget,
  streamNeed,
} from "../dist/webrtc/hooks/videoBudget.js";
import { useSFU } from "../dist/webrtc/hooks/useSFU.js";

// ── The rule ─────────────────────────────────────────────────────────────────

const camera = (extra = {}) => ({ role: "camera", source: { width: 1280, height: 720 }, scale: 1, fps: 30, large: false, rate: null, ...extra });
// A text share: 0.87 Mbps at 1080p30 in the design's runs.
const share = (extra = {}) => ({ role: "screen", source: { width: 1920, height: 1080 }, scale: 1, fps: 30, maxBitrate: 50_000_000, large: true, rate: 870_000, ...extra });
const total = (streams, limits) => limits.reduce((sum, l, i) => sum + (l.paused ? 0 : streamNeed(streams[i], l.scale, l.fps)), 0);

// Plenty: demand's sizes stand, and each stream is capped at its own ceiling rather than 50 Mbps.
{
  const streams = [camera(), share()];
  const { limits, short } = splitVideoBudget(20_000_000, streams, false);
  assert.equal(short, false);
  assert.deepEqual(limits.map((l) => [l.scale, l.fps, l.paused]), [[1, 30, false], [1, 30, false]], "a budget with room cut something");
  assert.equal(limits[0].maxBitrate, cameraBitrate(1280, 720, 30));
  assert.equal(limits[1].maxBitrate, screenBitrate(1080, 30), "the share kept a cap Chrome parks its estimate on");
}

// The 0.8 Mbps step: the camera goes to 180p at 15 fps, and the share keeps 1080p at fewer frames.
// 780 kbps is what the gate's text share settled at once it ran at 10 fps.
{
  const budget = (690_000 - 64_000) * SPEND;
  const streams = [camera(), share({ rate: 780_000 })];
  const { limits, short } = splitVideoBudget(budget, streams, false);
  assert.equal(short, false, "a text share at 0.8 Mbps needed the camera paused");
  assert.deepEqual([limits[0].scale, limits[0].fps], [4, MIN_CAMERA_FPS], "the camera wasn't cut to 180p at 15 fps first");
  assert.equal(limits[1].scale, 1, "the share lost its size before its frame rate");
  assert.ok(limits[1].fps >= MIN_SCREEN_FPS && limits[1].fps < 30, `share at ${limits[1].fps} fps`);
  assert.ok(total(streams, limits) <= budget, "the split doesn't fit");
  assert.ok(limits[0].maxBitrate + limits[1].maxBitrate <= budget + 1, "the caps add up to more than the budget");
  assert.ok(limits[1].maxBitrate > 3 * limits[0].maxBitrate, "the share didn't get the bulk of it");
}

// Cut in order: camera frame rate, camera size, a small share's size, the large share's frame rate.
{
  const streams = [camera(), share({ large: false, scale: 3 }), share()];
  let previous = null;
  for (let budget = 6_000_000; budget > 300_000; budget -= 50_000) {
    const { limits } = splitVideoBudget(budget, streams, false);
    const step = [limits[0].fps < 30, limits[0].scale > 1, limits[1].scale > 3, limits[2].fps < 30];
    // Each cut starts only once the one before it is all the way down.
    if (step[1]) assert.equal(limits[0].fps, MIN_CAMERA_FPS);
    if (step[2]) assert.equal(limits[0].scale, 4, "a small share shrank before the camera reached 180p");
    if (step[3]) assert.equal(limits[1].scale, 6, "the large share slowed before the small one reached 180p");
    if (previous) previous.forEach((cut, i) => assert.ok(!cut || step[i], `cut ${i} undone at a lower budget`));
    previous = step;
  }
}

// A share that asked for maintain-framerate, like a gaming one, gives up size before frames.
{
  const streams = [camera(), share({ keepFramerate: true, rate: null })];
  const { limits } = splitVideoBudget(2_000_000, streams, false);
  assert.equal(limits[1].fps, 30, "a gaming share lost frames before size");
  assert.ok(limits[1].scale > 1, "a gaming share kept a size that doesn't fit");
}

// Pausing the camera and shrinking the large share wait for `drastic`, and never act on a guess.
const settled = { starved: true, was: { scale: 1, fps: 10, maxBitrate: 0, paused: false } };
{
  const streams = [camera(), share(settled)];
  const held = splitVideoBudget(150_000, streams, false);
  assert.equal(held.short, true);
  assert.equal(held.limits[0].paused, false, "the camera paused before the hold");
  const drastic = splitVideoBudget(150_000, streams, true);
  assert.equal(drastic.limits[0].paused, true, "the camera kept going on 150 kbps");
  assert.ok(drastic.limits[1].scale > 1, "the share kept 1080p on 150 kbps");
  // Short is what starts the hold, so a guess that never reads as short never pauses anything.
  const guess = splitVideoBudget(150_000, [camera(), share({ rate: null })], false);
  assert.equal(guess.short, false, "the picker's table, not a seen need, paused the camera");
  const keepingUp = splitVideoBudget(150_000, [camera(), share({ ...settled, starved: false })], false);
  assert.equal(keepingUp.short, false, "a share making its frames paused the camera on the model's say-so");
}

// A camera alone goes to 180p at 15 fps, and pauses only once even that doesn't fit.
{
  const { limits } = splitVideoBudget(400_000, [camera()], false);
  assert.deepEqual([limits[0].scale, limits[0].fps, limits[0].paused], [2, MIN_CAMERA_FPS, false]);
  assert.equal(splitVideoBudget(50_000, [camera()], true).limits[0].paused, true);
}

// The user's cap is still a ceiling.
{
  const { limits } = splitVideoBudget(20_000_000, [share({ maxBitrate: 400_000 })], false);
  assert.equal(limits[0].maxBitrate, 400_000);
}

// A rate is learned per source size at 30 fps; held at its cap it can only go up, free it decays.
{
  const at1080p30 = learnRate(null, 870_000, 1, 30, false);
  assert.equal(at1080p30, 870_000);
  const at360p = learnRate(null, 190_000, 3, 30, false);
  const back = streamNeed(share({ rate: at360p }), 3, 30);
  assert.ok(Math.abs(back - 190_000 * 1.25) < 1_000, `a 360p sample came back as a need of ${back} at 360p`);
  assert.ok(Math.abs(at360p - 870_000) < 150_000, `a 360p sample read as ${at360p} at 1080p`);
  assert.equal(learnRate(870_000, 300_000, 1, 30, true), 870_000, "a capped stream's rate fell to its cap");
  assert.equal(learnRate(870_000, 2_000_000, 1, 30, true), 870_000, "a capped stream's bytes were read as its need");
  assert.equal(learnRate(null, 300_000, 1, 30, true), null);
  assert.ok(learnRate(870_000, 300_000, 1, 30, false) < 870_000, "a free stream's rate never fell");
}

// The estimate falls at once, rises after two seconds of 20% headroom, and ignores an idle decay.
{
  let s = followEstimate(INITIAL_BUDGET_STATE, 5_000_000, 3_000_000, 0);
  assert.equal(s.estimate, 5_000_000);
  s = followEstimate(s, 700_000, 900_000, 1_000);
  assert.equal(s.estimate, 700_000, "a falling estimate waited");
  s = followEstimate(s, 2_000_000, 600_000, 2_000);
  assert.equal(s.estimate, 700_000, "a rising estimate was spent at once");
  s = followEstimate(s, 2_500_000, 600_000, 2_000 + RISE_AFTER_MS - 1);
  assert.equal(s.estimate, 700_000);
  s = followEstimate(s, 2_400_000, 600_000, 2_000 + RISE_AFTER_MS);
  assert.equal(s.estimate, 2_000_000, "the rise wasn't taken at the lowest it held");
  const idle = followEstimate(s, 150_000, 64_000, 10_000);
  assert.equal(idle.estimate, 2_000_000, "paused video let the estimate decay to the mic's");
}

// The ingest cap lowers the budget below the estimate; no estimate means no budget at all.
{
  const input = { now: 0, estimate: 5_000_000, ingestCap: 1_000_000, reserved: 64_000, sent: 4_000_000, streams: [camera(), share()] };
  const capped = planVideoBudget(input, INITIAL_BUDGET_STATE);
  assert.equal(capped.budget, (1_000_000 - 64_000) * SPEND);
  const none = planVideoBudget({ ...input, estimate: null }, INITIAL_BUDGET_STATE);
  assert.equal(none.limits, null, "a budget without an estimate");
}

// A rise moves the bitrates at once, like Chrome's own targets, but sizes and frame rates wait for it.
{
  const streams = [camera(), share({ rate: 780_000 })];
  const low = planVideoBudget({ now: 0, estimate: 700_000, ingestCap: null, reserved: 64_000, sent: 700_000, streams }, INITIAL_BUDGET_STATE);
  const was = low.limits;
  const up = planVideoBudget({ now: 1_000, estimate: 3_000_000, ingestCap: null, reserved: 64_000, sent: 700_000, streams: streams.map((s, i) => ({ ...s, was: was[i] })) }, low.state);
  assert.equal(up.limits[0].scale, was[0].scale, "the camera grew on a rise nobody trusts yet");
  assert.ok(up.limits[1].maxBitrate > 2 * was[1].maxBitrate, "the share's bitrate waited for the rise to be trusted");
}

// The drastic cuts wait DRASTIC_AFTER_MS of being short, and lift once there's RISE_MARGIN to spare.
{
  let state = INITIAL_BUDGET_STATE;
  let was = null;
  const at = (now, estimate) => {
    const streams = [camera({ was: was?.[0] }), share({ ...settled, was: was?.[1] ?? settled.was })];
    const plan = planVideoBudget({ now, estimate, ingestCap: null, reserved: 0, sent: estimate, streams }, state);
    state = plan.state;
    was = plan.limits;
    return plan.limits[0].paused;
  };
  assert.equal(at(0, 180_000), false);
  assert.equal(at(DRASTIC_AFTER_MS - 1, 180_000), false, "paused the camera before the hold");
  assert.equal(at(DRASTIC_AFTER_MS, 180_000), true);
  state = { ...state, estimate: 180_000 };
  assert.equal(at(DRASTIC_AFTER_MS + 1_000, 10_000_000), true, "resumed before the rise was trusted");
  assert.equal(at(DRASTIC_AFTER_MS + 1_000 + RISE_AFTER_MS, 10_000_000), false, "didn't resume once the estimate was back");
  // Back to short, then a little room: not enough to lift it with RISE_MARGIN to spare.
  for (const t of [30_000, 30_000 + DRASTIC_AFTER_MS]) at(t, 180_000);
  assert.equal(at(31_000 + DRASTIC_AFTER_MS, 180_000), true);
  state = { ...state, estimate: 190_000 };
  assert.equal(at(32_000 + DRASTIC_AFTER_MS, 190_000), true, "a pause flapped off on a few kbps");
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

const track = { ...fakeTrack("video", "camera"), getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }) };
await settle(() => engine.current.addVideoTrack(track, fakeStream(track)));
await settle(() => engine.current.setVideoSendSettings("camera", { priority: "medium", degradationPreference: "maintain-framerate" }));
await wait(1_000);
const sender = pc.getSenders().find((candidate) => candidate.track === track);
const mid = pc.getTransceivers().find((t) => t.sender === sender).mid;
const encoding = () => sender.parameters.encodings[0];

// No estimate in the stats, which is how the engine starts: demand alone, as before.
await wait(3_000);
assert.equal(encoding().maxBitrate, undefined, "a camera got a cap with no estimate to split");

let bytes = 0;
const link = (estimate, kbps) => {
  bytes += (kbps * 1000) / 8;
  pc.stats = new Map([
    ["pair", { type: "candidate-pair", id: "pair", nominated: true, state: "succeeded", availableOutgoingBitrate: estimate }],
    ["out", { type: "outbound-rtp", kind: "video", mid, bytesSent: bytes, headerBytesSent: 0, framesEncoded: bytes / 1000, targetBitrate: kbps * 1000 }],
  ]);
};
for (let i = 0; i < 3; i++) {
  link(5_000_000, 1_300);
  await wait(1_000);
}
assert.equal(encoding().maxBitrate, cameraBitrate(1280, 720, 30), "with room, the camera wasn't capped at its own need");
assert.equal(encoding().scaleResolutionDownBy, 1);

link(300_000, 250);
await wait(1_000);
assert.equal(encoding().maxFramerate, MIN_CAMERA_FPS, "a falling estimate didn't cut the camera within a second");
assert.ok(encoding().scaleResolutionDownBy > 1);
assert.ok(encoding().maxBitrate <= 300_000 * SPEND, `camera capped at ${encoding().maxBitrate} on a 300 kbps estimate`);

await engine.unmount();
process.stdout.write("video budget: ok, the cut order, the holds, the estimate's rise and fall, and the engine follows it\n");
process.exit(0);
