/**
 * One sender's jitter buffer for the own transport (GRYT-1818). Sized from measured jitter, and it
 * drains back after a burst: the prototype's grew 51 → 155 ms without that, the reconnect bug's shape.
 */

import { type AudioPacket, seqDelta } from "./packet";

export type Pulled = { kind: "packet"; packet: AudioPacket } | { kind: "lost" } | { kind: "silence" };

export interface JitterBufferOptions {
  frameMs: number;
  minMs?: number;
  maxMs?: number;
}

/** How many arrivals the jitter estimate looks back over: a second at 2.5 ms frames. */
const WINDOW = 400;
/** Frames Opus fills before a gap counts as the sender having stopped. */
const MAX_CONCEALED = 4;
/** More queued than the target by this many frames, for this many pulls in a row, and a frame is dropped. */
const DRAIN_EXCESS_FRAMES = 2;
const DRAIN_AFTER_PULLS = 20;
/** Far more than any target, so a stalled consumer can't hold memory forever. */
const MAX_QUEUED = 400;

export class JitterBuffer {
  private readonly frameMs: number;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly queue = new Map<number, AudioPacket>();
  private next: number | null = null;
  private playing = false;
  private concealed = 0;
  private over = 0;
  private transits: number[] = [];
  readonly stats = { late: 0, duplicate: 0, lost: 0, drained: 0, rebuffered: 0 };

  constructor({ frameMs, minMs = 5, maxMs = 60 }: JitterBufferOptions) {
    this.frameMs = frameMs;
    this.minMs = minMs;
    this.maxMs = maxMs;
  }

  /** What arrival jitter asks for: its 95th percentile plus one frame, within min and max. */
  get targetMs(): number {
    if (this.transits.length < 10) return Math.max(this.minMs, 2 * this.frameMs);
    const sorted = [...this.transits].sort((a, b) => a - b);
    const spread = sorted[Math.floor(sorted.length * 0.95)] - sorted[0];
    return Math.min(this.maxMs, Math.max(this.minMs, spread + this.frameMs));
  }

  /** What's queued from the next frame to play to the newest that arrived. */
  get depthMs(): number {
    if (this.next === null || this.queue.size === 0) return 0;
    let newest = 0;
    for (const seq of this.queue.keys()) newest = Math.max(newest, seqDelta(this.next, seq) + 1);
    return newest * this.frameMs;
  }

  push(packet: AudioPacket, arrivalMs: number): void {
    // Transit up to a constant: arrival against when the sender says it captured the frame.
    this.transits.push(arrivalMs - packet.timestamp / 48);
    if (this.transits.length > WINDOW) this.transits.shift();

    if (this.next === null) this.next = packet.seq;
    if (seqDelta(this.next, packet.seq) < 0) {
      this.stats.late++;
      return;
    }
    if (this.queue.has(packet.seq)) {
      this.stats.duplicate++;
      return;
    }
    if (this.queue.size >= MAX_QUEUED) return;
    this.queue.set(packet.seq, packet);
  }

  /** Called once a frame by the player. */
  pull(): Pulled {
    if (this.next === null) return { kind: "silence" };
    if (!this.playing) {
      if (this.depthMs < this.targetMs) return { kind: "silence" };
      this.playing = true;
    }

    // Too much queued for too long: skip a frame, so delay comes back down after a burst.
    const excess = this.depthMs - this.targetMs;
    this.over = excess > DRAIN_EXCESS_FRAMES * this.frameMs ? this.over + 1 : 0;
    if (this.over >= DRAIN_AFTER_PULLS) {
      this.queue.delete(this.next);
      this.next = (this.next + 1) & 0xffff;
      this.stats.drained++;
      this.over = 0;
    }

    const packet = this.queue.get(this.next);
    if (packet) {
      this.queue.delete(this.next);
      this.next = (this.next + 1) & 0xffff;
      this.concealed = 0;
      return { kind: "packet", packet };
    }

    if (this.queue.size > 0 && this.concealed < MAX_CONCEALED) {
      // A hole with later packets behind it: Opus fills this one frame.
      this.next = (this.next + 1) & 0xffff;
      this.concealed++;
      this.stats.lost++;
      return { kind: "lost" };
    }

    // Nothing to play: go quiet and refill to the target before starting again. A gap too long to
    // conceal is given up on, or the buffer would wait on that packet for ever.
    this.playing = false;
    this.stats.rebuffered++;
    this.concealed = 0;
    if (this.queue.size > 0) {
      let oldest = this.next;
      let best = Infinity;
      for (const seq of this.queue.keys()) {
        const d = seqDelta(this.next, seq);
        if (d < best) {
          best = d;
          oldest = seq;
        }
      }
      this.next = oldest;
    }
    return { kind: "silence" };
  }
}
