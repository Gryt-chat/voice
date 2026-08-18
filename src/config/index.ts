/**
 * Config delivery.
 *
 * `VoiceConfig` in types.ts says *what* the engine needs to know. This says how
 * it arrives: a provider the embedder mounts, and a hook the engine reads.
 *
 * The alternative was threading the values through every call, which would have
 * meant changing every call site in the client for no gain — these are React
 * hooks either way, and a context is the thing that already re-renders them when
 * a setting changes. The client keeps its `useSettings` store and maps it into
 * the provider; the package never reaches up for it.
 *
 * A module-level singleton like `setVoiceHost` was the other option and is wrong
 * here. Host capabilities are fixed for the lifetime of the process, so a
 * singleton is honest about them. Config changes while a call is running — every
 * time somebody drags a slider — and a singleton would not re-render anything.
 */

import type { ReactNode } from "react";
import { createContext, createElement, useContext } from "react";

import type { VoiceConfig } from "../types";

/**
 * The other direction: things the engine finds out and the app needs to store.
 *
 * Deliberately not setters. The engine does not own the settings and does not
 * decide what happens to them — it says what it observed and the app writes it
 * down, or doesn't. Adding a setter here would be the point where the engine
 * starts driving the app's state.
 */
export interface VoiceConfigCallbacks {
  /**
   * The camera in use is not the one that was configured.
   *
   * Fires when nothing was chosen yet and a default was picked, and when the
   * device that opened is not the one asked for — which happens when the
   * configured camera has been unplugged.
   */
  onCameraDeviceChanged?(deviceId: string): void;
}

interface VoiceConfigValue {
  config: VoiceConfig;
  callbacks: VoiceConfigCallbacks;
}

const VoiceConfigContext = createContext<VoiceConfigValue | null>(null);

export interface VoiceConfigProviderProps {
  config: VoiceConfig;
  callbacks?: VoiceConfigCallbacks;
  children?: ReactNode;
}

const NO_CALLBACKS: VoiceConfigCallbacks = {};

export function VoiceConfigProvider({
  config,
  callbacks = NO_CALLBACKS,
  children,
}: VoiceConfigProviderProps) {
  return createElement(
    VoiceConfigContext.Provider,
    { value: { config, callbacks } },
    children,
  );
}

function useVoiceConfigValue(): VoiceConfigValue {
  const value = useContext(VoiceConfigContext);
  if (!value) {
    // Worth throwing rather than defaulting. There is no sensible default for
    // an SFU URL, and a silent one would surface much later as a call that
    // never connects.
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
