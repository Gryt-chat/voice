/* eslint-env node */

// Runs the two writes that decide whether a call reads as connected. Reported by
// Sivert: an open microphone and no indicator anywhere after a reconnect. GRYT-1136.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FLOW = "dist/webrtc/hooks/sfuConnectFlow.js";
const flow = readFileSync(join(here, "..", FLOW), "utf8");

const { SFUConnectionState } = await import("../dist/webrtc/types/SFU.js");
const { peerConnectedSettles, connectingMayBeWritten } = await import(
  "../dist/webrtc/hooks/connectionProgress.js"
);

/** The `setConnectionState(...)` argument that follows a marker, parens balanced. */
function updaterAfter(marker) {
  const anchor = flow.indexOf(marker);
  assert.notEqual(anchor, -1, `${FLOW} no longer has "${marker}". Move this check with it.`);

  const CALL = "setConnectionState(";
  const open = flow.indexOf(CALL, anchor);
  assert.notEqual(open, -1, `no setConnectionState after "${marker}" in ${FLOW}`);

  const start = open + CALL.length;
  let depth = 1;
  for (let i = start; i < flow.length; i++) {
    if (flow[i] === "(") depth++;
    else if (flow[i] === ")" && --depth === 0) return flow.slice(start, i);
  }
  throw new Error(`unbalanced parens after "${marker}" in ${FLOW}`);
}

function run(source, prev, extra = {}) {
  const names = ["SFUConnectionState", "peerConnectedSettles", "connectingMayBeWritten"];
  const values = [SFUConnectionState, peerConnectedSettles, connectingMayBeWritten];
  for (const [name, value] of Object.entries(extra)) {
    names.push(name);
    values.push(value);
  }
  const updater = new Function(...names, `return (${source});`)(...values);
  assert.equal(typeof updater, "function", "the write is not a functional update, so it cannot see the state it replaces");
  return updater(prev);
}

const settled = updaterAfter("WebRTC CONNECTED");
const announced = updaterAfter("Usually stays CONNECTING");
const step8 = { channelID: "room-1", targetId: "host-1", callAloneTimeoutSeconds: 90 };

// The reported bug. ICE and DTLS finish while the announce step is awaiting, so the
// call is already up when that step writes; it used to be sent back to CONNECTING.
{
  let state = {
    state: SFUConnectionState.CONNECTING,
    roomId: "room-1",
    serverId: "host-1",
    error: null,
    callAloneTimeoutSeconds: null,
  };
  state = run(settled, state);
  assert.equal(state.state, SFUConnectionState.CONNECTED, "the peer connection reported connected and the call did not follow");

  state = run(announced, state, step8);
  assert.equal(
    state.state,
    SFUConnectionState.CONNECTED,
    "the announce step put a live call back to CONNECTING, where nothing reports connected again",
  );
  assert.equal(state.roomId, "room-1", "the announce step stopped writing the channel");
  assert.equal(state.serverId, "host-1", "the announce step stopped writing the host");
  assert.equal(state.callAloneTimeoutSeconds, 90, "the alone-timeout the SFU gave us was dropped");
}

// The ordinary way in: the announce step runs first and the call comes up after it.
{
  let state = {
    state: SFUConnectionState.CONNECTING,
    roomId: null,
    serverId: null,
    error: null,
    callAloneTimeoutSeconds: null,
  };
  state = run(announced, state, step8);
  assert.equal(state.state, SFUConnectionState.CONNECTING, "the announce step no longer reports CONNECTING");

  state = run(settled, state);
  assert.equal(state.state, SFUConnectionState.CONNECTED, "the call never reaches CONNECTED");
}

// A reconnect that reaches RECONNECTING before the peer connection comes up. Refusing
// it there is the same dead end: live audio, and a call that reads as still trying.
for (const opening of [
  SFUConnectionState.RECONNECTING,
  SFUConnectionState.REQUESTING_ACCESS,
  SFUConnectionState.CONNECTING,
]) {
  const state = run(settled, {
    state: opening,
    roomId: "room-1",
    serverId: "host-1",
    error: null,
    callAloneTimeoutSeconds: null,
  });
  assert.equal(state.state, SFUConnectionState.CONNECTED, `a call in ${opening} stays there when the peer connection is up`);
}

// A torn-down call must not come back. The old peer connection can report late.
for (const ended of [SFUConnectionState.DISCONNECTED, SFUConnectionState.FAILED]) {
  const before = {
    state: ended,
    roomId: null,
    serverId: null,
    error: "Connection lost",
    callAloneTimeoutSeconds: null,
  };
  const after = run(settled, before);
  assert.equal(after.state, ended, `a ${ended} call was brought back by a late report from the peer connection`);
  assert.equal(after, before, "the state object was replaced when nothing changed, which re-renders every consumer");
}

/* What the apps read. It used to check the socket and peer connection refs too, and
   no render depends on a ref, so a null one at the wrong moment stuck it at false. */
{
  const HOOK = "dist/webrtc/hooks/useSFU.js";
  const hook = readFileSync(join(here, "..", HOOK), "utf8");
  const MEMO = "const isConnected = useMemo(() => {";
  const open = hook.indexOf(MEMO);
  assert.notEqual(open, -1, `${HOOK} no longer builds isConnected with a memo. Move this check with it.`);

  const start = open + MEMO.length - 1;
  let depth = 0;
  let body = null;
  for (let i = start; i < hook.length; i++) {
    if (hook[i] === "{") depth++;
    else if (hook[i] === "}" && --depth === 0) {
      body = hook.slice(start, i + 1);
      break;
    }
  }
  assert.ok(body, `unbalanced braces around isConnected in ${HOOK}`);

  const read = new Function(
    "connectionState",
    "sfuWebSocketRef",
    "peerConnectionRef",
    "SFUConnectionState",
    `return (() => ${body})();`,
  );
  const nulls = [{ current: null }, { current: null }];
  assert.equal(
    read({ state: SFUConnectionState.CONNECTED }, ...nulls, SFUConnectionState),
    true,
    "a connected call reads as not connected, which is every voice indicator dark",
  );
  for (const state of Object.values(SFUConnectionState)) {
    if (state === SFUConnectionState.CONNECTED) continue;
    assert.equal(
      read({ state }, { current: {} }, { current: {} }, SFUConnectionState),
      false,
      `a call in ${state} reads as connected`,
    );
  }
}

// Both predicates, at every state, so neither list drifts from the other.
{
  const opening = [
    SFUConnectionState.REQUESTING_ACCESS,
    SFUConnectionState.CONNECTING,
    SFUConnectionState.RECONNECTING,
  ];
  for (const state of Object.values(SFUConnectionState)) {
    assert.equal(peerConnectedSettles(state), opening.includes(state), `peerConnectedSettles is wrong for ${state}`);
    assert.equal(
      connectingMayBeWritten(state),
      state !== SFUConnectionState.CONNECTED,
      `connectingMayBeWritten is wrong for ${state}`,
    );
  }
}

console.log("connection settles: ok, in either order, and a dead call stays dead");
