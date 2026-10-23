// What an SFU says on the way in, and what happens when it says nothing. A `null` where a
// `0` belongs ends a call that should not end, or never ends one. Against dist, not src.
import assert from "node:assert/strict";

const { parseRoomJoined } = await import("../dist/index.js");

// The SFU as it is now.
assert.deepEqual(
  parseRoomJoined('{"message":"Successfully joined room","call_alone_timeout_seconds":120}'),
  { callAloneTimeoutSeconds: 120, maxIngestKbps: null, audioTransport: null },
);

// SFU_CALL_ALONE_TIMEOUT=0. Zero is a real answer — this SFU never ends a call for being
// one person — and reading it as "did not say" hangs up on a call the SFU would keep.
assert.deepEqual(
  parseRoomJoined('{"message":"Successfully joined room","call_alone_timeout_seconds":0}'),
  { callAloneTimeoutSeconds: 0, maxIngestKbps: null, audioTransport: null },
);

// An SFU older than GRYT-715.
assert.deepEqual(parseRoomJoined("Successfully joined room"), {
  callAloneTimeoutSeconds: null,
  maxIngestKbps: null, audioTransport: null,
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
    { callAloneTimeoutSeconds: null, maxIngestKbps: null, audioTransport: null },
    `expected no answer from ${JSON.stringify(data)}`,
  );
}

// Seconds, whole. A float would reach a setInterval and count down in steps
// nobody asked for.
assert.deepEqual(parseRoomJoined('{"call_alone_timeout_seconds":120.7}'), {
  callAloneTimeoutSeconds: 120,
  maxIngestKbps: null, audioTransport: null,
});

// SFU_MAX_INGEST_KBPS. Zero, negative or not a number is no cap, never a cap of nothing.
assert.deepEqual(parseRoomJoined('{"call_alone_timeout_seconds":120,"max_ingest_kbps":1500}'), {
  callAloneTimeoutSeconds: 120,
  maxIngestKbps: 1500, audioTransport: null,
});
for (const cap of ["0", "-5", '"1500"', "null"]) {
  assert.equal(parseRoomJoined(`{"call_alone_timeout_seconds":120,"max_ingest_kbps":${cap}}`).maxIngestKbps, null, `max_ingest_kbps ${cap} became a cap`);
}

// The own voice transport's offer (GRYT-1818): kept whole, and only https URLs reach WebTransport.
const offer = { urls: ["https://192.0.2.1:4433/voice"], certHash: "aGFzaA==", ticket: "dGlja2V0" };
assert.deepEqual(parseRoomJoined(JSON.stringify({ call_alone_timeout_seconds: 120, audio_transport: offer })).audioTransport, offer);
assert.deepEqual(
  parseRoomJoined(JSON.stringify({ audio_transport: { ...offer, urls: ["http://192.0.2.1:4433/voice", offer.urls[0]] } })).audioTransport,
  offer,
);
for (const bad of [null, "x", {}, { ...offer, urls: [] }, { ...offer, urls: ["ws://a"] }, { ...offer, ticket: 1 }, { ...offer, certHash: null }]) {
  assert.equal(parseRoomJoined(JSON.stringify({ audio_transport: bad })).audioTransport, null, `offer ${JSON.stringify(bad)} was accepted`);
}


// audio_senders (GRYT-1830): sender id to user id, and nothing that isn't one.
const { parseAudioSenders } = await import("../dist/webrtc/hooks/sfuConnection.js");
assert.deepEqual([...parseAudioSenders('{"senders":{"3":"user_a","12":"user_b"}}')], [[3, "user_a"], [12, "user_b"]]);
assert.deepEqual([...parseAudioSenders('{"senders":{"x":"u","4":7,"5":"","-1":"u"}}')], []);
for (const bad of ["", "null", "{", '{"senders":null}', '{"senders":"3"}']) assert.equal(parseAudioSenders(bad).size, 0, bad);

const { parseWebRTCAudioWanted } = await import("../dist/webrtc/hooks/sfuConnection.js");
assert.equal(parseWebRTCAudioWanted('{"wanted":false}'), false);
assert.equal(parseWebRTCAudioWanted('{"wanted":true}'), true);
for (const bad of ["", "null", "{", '{"wanted":"no"}', "{}"]) assert.equal(parseWebRTCAudioWanted(bad), null, bad);

console.log("room_joined ok: the timeout and the ingest cap survive the wire, and an SFU that says nothing says null; audio_senders and webrtc_audio_wanted parsed");
