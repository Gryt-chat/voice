/* eslint-env node */

// Runs startScreenShare's catch block. Cancelling the picker while already sharing
// used to mark the share stopped and leave the old capture running (GRYT-1425).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "src/audio/hooks/useScreenShare.ts";
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", SOURCE), "utf8");

const MARKER = '"[ScreenShare] getDisplayMedia failed:"';
const anchor = source.indexOf(MARKER);
assert.notEqual(anchor, -1, `${SOURCE} no longer logs ${MARKER}. Move this check with it.`);
const open = source.lastIndexOf("catch (error) {", anchor);
let depth = 0;
let body = "";
for (let i = open + "catch (error) ".length; i < source.length; i++) {
  if (source[i] === "{") depth++;
  else if (source[i] === "}" && --depth === 0) {
    body = source.slice(open + "catch (error) ".length, i + 1);
    break;
  }
}
assert.ok(body, `could not find the catch block around ${MARKER}`);

const run = new Function("error", "rawStreamRef", "usingNativeVideoRef", "setScreenShareActive", "console", body);
const quiet = { error: () => {}, log: () => {}, warn: () => {} };

function failWith({ raw, nativeVideo }) {
  const writes = [];
  run(new Error("NotAllowedError"), { current: raw }, { current: nativeVideo }, (v) => writes.push(v), quiet);
  return writes;
}

// No share yet: a cancelled picker leaves nothing running, so the share is off.
assert.deepEqual(failWith({ raw: null, nativeVideo: false }), [false], "a failed first start must leave the share off");

// A getDisplayMedia share running: the failed re-pick must not mark it stopped.
assert.deepEqual(failWith({ raw: { id: "running" }, nativeVideo: false }), [], "a failed re-pick stopped a running share");

// A native capture running: same.
assert.deepEqual(failWith({ raw: null, nativeVideo: true }), [], "a failed re-pick stopped a running native share");

console.log("failed re-pick: ok");
