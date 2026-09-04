
import type { ReactNode } from "react";
import { createContext, createElement, useContext } from "react";

import type { RoomCoordinator, VoiceConfig } from "../types";

export interface VoiceConfigCallbacks {
  /**
   * The camera in use is not the one that was configured.
   *
   * Fires when nothing was chosen yet and a default was picked, and when the
   * device that opened is not the one asked for — which happens when the
   * configured camera has been unplugged.
   */
  onCameraDeviceChanged?(deviceId: string): void;

  /* The stored device would not open, so the engine fell back to the platform
     default and is reporting which. The engine does not own the setting. */
  onAudioDeviceChanged?(deviceId: string): void;
}

export interface VoiceTarget {
  id: string;
  room: RoomCoordinator;
}

interface VoiceConfigValue {
  config: VoiceConfig;
  callbacks: VoiceConfigCallbacks;
  target: VoiceTarget | null;
}

const VoiceConfigContext = createContext<VoiceConfigValue | null>(null);

export interface VoiceConfigProviderProps {
  config: VoiceConfig;
  callbacks?: VoiceConfigCallbacks;
  target?: VoiceTarget | null;
  children?: ReactNode;
}

const NO_CALLBACKS: VoiceConfigCallbacks = {};

export function VoiceConfigProvider({
  config,
  callbacks = NO_CALLBACKS,
  target = null,
  children,
}: VoiceConfigProviderProps) {
  return createElement(
    VoiceConfigContext.Provider,
    { value: { config, callbacks, target } },
    children,
  );
}

function useVoiceConfigValue(): VoiceConfigValue {
  const value = useContext(VoiceConfigContext);
  if (!value) {
    // Worth throwing rather than defaulting. Half these values have no sensible
    // default — a microphone gain, a STUN list — and guessing them would
    // surface much later as a call that connects to nothing or transmits
    // silence.
    throw new Error(
      "@gryt/voice: no <VoiceConfigProvider> above this hook. Mount one and give it the app's current voice settings.",
    );
  }
  return value;
}

export function useVoiceConfig(): VoiceConfig {
  return useVoiceConfigValue().config;
}

export function useVoiceCallbacks(): VoiceConfigCallbacks {
  return useVoiceConfigValue().callbacks;
}

export function useVoiceTarget(): VoiceTarget | null {
  return useVoiceConfigValue().target;
}
