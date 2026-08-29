// What an SFU says on the way in, and what happens when it says nothing.
//
// room_joined used to be the sentence "Successfully joined room". An SFU that
// answers GRYT-715 sends JSON in the same field, carrying the number of seconds
// it lets one person sit alone in a call. Every client that draws a countdown
// reads that number, and the fallback for an older SFU is the client's own
// guess — so getting a `null` where a `0` belongs, or the other way round, is a
// call that ends when it should not or one that never ends.
//
// Against dist rather than src, because dist is what a client installs.
import assert from "node:assert/strict";

const { parseRoomJoined } = await import("../dist/index.js");

// The SFU as it is now.
assert.deepEqual(
  parseRoomJoined('{"message":"Successfully joined room","call_alone_timeout_seconds":120}'),
  { callAloneTimeoutSeconds: 120 },
);

// SFU_CALL_ALONE_TIMEOUT=0. Zero is a real answer — "this SFU never ends a call
// for being one person" — and reading it as "did not say" is what leaves a
// client hanging up on a call the SFU was happy to keep.
assert.deepEqual(
  parseRoomJoined('{"message":"Successfully joined room","call_alone_timeout_seconds":0}'),
  { callAloneTimeoutSeconds: 0 },
);

// An SFU older than GRYT-715.
assert.deepEqual(parseRoomJoined("Successfully joined room"), {
  callAloneTimeoutSeconds: null,
});

// Things that are not an answer. Each has to come back null rather than throw:
// this runs inside the WebSocket's onmessage, and a throw there loses the
// room_joined that resolves the connect.
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
