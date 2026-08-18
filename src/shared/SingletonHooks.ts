import { createElement, Fragment, useSyncExternalStore } from "react";

import {
  getRegistrySnapshot,
  registrations,
  subscribeToRegistry,
} from "./singletonHook";

/**
 * Runs the body of every singleton hook in this package, once.
 *
 * The client has a component of the same name doing the same job, and that is
 * the point: they are two registries, not one. `singletonHook` moved into this
 * package during the extraction and its host component did not, so every
 * singleton hook here — useSFU, useMicrophone, useCamera, useScreenShare,
 * useSpeakers, useHandles, useSharedAudioContext — registered into a list
 * nothing rendered.
 *
 * The failure that causes is quiet. Callers get the `initialValue` forever, so
 * useSFU().connect is the no-op from its init object and useMicrophone() never
 * opens a microphone. It typechecks, it builds, and voice does nothing.
 *
 * Mount it once, above anything that consumes a voice hook, next to the
 * embedder's own equivalent if it has one.
 */
export function VoiceSingletonHooks() {
  // Hook modules register on import. One imported lazily, after this has
  // mounted, changes the count and re-renders this to pick it up.
  useSyncExternalStore(subscribeToRegistry, getRegistrySnapshot, getRegistrySnapshot);

  return createElement(
    Fragment,
    null,
    ...registrations.map((registration) => registration.render()),
  );
}
