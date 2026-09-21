/* eslint-env node */

// The ceiling on the microphone's sender. Opus's 510 kbps left a camera on a thin link 30 kbps,
// and a reconnect the engine made on its own dropped the channel's setting (GRYT-1332).

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
} from "./engine-harness.mjs";

import { VoiceConfigProvider } from "../dist/config/index.js";
import { setVoicePlatform } from "../dist/platform/index.js";
import { VoiceSingletonHooks } from "../dist/shared/SingletonHooks.js";
import { useSFU } from "../dist/webrtc/hooks/useSFU.js";

/** A call in `chan-a`, joined with the channel's eSports mode and bitrate as given. */
async function join(...channelSettings) {
  const phone = fakePhonePlatform();
  setVoicePlatform(phone);
  const room = fakeRoom("server-a");
  const engine = await mountEngine({
    provider: VoiceConfigProvider,
    runner: VoiceSingletonHooks,
    read: () => useSFU(),
    config: voiceConfig({ stunHosts: ["stun:a.test"] }),
    target: { id: "server-a", room },
  });

  await settle(() => {
    engine.current.connect("chan-a", ...channelSettings).catch(() => {});
  });
  await advance(1_000);
  await settle(() => phone.peers.at(-1).reach("connected"));
  assert.equal(engine.current.connectionState, "connected", "the call never came up");
  return { phone, room, engine };
}

/** maxBitrate on the microphone's sender in the newest peer connection. */
function micCeiling(phone) {
  const sender = phone.peers.at(-1).getSenders().find((candidate) => candidate.track?.kind === "audio");
  assert.ok(sender, "no microphone sender");
  return sender.parameters.encodings[0].maxBitrate;
}

// A channel that sets nothing gets a voice-sized ceiling rather than Opus's maximum.
{
  const { phone, engine } = await join();
  assert.equal(micCeiling(phone), 64_000, "a channel with no bitrate of its own did not get the default");
  await engine.unmount();
}

// A channel's own bitrate still wins, above the default and below it, and eSports is 128 kbps.
for (const [settings, expected] of [
  [[false, 256_000], 256_000],
  [[false, 32_000], 32_000],
  [[true], 128_000],
]) {
  const { phone, engine } = await join(...settings);
  assert.equal(micCeiling(phone), expected, `channel settings ${JSON.stringify(settings)}`);
  await engine.unmount();
}

// The SFU drops and the engine reconnects by itself. The channel's settings go with it.
{
  const { phone, engine } = await join(false, 256_000);
  await settle(() => FakeSocket.all.at(-1).drop());
  await advance(2_000);
  assert.equal(phone.peers.length, 2, `no reconnect (${engine.current.connectionState})`);
  assert.equal(micCeiling(phone), 256_000, "the reconnect dropped the channel's bitrate");
  await engine.unmount();
}

{
  const { phone, engine } = await join(true);
  await settle(() => FakeSocket.all.at(-1).drop());
  await advance(2_000);
  assert.equal(phone.peers.length, 2, `no reconnect (${engine.current.connectionState})`);
  assert.equal(phone.peers[1].config.bundlePolicy, "max-bundle", "the reconnect dropped eSports mode");
  assert.equal(micCeiling(phone), 128_000);
  await engine.unmount();
}

// Signalling comes back and refuses the re-announce, so the engine rebuilds the call. Same again.
{
  const { phone, room, engine } = await join(false, 32_000);
  room.refusals = 3;
  await settle(() => room.reconnect());
  await advance(10_000);
  assert.equal(phone.peers.length, 2, `the rebuild never reached a peer connection (${engine.current.connectionState})`);
  assert.equal(micCeiling(phone), 32_000, "the rebuild dropped the channel's bitrate");
  await engine.unmount();
}

log("mic bitrate: 64 kbps unless the channel says otherwise, and kept across the engine's own reconnects");
