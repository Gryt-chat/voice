import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef } from "react";

import { useVoiceConfig } from "../../config";
import type { MicrophoneBufferType } from "../types/Microphone";

/* The embedder owns the trigger and this owns the gate. Being muted does not stop the gate
   tracking, so unmuting mid-press does not leave the microphone open. */
export interface PushToTalkGate {
  /** Whether the key or button is currently held. */
  isPttActive: MutableRefObject<boolean>;
  /** Called by the embedder from whatever its trigger is. */
  setActive(active: boolean): void;
}

export function usePushToTalkGate(
  microphoneBuffer: MicrophoneBufferType,
  audioContext: AudioContext | undefined,
): PushToTalkGate {
  const { muted, serverMuted, inputMode } = useVoiceConfig().audio;
  const effectiveMuted = muted || serverMuted;
  const isPttActive = useRef(false);

  // Entering push-to-talk starts closed, otherwise the microphone stays open
  // from whatever the previous mode left behind.
  useEffect(() => {
    if (inputMode !== "push_to_talk" || !microphoneBuffer.muteGain || !audioContext) return;
    if (!effectiveMuted) {
      microphoneBuffer.muteGain.gain.setValueAtTime(0, audioContext.currentTime);
    }
    // effectiveMuted is deliberately not a dependency: this is about entering the mode, and
    // re-running on every mute toggle would close the gate underneath a held key.

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputMode, microphoneBuffer.muteGain, audioContext]);

  const setActive = useCallback(
    (active: boolean) => {
      if (inputMode !== "push_to_talk") return;
      if (!microphoneBuffer.muteGain || !audioContext) return;
      if (active === isPttActive.current) return;

      isPttActive.current = active;

      // Opening while muted would transmit something the person has said not
      // to. Closing always applies.
      if (active && effectiveMuted) return;
      microphoneBuffer.muteGain.gain.setValueAtTime(
        active ? 1 : 0,
        audioContext.currentTime,
      );
    },
    [inputMode, microphoneBuffer.muteGain, audioContext, effectiveMuted],
  );

  // Leaving push-to-talk with the key still held would strand the flag, and the
  // next press would be read as a release.
  useEffect(() => {
    if (inputMode !== "push_to_talk") isPttActive.current = false;
  }, [inputMode]);

  return { isPttActive, setActive };
}
