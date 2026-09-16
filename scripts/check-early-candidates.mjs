/* eslint-env node */

// Feeds the SFU socket its messages in both orders. A candidate that beat the offer was
// dropped, and the join sat on connecting until the 20s timeout (GRYT-1263).

import assert from "node:assert/strict";

const logged = [];
console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = (...args) => logged.push(args.map(String).join(" "));

const sockets = [];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    sockets.push(this);
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(event, data) {
    this.onmessage?.({ data: JSON.stringify({ event, data: JSON.stringify(data) }) });
  }

  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "", wasClean: false });
  }
}

globalThis.WebSocket = FakeSocket;
globalThis.RTCSessionDescription = class {
  constructor(init) {
    Object.assign(this, init);
  }
};
globalThis.RTCIceCandidate = class {
  constructor(init) {
    Object.assign(this, init);
  }
};

const later = () => new Promise((resolve) => setImmediate(resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function invalidState() {
  const error = new Error("The remote description was null");
  error.name = "InvalidStateError";
  return error;
}

/** Descriptions resolve a task later, as the real ones do, so messages can land in between. */
class FakePeer {
  constructor() {
    this.signalingState = "stable";
    this.connectionState = "new";
    this.remoteDescription = null;
    this.localDescription = null;
    this.events = [];
    this.added = [];
  }

  setRemoteDescription(description) {
    this.events.push(`remote ${description.type}`);
    return later().then(() => {
      if (this.signalingState === "closed") throw invalidState();
      this.remoteDescription = description;
      this.signalingState = "have-remote-offer";
    });
  }

  createAnswer() {
    return later().then(() => ({ type: "answer", sdp: "v=0\r\n" }));
  }

  setLocalDescription(description) {
    return later().then(() => {
      this.localDescription = description;
      this.signalingState = "stable";
    });
  }

  // Checked when the operation runs, as the spec chains it. No remote description: rejected, gone.
  addIceCandidate(candidate) {
    return later().then(() => {
      if (this.signalingState === "closed" || !this.remoteDescription) {
        this.events.push(`rejected ${candidate.candidate}`);
        throw invalidState();
      }
      this.events.push(`added ${candidate.candidate}`);
      this.added.push(candidate.candidate);
    });
  }

  getTransceivers() {
    return [];
  }

  close() {
    this.signalingState = "closed";
    this.connectionState = "closed";
  }
}

const { connectToSfuWebSocket } = await import("../dist/webrtc/hooks/sfuConnection.js");

async function joined(pc) {
  const refs = {
    isDisconnectingRef: { current: false },
    sfuWebSocketRef: { current: null },
    peerConnectionRef: { current: pc },
  };
  const connecting = connectToSfuWebSocket("ws://sfu.test/client", { room_id: "room" }, refs);
  const ws = sockets.at(-1);
  ws.open();
  ws.receive("room_joined", { call_alone_timeout_seconds: 0 });
  refs.sfuWebSocketRef.current = await connecting;
  return { ws, refs };
}

const candidate = (port) => ({
  candidate: `candidate:1 1 udp 2130706431 203.0.113.10 ${port} typ host`,
  sdpMid: "0",
  sdpMLineIndex: 0,
});
const [A, B, C, D, E] = [3478, 3479, 3480, 3481, 3482].map(candidate);
const offer = { type: "offer", sdp: "v=0\r\n" };
const answers = (ws) => ws.sent.filter((m) => m.event === "answer").length;

// The reported order. Its host candidate was the only address the browser had for the SFU.
{
  const pc = new FakePeer();
  const { ws } = await joined(pc);
  ws.receive("candidate", A);
  ws.receive("offer", offer);
  await settle();

  assert.deepEqual(pc.added, [A.candidate], "the candidate that came before the offer never reached the peer connection");
  assert.deepEqual(
    pc.events,
    ["remote offer", `added ${A.candidate}`],
    "the candidate was not added right after the remote description was set",
  );
  assert.equal(answers(ws), 1, "no answer went back to the SFU");
  ws.drop();
}

// Several before the offer, one while it is being applied, one after: all of them, in order.
{
  const pc = new FakePeer();
  const { ws } = await joined(pc);
  ws.receive("candidate", A);
  ws.receive("candidate", B);
  ws.receive("candidate", C);
  ws.receive("offer", offer);
  ws.receive("candidate", D);
  await settle();
  ws.receive("candidate", E);
  await settle();

  assert.deepEqual(
    pc.added,
    [A, B, C, D, E].map((c) => c.candidate),
    "candidates were lost or reordered around the offer",
  );
  assert.ok(!pc.events.some((e) => e.startsWith("rejected")), "a candidate was added with no remote description");
  ws.drop();
}

// The order that always worked still does.
{
  const pc = new FakePeer();
  const { ws } = await joined(pc);
  ws.receive("offer", offer);
  await settle();
  ws.receive("candidate", A);
  await settle();

  assert.deepEqual(pc.added, [A.candidate], "a candidate after the offer is no longer added");
  ws.drop();
}

// A renegotiation starts from nothing held: the first offer's candidates are not added twice.
{
  const pc = new FakePeer();
  const { ws } = await joined(pc);
  ws.receive("candidate", A);
  ws.receive("offer", offer);
  await settle();
  ws.receive("offer", { type: "offer", sdp: "v=0\r\ns=renegotiated\r\n" });
  await settle();

  assert.deepEqual(pc.added, [A.candidate], "a renegotiation added the early candidates again");
  assert.equal(answers(ws), 2, "the renegotiation was not answered");
  ws.drop();
}

// The call is rebuilt before the offer lands. A candidate held for one peer connection stays there.
for (const laterCandidates of [[], [B]]) {
  const first = new FakePeer();
  const second = new FakePeer();
  const { ws, refs } = await joined(first);
  ws.receive("candidate", A);
  refs.peerConnectionRef.current = second;
  for (const c of laterCandidates) ws.receive("candidate", c);
  ws.receive("offer", offer);
  await settle();

  assert.deepEqual(
    second.added,
    laterCandidates.map((c) => c.candidate),
    "a candidate held for one peer connection was added to another, or the new one lost its own",
  );
  assert.deepEqual(first.added, [], "a candidate was added to a peer connection that had been replaced");
  ws.drop();
}

// The SFU connection closes while its offer is being applied. What it held goes with it.
{
  const pc = new FakePeer();
  const { ws } = await joined(pc);
  ws.receive("candidate", A);
  ws.receive("offer", offer);
  ws.drop();
  await settle();

  assert.deepEqual(pc.added, [], "a held candidate was added after its SFU connection closed");
}

assert.deepEqual(logged, [], "the engine logged a failure along the way");

// Closing the call mid-add is quiet. Any other rejection costs an address, so it is reported.
{
  const closing = new FakePeer();
  const one = await joined(closing);
  one.ws.receive("offer", offer);
  await settle();
  one.ws.receive("candidate", A);
  closing.close();
  await settle();
  assert.deepEqual(logged, [], "a candidate rejected because the call closed was logged as a failure");
  one.ws.drop();

  const open = new FakePeer();
  const two = await joined(open);
  two.ws.receive("offer", offer);
  await settle();
  open.addIceCandidate = () => Promise.reject(invalidState());
  two.ws.receive("candidate", B);
  await settle();
  assert.equal(logged.length, 1, "a candidate rejected on an open peer connection was dropped without a word");
  two.ws.drop();
}

process.stdout.write("early candidates: ok, held until the offer is applied, in order, and only for their own call\n");
