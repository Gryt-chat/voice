/* eslint-env node */

// useVoiceLatency reads the stats once a second. It restarted its poll on every render, which came
// to about eight reads a second in a call (GRYT-1330).

import assert from "node:assert/strict";

// First, so the fake timers and sockets are in place before any engine module loads.
import {
  advance,
  fakePhonePlatform,
  fakeRoom,
  log,
  mountEngine,
  settle,
  voiceConfig,
} from "./engine-harness.mjs";

import { useVoiceLatency } from "../dist/audio/hooks/useVoiceLatency.js";
import { VoiceConfigProvider } from "../dist/config/index.js";
import { setVoicePlatform } from "../dist/platform/index.js";
import { VoiceSingletonHooks } from "../dist/shared/SingletonHooks.js";
import { useSFU } from "../dist/webrtc/hooks/useSFU.js";

const phone = fakePhonePlatform();
setVoicePlatform(phone);
const room = fakeRoom("server-a");

const engine = await mountEngine({
  provider: VoiceConfigProvider,
  runner: VoiceSingletonHooks,
  read: (enabled) => ({ sfu: useSFU(), latency: useVoiceLatency(enabled).latency }),
  config: voiceConfig({ stunHosts: ["stun:a.test"] }),
  target: { id: "server-a", room },
  probe: false,
});

await settle(() => {
  engine.current.sfu.connect("chan-a").catch(() => {});
});
await advance(1_000);
const pc = phone.peers.at(-1);
await settle(() => pc.reach("connected"));

pc.stats = new Map([
  ["CP1", { id: "CP1", type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.042 }],
]);

await engine.update({ probe: true });
await advance(1_000);
assert.equal(engine.current.latency.networkRttMs, 42, "the poll did not read the connection");

/** A config that renders the engine again. Noise suppression also rebuilds a callback the poll reads. */
function config(i) {
  const next = voiceConfig({ stunHosts: ["stun:a.test"] });
  next.audio.noiseSuppression = i % 2 === 1;
  return next;
}

// Once a second, however often the engine renders in between.
{
  const before = pc.statsCalls;
  for (let i = 0; i < 6; i++) {
    await engine.update({ config: config(i) });
    await advance(500);
  }
  assert.equal(pc.statsCalls - before, 3, "the latency poll restarted on renders");
  assert.equal(engine.current.latency.networkRttMs, 42);
}

// Turning it off stops the reads.
{
  await engine.update({ probe: false });
  const before = pc.statsCalls;
  await advance(3_000);
  assert.equal(pc.statsCalls, before, "the poll kept reading after it was turned off");
}

await engine.unmount();

log("voice latency: polled once a second, whatever renders in between");
