// The video hub's bytes and reassembly (GRYT-2261), against the same vectors as client-rs video_wire.rs and video_assembly.rs.

import assert from "node:assert/strict";

import { GIVE_UP_MS, KEYFRAME_EVERY_MS, RESEND_AFTER_MS, RESEND_EVERY_MS, VideoAssembler } from "../dist/transport/videoAssembly.js";
import {
  CONTROL_KEYFRAME, CONTROL_RESEND, frameAfter, keyframeRequest, LAYERS_NONE, layersRequest, MAX_PIECE, MAX_PIECES, MAX_RESEND,
  demandRequest, readForwardedVideo, readPiece, resendRequest, splitFrame, VIDEO_HEADER,
} from "../dist/transport/videoWire.js";

const head = { keyframe: true, track: 1, codec: 1, frame: 7, layer: 0, timestamp: 90_000 };

// The header layout video_test.go builds.
const five = splitFrame(head, new Uint8Array(MAX_PIECE * 4 + 3)) ?? assert.fail();
assert.deepEqual([...five[4].subarray(0, VIDEO_HEADER)], [2, 1, 1, 1, 0, 7, 0, 4, 0, 5, 0, 0, 0, 1, 0x5f, 0x90]);
assert.deepEqual(readPiece(five[2]), { ...head, piece: 2, pieces: 5 });

const ok = splitFrame(head, new Uint8Array(10).fill(1))?.[0] ?? assert.fail();
assert.ok(readPiece(ok));
assert.equal(readPiece(ok.subarray(0, VIDEO_HEADER)), null, "no payload");
assert.equal(readPiece(new Uint8Array(VIDEO_HEADER + MAX_PIECE + 1).fill(2)), null, "too long");
const past = ok.slice();
past.set([0, 1], 6);
assert.equal(readPiece(past), null, "piece past the count");
const audio = ok.slice();
audio[0] = 1;
assert.equal(readPiece(audio), null, "an audio packet");

const data = Uint8Array.from({ length: 2500 }, (_, i) => i & 0xff);
const pieces = splitFrame(head, data) ?? assert.fail();
assert.deepEqual(pieces.map((p) => p.length), [VIDEO_HEADER + 1100, VIDEO_HEADER + 1100, VIDEO_HEADER + 300]);
assert.equal(splitFrame(head, new Uint8Array(0)), null);
assert.ok(splitFrame(head, new Uint8Array(MAX_PIECE * MAX_PIECES)));
assert.equal(splitFrame(head, new Uint8Array(MAX_PIECE * MAX_PIECES + 1)), null);

// control_test.go's keyframeRequest, resendRequest and layersRequest.
assert.deepEqual([...keyframeRequest(5, 1)], [3, 1, 1, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0]);
const r = resendRequest(5, 1, [[7, 1], [8, 0]]);
assert.deepEqual([...r.subarray(0, 4)], [3, 2, 1, 2]);
assert.deepEqual([...r.subarray(VIDEO_HEADER)], [0, 7, 0, 1, 0, 8, 0, 0]);
assert.equal(resendRequest(5, 1, Array.from({ length: 40 }, () => [0, 0] as [number, number])).length, VIDEO_HEADER + 4 * MAX_RESEND);
assert.deepEqual([...layersRequest(5, 1, LAYERS_NONE).subarray(0, 9)], [3, 3, 1, 0, 0, 0, 0, 5, 0xfe]);

const fromSfu = new Uint8Array(4 + VIDEO_HEADER);
fromSfu.set(keyframeRequest(5, 2), 4);
assert.deepEqual(readForwardedVideo(fromSfu), { kind: "keyframe", track: 2 });
fromSfu[3] = 9;
assert.equal(readForwardedVideo(fromSfu), null, "a keyframe request from a member");
const fwd = new Uint8Array(4 + ok.length);
fwd[3] = 5;
fwd.set(ok, 4);
const got = readForwardedVideo(fwd);
assert.equal(got?.kind === "piece" ? got.sender : null, 5);

assert.ok(frameAfter(1, 0) && frameAfter(0, 65535) && !frameAfter(65535, 0) && !frameAfter(4, 4));

// Reassembly.
const frame = (no: number, keyframe: boolean, size: number) =>
  splitFrame({ keyframe, track: 1, codec: 1, frame: no, layer: 0, timestamp: no * 3000 }, new Uint8Array(size).fill(no & 0xff)) ?? assert.fail();
const feed = (a: VideoAssembler, ps: Uint8Array[], now: number) => ps.flatMap((p) => a.push(9, p, now)).map((f) => f.frame);
const resends = (reqs: Uint8Array[]) => reqs.filter((q) => q[1] === CONTROL_RESEND).flatMap((q) => {
  const v = new DataView(q.buffer);
  return Array.from({ length: q[3] }, (_, i) => [v.getUint16(VIDEO_HEADER + 4 * i), v.getUint16(VIDEO_HEADER + 4 * i + 2)]);
});
const keyframes = (reqs: Uint8Array[]) => reqs.filter((q) => q[1] === CONTROL_KEYFRAME).length;
const t = 1000;
let a: VideoAssembler;

a = new VideoAssembler();
assert.deepEqual(feed(a, frame(5000, true, 10), t), [5000]);
assert.deepEqual(feed(a, frame(5001, false, 10), t), [5001]);
assert.deepEqual(feed(a, frame(4990, false, 10), t), [], "a late frame is still dropped");
assert.deepEqual(feed(a, frame(1, false, 10), t), [], "a restart waits for its keyframe");
assert.equal(keyframes(a.poll(t)), 1);
assert.deepEqual(feed(a, frame(2, true, 10), t), [2]);

a = new VideoAssembler();
const key = frame(0, true, 2500);
assert.deepEqual(feed(a, key.slice(0, 2), t), []);
const out = a.push(9, key[2], t);
assert.equal(out.length, 1);
assert.equal(out[0].data.length, 2500);
assert.deepEqual(feed(a, frame(1, false, 10), t), [1]);

a = new VideoAssembler();
assert.deepEqual(feed(a, frame(4, false, 10), t), []);
assert.equal(keyframes(a.poll(t)), 1);
assert.equal(keyframes(a.poll(t + KEYFRAME_EVERY_MS / 2)), 0, "asked again inside the SFU's gap");
assert.deepEqual(feed(a, frame(5, true, 10), t), [5]);
assert.equal(keyframes(a.poll(t + KEYFRAME_EVERY_MS)), 0, "asked once the keyframe came");

a = new VideoAssembler();
feed(a, frame(0, true, 10), t);
const one = frame(1, false, 3000);
assert.deepEqual(feed(a, [one[0], one[2]], t), []);
assert.deepEqual(feed(a, frame(2, false, 10), t), [], "frame 2 jumped the hole in frame 1");
assert.deepEqual(resends(a.poll(t)), []);
assert.deepEqual(resends(a.poll(t + RESEND_AFTER_MS)), [[1, 1]]);
assert.deepEqual(resends(a.poll(t + RESEND_AFTER_MS + RESEND_EVERY_MS / 2)), [], "asked twice too soon");
assert.deepEqual(feed(a, [one[1]], t + RESEND_AFTER_MS), [1, 2]);

a = new VideoAssembler();
feed(a, frame(0, true, 10), t);
assert.deepEqual(feed(a, frame(3, false, 10), t), []);
assert.deepEqual(resends(a.poll(t + RESEND_AFTER_MS)), [[1, 0], [2, 0]]);
assert.deepEqual(feed(a, frame(1, false, 10), t), [1]);
assert.deepEqual(feed(a, frame(2, false, 10), t), [2, 3]);

a = new VideoAssembler();
a.setLayers(9, 1, 0);
feed(a, frame(0, true, 10), t);
assert.deepEqual(feed(a, frame(4, false, 10), t), [4], "a capped viewer waited on a skipped layer");
assert.deepEqual(a.poll(t + GIVE_UP_MS), []);

a = new VideoAssembler();
feed(a, frame(0, true, 10), t);
feed(a, one.slice(0, 1), t);
feed(a, frame(2, false, 10), t);
assert.equal(keyframes(a.poll(t + GIVE_UP_MS)), 1);
assert.deepEqual(feed(a, frame(3, false, 10), t + GIVE_UP_MS), [], "decoded past a lost frame");
assert.deepEqual(feed(a, one.slice(1), t + GIVE_UP_MS), [], "the lost frame came back to life");
assert.deepEqual(feed(a, frame(4, true, 10), t + GIVE_UP_MS), [4]);
assert.deepEqual(feed(a, frame(5, false, 10), t + GIVE_UP_MS), [5]);

a = new VideoAssembler();
const holed = frame(0, true, 3000);
feed(a, [holed[0], holed[2]], t);
for (let no = 1; no <= 20; no++) assert.deepEqual(feed(a, frame(no, false, 10), t), []);
assert.deepEqual(resends(a.poll(t + RESEND_AFTER_MS)), [[0, 1]]);
assert.deepEqual(feed(a, [holed[1]], t + RESEND_AFTER_MS), Array.from({ length: 21 }, (_, i) => i));

a = new VideoAssembler();
feed(a, frame(0, true, 10), t);
feed(a, frame(1, false, 3000).slice(0, 1), t);
assert.deepEqual(feed(a, frame(2, true, 10), t), [2]);
assert.deepEqual(a.poll(t + GIVE_UP_MS), [], "still asking about a frame the keyframe replaced");

a = new VideoAssembler();
assert.deepEqual(feed(a, frame(0, true, 10), t), [0]);
assert.deepEqual(feed(a, frame(0, true, 10), t), []);
assert.deepEqual(feed(a, frame(65535, false, 10), t), []);

a = new VideoAssembler();
assert.deepEqual(feed(a, frame(65535, true, 10), t), [65535]);
assert.deepEqual(feed(a, frame(0, false, 10), t), [0]);

a = new VideoAssembler();
feed(a, frame(0, true, 10), t);
assert.deepEqual(a.push(8, frame(1, false, 10)[0], t), [], "another sender's delta decoded on ours");
a.forget(9);
assert.deepEqual(feed(a, frame(1, false, 10), t), [], "a forgotten sender carried on");

// Demand, the control proposed to the Rust SFU: what a viewer draws out, the max over viewers back.
assert.deepEqual([...demandRequest(5, 1, { width: 1920, height: 1080, fps: 60, loss: 0.1 })], [3, 4, 1, 0, 0, 0, 0, 5, 7, 128, 4, 56, 0, 60, 26, 0]);
const back = new Uint8Array(4 + VIDEO_HEADER);
back.set(demandRequest(0, 1, { width: 640, height: 360, fps: 30 }), 4);
back[4 + 3] = 2;
assert.deepEqual(readForwardedVideo(back), { kind: "demand", track: 1, watchers: 2, demand: { width: 640, height: 360, fps: 30, loss: 0 } });

console.log("video wire: pieces, requests and reassembly match client-rs and the SFU");
