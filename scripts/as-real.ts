/** Where a fake crosses into the browser type it stands in for, or back. It implements only what the engine calls. */
export function asReal<T>(fake: object): T {
  return fake as T;
}
