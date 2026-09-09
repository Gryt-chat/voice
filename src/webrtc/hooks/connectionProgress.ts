import { SFUConnectionState } from "../types/SFU";

/* Every state a call passes through on the way in. The peer connection
   reaching "connected" during any of them settles the call. */
const OPENING = new Set([
  SFUConnectionState.REQUESTING_ACCESS,
  SFUConnectionState.CONNECTING,
  SFUConnectionState.RECONNECTING,
]);

/* Nothing reports "connected" a second time, so refusing it here leaves the
   call in a state it never leaves, with live audio and no indicator. */
export function peerConnectedSettles(prev: SFUConnectionState): boolean {
  return OPENING.has(prev);
}

/* The announce step runs after the offer, so ICE and DTLS can finish while it
   waits. Writing CONNECTING then puts a call that is already up back a step. */
export function connectingMayBeWritten(prev: SFUConnectionState): boolean {
  return prev !== SFUConnectionState.CONNECTED;
}
