/** A frame's pieces go out spread over the time since that track's last frame, at most this long. */
export const MAX_SPREAD_MS = 50;

/** Sent in one burst, a keyframe overflows a buffer on the way even on a clean LAN. `Pacer` in client-rs's
    video_link.rs, number for number. */
export class Pacer {
  private last = new Map<number, number>();
  private due: number | null = null;

  /** When each of a frame's `n` pieces is due, in ms: evenly over the gap since this track's last frame, behind
      anything still queued. */
  plan(track: number, n: number, now: number): number[] {
    const last = this.last.get(track);
    this.last.set(track, now);
    const spread = last === undefined ? MAX_SPREAD_MS : Math.min(now - last, MAX_SPREAD_MS);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const at = Math.max(now + (spread * i) / n, this.due ?? now);
      this.due = at;
      out.push(at);
    }
    return out;
  }
}
