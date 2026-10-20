// A reconnect handed the new connection the same Web Audio track, and the call came back
// about 10 ms slower for good. Each connection now sends its own clone (voice#53).

import assert from "node:assert/strict";

// First, so the fake timers and sockets are in place before any engine module loads.
import {
  advance,
  FakeSocket,
  fakePhonePlatform,
  fakeRoom,
  log,
  mountEngine,
  settle,
  voiceConfig,
} from "./engine-harness.ts";

import { VoiceConfigProvider } from "../dist/config/index.js";
import { setVoicePlatform } from "../dist/platform/index.js";
import { VoiceSingletonHooks } from "../dist/shared/SingletonHooks.js";
import { useSFU } from "../dist/webrtc/hooks/useSFU.js";

interface SentTrack {
  kind: string;
  readyState: string;
  clonedFrom?: SentTrack;
}

const phone = fakePhonePlatform();
setVoicePlatform(phone);
const room = fakeRoom("server-a");
const engine = await mountEngine({
  provider: VoiceConfigProvider,
  runner: VoiceSingletonHooks,
  useRead: () => useSFU(),
  config: voiceConfig({ stunHosts: ["stun:a.test"] }),
  target: { id: "server-a", room },
});

await settle(() => {
  engine.current.connect("chan-a").catch(() => {});
});
await advance(1_000);
await settle(() => phone.lastPeer().reach("connected"));
assert.equal(engine.current.connectionState, "connected", "the call never came up");

const sentAudio = (peer: { getSenders(): { track: SentTrack | null }[] }) =>
  peer.getSenders().map((s) => s.track).find((t): t is SentTrack => t?.kind === "audio");

const first = sentAudio(phone.peers[0]);
assert.ok(first?.clonedFrom, "the connection was given the pipeline's own track, not a clone");
const source = first.clonedFrom;

// The server and the SFU restart: a full reconnect on a new peer connection.
FakeSocket.last().close();
await settle(() => room.reconnect());
await advance(1_000);
assert.equal(phone.peers.length, 2, `no full reconnect (${engine.current.connectionState})`);
await settle(() => phone.lastPeer().reach("connected"));

const second = sentAudio(phone.peers[1]);
assert.ok(second?.clonedFrom, "the reconnect sent the pipeline's own track");
assert.notEqual(second, first, "the reconnect reused the first connection's clone");
assert.equal(second.clonedFrom, source, "the reconnect cloned something other than the microphone");
assert.equal(first.readyState, "ended", "the first connection's clone was left running");
assert.equal(source.readyState, "live", "the disconnect stopped the pipeline's own track");

await engine.unmount();
log("fresh send track: each connection sends its own clone, and only the clone is stopped");
