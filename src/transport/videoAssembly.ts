/** Puts a sender's pieces back into frames for the decoder, as client-rs video_assembly.rs does. A frame goes out
    when its last piece lands, in order; a hole asks the SFU again, and a frame that stays broken asks for a keyframe. */

import {
  frameAfter, keyframeRequest, LAYERS_ALL, MAX_RESEND, type PieceHeader, readPiece, resendRequest, VIDEO_HEADER,
} from "./videoWire";

export const RESEND_AFTER_MS = 15;
export const RESEND_EVERY_MS = 40;
/** A frame still not whole after this is lost, and the stream waits for a keyframe. */
export const GIVE_UP_MS = 250;
/** The SFU passes on one keyframe request per sender and track in 300 ms. */
export const KEYFRAME_EVERY_MS = 300;
const MAX_PENDING = 64;
/** A frame number this far behind the last one delivered means the sender restarted. */
const RESTART_GAP = 1024;

export interface AssembledFrame {
  sender: number;
  track: number;
  codec: number;
  keyframe: boolean;
  frame: number;
  layer: number;
  timestamp: number;
  data: Uint8Array;
}

interface Partial {
  frame: number;
  /** Null for a frame none of whose pieces came, known only from the gap in frame numbers. */
  head: PieceHeader | null;
  parts: (Uint8Array | null)[];
  have: number;
  seen: number;
  touched: number;
  asked: number | null;
}

interface Stream {
  last: number | null;
  broken: boolean;
  /** Every layer is coming, so a skipped frame number is a loss. A capped viewer can't tell. */
  strict: boolean;
  pending: Partial[];
  keyframeAsked: number | null;
}

const newStream = (strict = true): Stream => ({ last: null, broken: true, strict, pending: [], keyframeAsked: null });
const placeholder = (frame: number, now: number): Partial => ({ frame, head: null, parts: [], have: 0, seen: now, touched: now, asked: null });
const whole = (p: Partial) => p.head !== null && p.have === p.parts.length;

function missing(p: Partial): [number, number][] {
  if (!p.head) return [[p.frame, 0]];
  return p.parts.flatMap((part, i) => (part ? [] : [[p.frame, i] as [number, number]]));
}

function insert(pending: Partial[], p: Partial): number {
  let at = pending.findIndex((q) => frameAfter(q.frame, p.frame));
  if (at < 0) at = pending.length;
  pending.splice(at, 0, p);
  return at;
}

function join(parts: (Uint8Array | null)[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + (p?.length ?? 0), 0));
  let at = 0;
  for (const p of parts) {
    if (!p) continue;
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function drain(sender: number, track: number, s: Stream): AssembledFrame[] {
  for (let k = s.pending.length - 1; k >= 0; k--) {
    if (whole(s.pending[k]) && s.pending[k].head?.keyframe) {
      s.pending.splice(0, k);
      s.broken = false;
      break;
    }
  }
  const out: AssembledFrame[] = [];
  while (s.pending.length) {
    const p = s.pending[0];
    if (s.broken && !p.head?.keyframe) {
      s.last = p.frame;
      s.pending.shift();
      continue;
    }
    const h = p.head;
    if (!h || !whole(p)) break;
    s.pending.shift();
    s.last = p.frame;
    out.push({ sender, track, codec: h.codec, keyframe: h.keyframe, frame: p.frame, layer: h.layer, timestamp: h.timestamp, data: join(p.parts) });
  }
  return out;
}

export class VideoAssembler {
  private streams = new Map<string, { sender: number; track: number; s: Stream }>();

  private stream(sender: number, track: number): Stream {
    const key = `${sender}/${track}`;
    let e = this.streams.get(key);
    if (!e) this.streams.set(key, (e = { sender, track, s: newStream() }));
    return e.s;
  }

  /** What we asked the SFU for, so a frame it skips on purpose isn't taken for a lost one. */
  setLayers(sender: number, track: number, top: number): void {
    this.stream(sender, track).strict = top === LAYERS_ALL;
  }

  forget(sender: number): void {
    for (const [k, e] of this.streams) if (e.sender === sender) this.streams.delete(k);
  }

  /** One forwarded piece, sender id already taken off. Returns the frames it finished, oldest first. */
  push(sender: number, piece: Uint8Array, now: number): AssembledFrame[] {
    const h = readPiece(piece);
    if (!h) return [];
    let s = this.stream(sender, h.track);
    if (s.last !== null && !frameAfter(h.frame, s.last)) {
      if (((s.last - h.frame) & 0xffff) < RESTART_GAP) return [];
      const fresh = newStream(s.strict);
      this.streams.set(`${sender}/${h.track}`, { sender, track: h.track, s: fresh });
      s = fresh;
    }
    if (s.strict && !s.broken) {
      const last = s.last ?? s.pending[s.pending.length - 1]?.frame ?? null;
      if (last !== null) {
        for (let f = (last + 1) & 0xffff; frameAfter(h.frame, f) && s.pending.length < MAX_PENDING; f = (f + 1) & 0xffff) {
          if (!s.pending.some((p) => p.frame === f)) insert(s.pending, placeholder(f, now));
        }
      }
    }
    let at = s.pending.findIndex((p) => p.frame === h.frame);
    if (at < 0) at = insert(s.pending, placeholder(h.frame, now));
    const p = s.pending[at];
    if (!p.head) {
      p.head = h;
      p.parts = new Array<Uint8Array | null>(h.pieces).fill(null);
    }
    if (p.head.pieces !== h.pieces || p.head.codec !== h.codec) return [];
    if (!p.parts[h.piece]) {
      p.parts[h.piece] = piece.slice(VIDEO_HEADER);
      p.have++;
    }
    p.touched = now;
    if (s.pending.length > MAX_PENDING) {
      s.pending = [];
      s.broken = true;
    }
    return drain(sender, h.track, s);
  }

  /** The requests that are due: resends for holes, keyframes for broken streams. Drops frames given up on. */
  poll(now: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const { sender, track, s } of this.streams.values()) {
      if (s.pending.length && now - s.pending[0].seen >= GIVE_UP_MS) {
        s.last = s.pending[0].frame;
        s.pending.shift();
        s.broken = true;
        drain(sender, track, s);
      }
      const ask: [number, number][] = [];
      for (const p of s.pending) {
        const due = p.asked === null || now - p.asked >= RESEND_EVERY_MS;
        if (!whole(p) && now - p.touched >= RESEND_AFTER_MS && due) {
          ask.push(...missing(p));
          p.asked = now;
        }
      }
      for (let i = 0; i < ask.length; i += MAX_RESEND) out.push(resendRequest(sender, track, ask.slice(i, i + MAX_RESEND)));
      if (s.broken && (s.keyframeAsked === null || now - s.keyframeAsked >= KEYFRAME_EVERY_MS)) {
        out.push(keyframeRequest(sender, track));
        s.keyframeAsked = now;
      }
    }
    return out;
  }
}
