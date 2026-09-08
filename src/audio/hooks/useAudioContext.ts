import { useCallback, useEffect, useState } from "react";

import { singletonHook } from "../../shared/singletonHook";

export interface SharedAudioContextValue {
  audioContext: AudioContext | undefined;
  activate: () => void;
}

/**
 * The AudioContext useMicrophone and useSpeakers share, so both process through one context
 * without extra threads. It must not suspend on hidden: capture continues while alt-tabbed.
 */
function useAudioContextHook(): SharedAudioContextValue {
  const [ctx, setCtx] = useState<AudioContext | undefined>(undefined);
  const [activated, setActivated] = useState(false);

  const activate = useCallback(() => {
    setActivated(true);
  }, []);

  useEffect(() => {
    if (!activated) return;

    const ac = new AudioContext({
      latencyHint: "interactive",
      sampleRate: 48000,
    });

    setCtx(ac);

    const resume = () => {
      if (ac.state === "suspended") {
        ac.resume().catch(() => {});
      }
    };

    resume();

    // Keep trying to resume when the OS returns focus. Not `{ once: true }`: the context can
    // be suspended again after a later focus or visibility change.
    document.addEventListener("click", resume);
    document.addEventListener("keydown", resume);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);

    return () => {
      document.removeEventListener("click", resume);
      document.removeEventListener("keydown", resume);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);

      ac.close().catch(() => {});
    };
  }, [activated]);

  return { audioContext: ctx, activate };
}

const initValue: SharedAudioContextValue = {
  audioContext: undefined,
  activate: () => {},
};

export const useSharedAudioContext = singletonHook<SharedAudioContextValue>(
  initValue,
  useAudioContextHook,
);
