// What an SFU says on the way in, and what happens when it says nothing. A `null` where a
// `0` belongs ends a call that should not end, or never ends one. Against dist, not src.
import assert from "node:assert/strict";

const { parseRoomJoined } = await import("../dist/index.js");

// The SFU as it is now.
assert.deepEqual(
  parseRoomJoined('{"message":"Successfully joined room","call_alone_timeout_seconds":120}'),
  { callAloneTimeoutSeconds: 120 },
);

// SFU_CALL_ALONE_TIMEOUT=0. Zero is a real answer — this SFU never ends a call for being
// one person — and reading it as "did not say" hangs up on a call the SFU would keep.
assert.deepEqual(
  parseRoomJoined('{"message":"Successfully joined room","call_alone_timeout_seconds":0}'),
  { callAloneTimeoutSeconds: 0 },
);

// An SFU older than GRYT-715.
assert.deepEqual(parseRoomJoined("Successfully joined room"), {
  callAloneTimeoutSeconds: null,
});

// Things that are not an answer. Each has to come back null rather than throw: this runs
// inside onmessage, and a throw there loses the room_joined that resolves the connect.
for (const data of [
  "",
  "null",
  "[]",
  '"just a string"',
  "{}",
  '{"call_alone_timeout_seconds":"120"}',
  '{"call_alone_timeout_seconds":-1}',
  '{"call_alone_timeout_seconds":null}',
  "{not json",
  undefined,
  null,
  42,
]) {
  assert.deepEqual(
    parseRoomJoined(data),
    { callAloneTimeoutSeconds: null },
    `expected no answer from ${JSON.stringify(data)}`,
  );
}

// Seconds, whole. A float would reach a setInterval and count down in steps
// nobody asked for.
assert.deepEqual(parseRoomJoined('{"call_alone_timeout_seconds":120.7}'), {
  callAloneTimeoutSeconds: 120,
});

console.log("room_joined ok: the timeout survives the wire, and an SFU that says nothing says null");
