/** Round-trip probes on the own transport (GRYT-1836). A FLAG_PROBE packet carries one of these instead of Opus, under
    the last audio packet's seq, so a client from before drops it as a duplicate or a late one. */

export const PROBE_PING = 1;
export const PROBE_PONG = 2;
/** How often a sender pings, while it's sending. */
export const PROBE_EVERY_S = 1;

/** A ping asks everyone to answer with its nonce; a pong says how long the answerer held it, in ms. */
export type Probe = { kind: typeof PROBE_PING; nonce: number } | { kind: typeof PROBE_PONG; nonce: number; holdMs: number };

export function writeProbe(p: Probe): Uint8Array {
  const out = new Uint8Array(p.kind === PROBE_PING ? 5 : 7);
  const view = new DataView(out.buffer);
  view.setUint8(0, p.kind);
  view.setUint32(1, p.nonce >>> 0);
  // Tenths of a millisecond, up to 6.5 s: a hold longer than that measures nothing useful.
  if (p.kind === PROBE_PONG) view.setUint16(5, Math.min(0xffff, Math.max(0, Math.round(p.holdMs * 10))));
  return out;
}

export function readProbe(bytes: Uint8Array): Probe | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length === 5 && bytes[0] === PROBE_PING) return { kind: PROBE_PING, nonce: view.getUint32(1) };
  if (bytes.length === 7 && bytes[0] === PROBE_PONG) return { kind: PROBE_PONG, nonce: view.getUint32(1), holdMs: view.getUint16(5) / 10 };
  return null;
}
