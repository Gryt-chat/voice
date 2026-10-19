// Closes a joined SFU socket each way it can close. Cloudflare's 1001 on a proxy restart was taken
// for the call ending, and the server then put the member out of voice for good (GRYT-1359).

import assert from "node:assert/strict";

import type { SFUWebSocketCloseInfo } from "../dist/webrtc/hooks/sfuConnection.js";

console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = () => {};

const sockets: FakeSocket[] = [];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string; wasClean: boolean }) => void;

  constructor(url: string) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    sockets.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(event: string, data: object) {
    this.onmessage?.({ data: JSON.stringify({ event, data: JSON.stringify(data) }) });
  }

  closedBy(code: number, reason: string, wasClean: boolean) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean });
  }
}

Object.assign(globalThis, { WebSocket: FakeSocket });

const { connectToSfuWebSocket } = await import("../dist/webrtc/hooks/sfuConnection.js");

async function joined() {
  const reported: SFUWebSocketCloseInfo[] = [];
  const refs: Parameters<typeof connectToSfuWebSocket>[2] = {
    isDisconnectingRef: { current: false },
    sfuWebSocketRef: { current: null },
    // The connection's state is all the socket code reads from it.
    peerConnectionRef: { current: { connectionState: "connected" } as RTCPeerConnection },
  };
  const connecting = connectToSfuWebSocket("ws://sfu.test/client", { room_id: "room" }, refs, false, {
    onAbnormalClose: (info) => reported.push(info),
  });
  const ws = sockets.at(-1);
  assert.ok(ws, "connectToSfuWebSocket opened no socket");
  ws.open();
  ws.receive("room_joined", { call_alone_timeout_seconds: 0 });
  refs.sfuWebSocketRef.current = await connecting;
  return { ws, refs, reported };
}

// What the soak saw from Cloudflare, twice in four hours.
{
  const { ws, refs, reported } = await joined();
  ws.closedBy(1001, "CloudFlare WebSocket proxy restarting", true);
  assert.deepEqual(
    reported,
    [{ code: 1001, reason: "CloudFlare WebSocket proxy restarting", wasClean: true }],
    "a proxy going away wasn't reported, so nothing reconnects the call",
  );
  assert.equal(refs.sfuWebSocketRef.current, null, "the closed socket is still held as the call's");
}

// The same from a proxy that doesn't finish the close handshake.
{
  const { ws, reported } = await joined();
  ws.closedBy(1001, "", false);
  assert.equal(reported.length, 1, "an unclean 1001 wasn't reported");
}

// A drop with no close frame at all, which always reconnected.
{
  const { ws, reported } = await joined();
  ws.closedBy(1006, "", false);
  assert.equal(reported.length, 1, "a 1006 is no longer reported");
}

// The SFU's own errors.
for (const code of [1011, 1013, 4000]) {
  const { ws, reported } = await joined();
  ws.closedBy(code, "sfu", true);
  assert.equal(reported.length, 1, `a clean ${code} wasn't reported`);
}

// The SFU hanging up on purpose is still the end of the call.
{
  const { ws, refs, reported } = await joined();
  ws.closedBy(1000, "", true);
  assert.deepEqual(reported, [], "a clean 1000 from the SFU was treated as a failure");
  assert.equal(refs.sfuWebSocketRef.current, ws, "a clean 1000 let go of the socket it isn't reporting");
}

// Leaving the call closes the socket too, and nothing should come back from that.
for (const code of [1000, 1001, 1006]) {
  const { ws, refs, reported } = await joined();
  refs.isDisconnectingRef.current = true;
  ws.closedBy(code, "", code !== 1006);
  assert.deepEqual(reported, [], `leaving the call reported its own ${code} close`);
}

process.stdout.write("going away: ok, only a clean 1000 ends the call, and a proxy's 1001 reconnects it\n");
