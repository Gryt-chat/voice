/* eslint-env node */

// Push-to-talk on a platform with its own pipeline. The gate drove a Web Audio node only,
// so on a phone setPushToTalkActive did nothing and the microphone stayed open (GRYT-1536).

import assert from "node:assert/strict";

// First, so the fake timers and sockets are in place before any engine module loads.
import { fakePhonePlatform, log, mountEngine, voiceConfig } from "./engine-harness.mjs";

import { useMicrophone } from "../dist/audio/hooks/useMicrophone.js";
import { VoiceConfigProvider } from "../dist/config/index.js";
import { setVoicePlatform } from "../dist/platform/index.js";
import { VoiceSingletonHooks } from "../dist/shared/SingletonHooks.js";

/** The phone platform, with a pipeline that applies mute the way nativePlatform's does. */
async function phoneMicrophone(audio = {}) {
  const phone = fakePhonePlatform();
  phone.createAudioPipeline = ({ source }) => ({
    output: source,
    getLevel: () => null,
    setGain() {},
    setMuted(muted) {
      for (const track of source.getAudioTracks()) track.enabled = !muted;
    },
    destroy() {},
  });
  setVoicePlatform(phone);

  const base = voiceConfig();
  const configWith = (overrides) => ({ ...base, audio: { ...base.audio, ...overrides } });
  let current = configWith(audio);

  const engine = await mountEngine({
    provider: VoiceConfigProvider,
    runner: VoiceSingletonHooks,
    read: (wanted) => useMicrophone(wanted),
    config: current,
    target: null,
    probe: false,
  });
  await engine.update({ probe: true });

  return {
    engine,
    mic: () => engine.current,
    // Reads what is actually sent, not what the gate thinks it did.
    open: () => engine.current.microphoneBuffer.processedStream.getAudioTracks()[0].enabled,
    async set(overrides) {
      current = configWith({ ...current.audio, ...overrides });
      await engine.update({ config: current });
    },
    press(active) {
      engine.current.setPushToTalkActive(active);
    },
  };
}

// Voice activity: the microphone is open unless muted, and the talk button does nothing.
{
  const phone = await phoneMicrophone();
  assert.equal(phone.open(), true, "voice activity started closed");
  await phone.press(false);
  assert.equal(phone.open(), true, "a released talk button closed a voice-activity microphone");
  await phone.set({ muted: true });
  assert.equal(phone.open(), false, "mute did not close the microphone");
  await phone.set({ muted: false });
  assert.equal(phone.open(), true, "unmute did not reopen it");
  await phone.engine.unmount();
}

// Push to talk: closed at rest, open while held, closed again on release.
{
  const phone = await phoneMicrophone({ inputMode: "push_to_talk" });
  assert.equal(phone.open(), false, "push to talk started with the microphone open");
  await phone.press(true);
  assert.equal(phone.open(), true, "holding the button did not open the microphone");
  await phone.press(false);
  assert.equal(phone.open(), false, "releasing the button left the microphone open");
  await phone.engine.unmount();
}

// Mute wins over a held button, and the gate keeps tracking the button while muted.
{
  const phone = await phoneMicrophone({ inputMode: "push_to_talk", muted: true });
  await phone.press(true);
  assert.equal(phone.open(), false, "a held button opened a muted microphone");
  await phone.press(false);
  await phone.set({ muted: false });
  assert.equal(phone.open(), false, "unmuting after the release opened the microphone");

  await phone.press(true);
  await phone.set({ serverMuted: true });
  assert.equal(phone.open(), false, "a server mute did not close a held microphone");
  await phone.set({ serverMuted: false });
  assert.equal(phone.open(), true, "the held button did not reopen after the server mute");
  await phone.engine.unmount();
}

// Changing mode: into push to talk closes, and leaving it mid-press does not strand the flag.
{
  const phone = await phoneMicrophone();
  await phone.set({ inputMode: "push_to_talk" });
  assert.equal(phone.open(), false, "switching to push to talk left the microphone open");
  await phone.press(true);
  await phone.set({ inputMode: "voice_activity" });
  assert.equal(phone.open(), true, "leaving push to talk did not reopen the microphone");
  assert.equal(phone.mic().isPttActive.current, false, "leaving push to talk kept the button held");
  await phone.set({ inputMode: "push_to_talk" });
  assert.equal(phone.open(), false, "coming back to push to talk opened on a stale press");
  await phone.engine.unmount();
}

log("native push to talk: the talk button gates the sent track, and mute always wins");
