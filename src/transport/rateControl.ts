/** The video hub's first congestion control (GRYT-2261). The sender backs off on loss its viewers report through the
    SFU, and on its own QUIC loss and queueing where the browser has getStats(); a viewer drops layers when its downlink loses. */

/** One reading of the sender's WebTransport.getStats(), times in ms. */
export interface LinkSample {
  at: number;
  bytesSent: number;
  packetsSent: number;
  packetsLost: number;
  smoothedRtt: number;
  minRtt: number;
  /** Datagrams the browser dropped before they went: queued too long, or lost. */
  dropped: number;
  /** The worst share of pieces any viewer had to ask for again (0 to 1) and queueing delay (ms) since the last
      reading, or undefined if no viewer reported. */
  viewer?: { loss: number; delay: number };
}

export const LOSS_LIMIT = 0.05;
/** Round trip above the connection's best that means a queue is building somewhere. */
export const RTT_QUEUE_MS = 60;
/** Queueing under this is jitter. Over it and up by `DELAY_RISE_MS` since the last report, a queue is building. */
export const DELAY_FLOOR_MS = 25;
const DELAY_RISE_MS = 10;
/** A viewer reports at `FAST_TICK_MS` from this much queueing, so a rise is seen before the queue overflows. */
export const FAST_DELAY_MS = 5;
/** A queue this long is cut on even when it holds steady. */
export const QUEUE_DELAY_MS = 100;
/** Loss with no queueing is the line's, and cutting doesn't help it. Over this much the link is going out. */
const OUTAGE_LOSS = 0.5;
const BACK_OFF = 0.85;
/** Growth per second: a share of the target, and a step. */
const GROW = 0.16;
const GROW_STEP = 100_000;
const HOLD_MS = 1500;
/** Between these shares of the rate last cut from, growth is `GROW_NEAR` a second: the next probe overshoots slowly. */
const KNEE = [0.85, 1] as const;
const GROW_NEAR = 0.08;
/** Over this much viewer loss the first cut of a bad spell goes deeper, by half the loss: a full link loses far more. */
const HEAVY_LOSS = 0.1;

/** `RateControl` in client-rs's video_rate.rs, number for number, with the browser's own QUIC stats on top. */
export class RateControl {
  private last: LinkSample | null = null;
  private holdUntil = 0;
  private bad = false;
  /** The delay in the last viewer report. */
  private delay = 0;
  /** The rate the last spell of queueing or loss first cut from, until growth passes it. */
  private ceiling: number | null = null;
  constructor(public target: number, private readonly min: number, private max: number) {}

  setMax(max: number): void {
    this.max = max;
    this.target = Math.min(this.target, max);
  }

  /** The bitrate to aim at after this reading. */
  update(s: LinkSample): number {
    const p = this.last;
    this.last = s;
    if (!p || s.at <= p.at) return this.target;
    const sent = s.packetsSent - p.packetsSent;
    const loss = sent > 0 ? (s.packetsLost - p.packetsLost) / sent : 0;
    const rate = ((s.bytesSent - p.bytesSent) * 8 * 1000) / (s.at - p.at);
    const { loss: viewerLoss, delay } = s.viewer ?? { loss: 0, delay: 0 };
    const rising = !!s.viewer && delay >= DELAY_FLOOR_MS && delay >= this.delay + DELAY_RISE_MS;
    if (s.viewer) this.delay = delay;
    const queued = rising || delay >= QUEUE_DELAY_MS || (viewerLoss > LOSS_LIMIT && delay >= DELAY_FLOOR_MS);
    const over = queued || viewerLoss > OUTAGE_LOSS || loss > LOSS_LIMIT || s.smoothedRtt - s.minRtt > RTT_QUEUE_MS || s.dropped > p.dropped;
    if (over) {
      const deeper = !this.bad && viewerLoss > HEAVY_LOSS ? 1 - viewerLoss / 2 : 1;
      // What actually went, not what was asked for: an encoder under its target would otherwise hide the cut.
      const from = Math.min(this.target, rate || this.target);
      // Deeper by the queue's share of a second, so it drains in about one.
      const drain = 1 - Math.min(delay / 1000, 0.5);
      this.target = Math.max(this.min, from * BACK_OFF * deeper * drain);
      // A cut while the queue drains sees less go, not a smaller link.
      this.ceiling = this.ceiling !== null && s.at < this.holdUntil ? Math.max(this.ceiling, from) : from;
      this.holdUntil = s.at + HOLD_MS;
    } else if (s.at >= this.holdUntil) {
      const secs = (s.at - p.at) / 1000;
      const near = this.ceiling !== null && this.target >= this.ceiling * KNEE[0];
      this.target = Math.min(this.max, near ? this.target * (1 + GROW_NEAR * secs) : this.target * (1 + GROW * secs) + GROW_STEP * secs);
      if (this.ceiling !== null && this.target >= this.ceiling * KNEE[1]) this.ceiling = null;
    }
    this.bad = over;
    return this.target;
  }
}

const BASE_WINDOW_MS = 5000;
const TICK_MS = 1000;
/** While loss or queueing is up, a demand goes this often: the sender can't cut on what it hasn't heard. */
export const FAST_TICK_MS = 250;
/** The SFU counts one demand per viewer and track in 100 ms. */
const EARLY_GAP_MS = 100;

/** One stream's pieces and frames since the last tick, on the viewer: the demand's loss and queueing delay.
    `Tally` in client-rs's video_rate.rs, number for number. */
export class Tally {
  private since: number | null = null;
  private got = 0;
  private asked = 0;
  private firstAge: number | null = null;
  private base: [number | null, number | null] = [null, null];
  private baseSince: number | null = null;
  private excess = 0;
  private frames = 0;
  private fast = false;
  /** The last two frames' queueing, µs, newest first. */
  private latest: [number, number] = [0, 0];

  received(): void {
    this.got++;
  }

  /** Pieces asked for again. */
  resent(n: number): void {
    this.asked += n;
  }

  /** A frame's first piece: its capture stamp in µs (u32) and when it came, in ms. The two clocks' offset cancels
      against the quickest frame of the last 5 to 10 s. */
  arrived(timestamp: number, at: number): void {
    const age = (Math.round(at * 1000) - timestamp) >>> 0;
    this.firstAge ??= age;
    const rel = (age - this.firstAge) | 0;
    if (this.baseSince === null || at - this.baseSince >= BASE_WINDOW_MS) {
      this.base = [null, this.base[0]];
      this.baseSince = at;
    }
    const nowMin = this.base[0] === null ? rel : Math.min(this.base[0], rel);
    this.base[0] = nowMin;
    this.latest = [rel - (this.base[1] === null ? nowMin : Math.min(this.base[1], nowMin)), this.latest[0]];
    this.excess += this.latest[0];
    this.frames++;
  }

  /** Called often: the demand's loss (0 to 1) and delay (ms) once a tick, or null if it isn't due or nothing came. */
  tick(now: number): { loss: number; delay: number } | null {
    this.since ??= now;
    const waited = now - this.since;
    // Two frames in a row queued: that goes out at once, as the last saw it, since the window's mean is mostly from before.
    const early = !this.fast && this.frames > 1 && waited >= EARLY_GAP_MS && Math.min(...this.latest) >= DELAY_FLOOR_MS * 1000;
    if (waited < (this.fast ? FAST_TICK_MS : TICK_MS) && !early) return null;
    const loss = this.got > 0 ? Math.min(1, this.asked / this.got) : 0;
    const mean = this.frames > 0 ? this.excess / this.frames / 1000 : 0;
    const delay = early ? this.latest[0] / 1000 : mean;
    this.fast = loss > LOSS_LIMIT || delay >= FAST_DELAY_MS;
    const out = this.got > 0 ? { loss, delay } : null;
    this.since = now;
    this.got = this.asked = this.excess = this.frames = 0;
    return out;
  }
}

const LOSSY = 0.05;
const CLEAN = 0.01;
const DROP_AFTER_MS = 2000;
const RAISE_AFTER_MS = 5000;

/** A viewer's top temporal layer of one stream, from how many of its pieces had to be asked for again. */
export class LayerControl {
  top: number;
  private streak: "lossy" | "clean" | "mid" = "clean";
  private since: number;
  private got = 0;
  private asked = 0;
  private window: number;

  constructor(private readonly layers: number, now: number) {
    this.top = layers - 1;
    this.since = this.window = now;
  }

  received(n = 1): void {
    this.got += n;
  }

  resent(n: number): void {
    this.asked += n;
  }

  /** Called often; acts once a second. Returns the new top layer when it changed, else null. */
  tick(now: number): number | null {
    if (now - this.window < 1000) return null;
    const ratio = this.got > 0 ? this.asked / this.got : 0;
    this.got = this.asked = 0;
    this.window = now;
    let streak: "lossy" | "clean" | "mid" = "mid";
    if (ratio > LOSSY) streak = "lossy";
    else if (ratio < CLEAN) streak = "clean";
    if (streak !== this.streak) {
      this.streak = streak;
      this.since = now;
    }
    const was = this.top;
    if (streak === "lossy" && now - this.since >= DROP_AFTER_MS && this.top > 0) this.top--;
    if (streak === "clean" && now - this.since >= RAISE_AFTER_MS && this.top < this.layers - 1) this.top++;
    if (this.top !== was) this.since = now;
    return this.top === was ? null : this.top;
  }
}
