// The own transport's datagram (GRYT-1818): round trips, and anything malformed is dropped unread.

import assert from "node:assert/strict";

import { HEADER_BYTES, MAX_OPUS_BYTES, readForwarded, readPacket, seqDelta, writePacket } from "../dist/transport/packet.js";

const opus = Uint8Array.from({ length: 21 }, (_, i) => i);
const packet = { flags: 1, seq: 65535, timestamp: 0xfffffff0, opus };

const bytes = writePacket(packet);
assert.equal(bytes.length, HEADER_BYTES + opus.length);
const back = readPacket(bytes);
assert.ok(back);
assert.deepEqual({ ...back, opus: [...back.opus] }, { ...packet, opus: [...opus] }, "a packet didn't round trip");

// Forwarded: the SFU's sender id in front.
const forwarded = new Uint8Array(4 + bytes.length);
new DataView(forwarded.buffer).setUint32(0, 7);
forwarded.set(bytes, 4);
assert.equal(readForwarded(forwarded)?.sender, 7);
assert.equal(readForwarded(forwarded)?.packet.seq, 65535);

// Malformed: too short, header only, wrong version, longer than Opus allows.
assert.equal(readPacket(new Uint8Array(3)), null, "a 3-byte datagram was read");
assert.equal(readPacket(bytes.subarray(0, HEADER_BYTES)), null, "a header with no audio was read");
const v2 = Uint8Array.from(bytes);
v2[0] = 2;
assert.equal(readPacket(v2), null, "another version's packet was read");
assert.equal(readPacket(new Uint8Array(HEADER_BYTES + MAX_OPUS_BYTES + 1).fill(1)), null, "an oversized datagram was read");
assert.equal(readForwarded(new Uint8Array(4)), null);

// Sequence distance across the wrap.
assert.equal(seqDelta(65535, 0), 1);
assert.equal(seqDelta(0, 65535), -1);
assert.equal(seqDelta(100, 90), -10);

console.log("transport packet: round trips with and without the sender id; short, empty, foreign and oversized datagrams are dropped");
