import { createElement, Fragment, useSyncExternalStore } from "react";

import {
  getRegistrySnapshot,
  registrations,
  subscribeToRegistry,
} from "./singletonHook";

/* Mount once, near the root. Every singleton hook in the package runs here. */
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
