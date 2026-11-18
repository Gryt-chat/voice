// A server's video ceiling holds the user's picks to it, height, fps and bitrate, and leaves
// them alone without one (GRYT-2171).

import assert from "node:assert/strict";

import { clampToCeiling } from "../dist/webrtc/hooks/videoDemand.js";

const ceiling = { maxHeight: 1080, maxFps: 60, maxKbps: 12184 };

// Native resolution, no fps or bitrate cap: everything comes from the ceiling.
const native = clampToCeiling({}, ceiling);
assert.equal(native.maxSize?.height, 1080);
assert.ok((native.maxSize?.width ?? 0) >= 1080 * 3, "width shouldn't bind on an ultrawide screen");
assert.equal(native.maxFramerate, 60);
assert.equal(native.maxBitrate, Math.round(12184_000 / 1.25));

// 4K at 240 fps comes down to 1080p60, keeping the aspect ratio.
const big = clampToCeiling({ maxSize: { width: 3840, height: 2160 }, maxFramerate: 240, maxBitrate: 50_000_000 }, ceiling);
assert.deepEqual(big.maxSize, { width: 1920, height: 1080 });
assert.equal(big.maxFramerate, 60);
assert.equal(big.maxBitrate, Math.round(12184_000 / 1.25));

// Already under the ceiling: untouched.
const small = clampToCeiling({ maxSize: { width: 1280, height: 720 }, maxFramerate: 30, maxBitrate: 3_000_000, priority: "high" }, ceiling);
assert.deepEqual(small, { maxSize: { width: 1280, height: 720 }, maxFramerate: 30, maxBitrate: 3_000_000, priority: "high" });

// No ceiling: the same object back.
const picks = { maxFramerate: 240 };
assert.equal(clampToCeiling(picks, null), picks);

console.log("video ceiling ok: picks are held to height, fps and bitrate, and left alone without a ceiling");
