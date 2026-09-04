import type { ReactElement } from "react";
import { createElement, useLayoutEffect, useSyncExternalStore } from "react";

/* Replaces react-singleton-hook, which pulled in a React 17 peer range. */

type Listener = () => void;

export interface Registration<T> {
  key: number;
  useBody: () => T;
  render: () => ReactElement;
}

let nextKey = 1;
export const registrations: Registration<unknown>[] = [];
const registryListeners = new Set<Listener>();

export function subscribeToRegistry(listener: Listener) {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

export function getRegistrySnapshot() {
  return registrations.length;
}

function notifyRegistry() {
  for (const listener of registryListeners) {
    listener();
  }
}

export function singletonHook<T>(initialValue: T, useBody: () => T): () => T {
  let current: T = initialValue;
  const listeners = new Set<Listener>();

  function publish(next: T) {
    // Object.is rather than !==, so a NaN state does not notify forever.
    if (Object.is(next, current)) {
      return;
    }
    current = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function Runner() {
    const next = useBody();

    // Layout effect, not effect: the value should be published before the
    // browser paints, so a consumer does not show the initial value for a
    // frame after the body has already produced the real one.
    useLayoutEffect(() => {
      publish(next);
    });

    return null;
  }

  const key = nextKey++;
  registrations.push({
    key,
    useBody: useBody as () => unknown,
    render: () => createElement(Runner, { key })
  });
  notifyRegistry();

  function subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot() {
    return current;
  }

  return function useSingleton(): T {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  };
}
