/**
 * Config delivery.
 *
 * `VoiceConfig` in types.ts says *what* the engine needs to know. This says how
 * it arrives: a provider the embedder mounts, and a hook the engine reads.
 *
 * Threading the values through every call would work and buys nothing — these
 * are React hooks either way, and a context is the thing that already re-renders
 * them when a setting changes. The embedder keeps its own settings store and
 * maps it into the provider; the package never reaches up for it.
 *
 * A module-level singleton like `setVoiceHost` was the other option and is wrong
 * here. Host capabilities are fixed for the lifetime of the process, so a
 * singleton is honest about them. Config changes while a call is running — every
 * time somebody drags a slider — and a singleton would not re-render anything.
 */

import type { ReactNode } from "react";
import { createContext, createElement, useContext } from "react";

import type { RoomCoordinator, VoiceConfig } from "../types";

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

/**
 * Where to connect, and what to talk to when we get there.
 *
 * Null when nothing is selected, which is a normal state rather than an error —
 * the engine simply has nothing to do. The engine never learns what `id` means;
 * it compares it, reports it on the connection state, and keys a cache with it.
 */
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
