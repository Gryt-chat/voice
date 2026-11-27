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
  /** The worst share of pieces any viewer had to ask for again, 0 to 1, since the last reading. */
  viewerLoss: number;
}

export const LOSS_LIMIT = 0.05;
/** Round trip above the connection's best that means a queue is building somewhere. */
export const QUEUE_DELAY_MS = 60;
const BACK_OFF = 0.85;
const GROW = 1.08;
const GROW_STEP = 50_000;
const HOLD_MS = 1500;

export class RateControl {
  private last: LinkSample | null = null;
  private holdUntil = 0;
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
    const over = loss > LOSS_LIMIT || s.viewerLoss > LOSS_LIMIT || s.smoothedRtt - s.minRtt > QUEUE_DELAY_MS || s.dropped > p.dropped;
    if (over) {
      // What actually went, not what was asked for: an encoder under its target would otherwise hide the cut.
      this.target = Math.max(this.min, Math.min(this.target, rate || this.target) * BACK_OFF);
      this.holdUntil = s.at + HOLD_MS;
    } else if (s.at >= this.holdUntil) {
      this.target = Math.min(this.max, this.target * GROW + GROW_STEP);
    }
    return this.target;
  }
}

const LOSSY = 0.05;
const CLEAN = 0.01;
const DROP_AFTER_MS = 2000;
const RAISE_AFTER_MS = 5000;

/** A viewer's top temporal layer of one stream, from how many of its pieces had to be asked for again. */
export class LayerControl {
  top: number;
  /** The last second's share of pieces asked for again, for the sender. */
  loss = 0;
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
    this.loss = Math.min(1, ratio);
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
