/** Which sides of the mic go out. A mono mic on one input of a two-input device arrives with the other
    side silent, so that side is dropped rather than sent as stereo or averaged in at -6 dB. */

/** A side counts as heard above this mean square, about -70 dBFS. */
const HEARD = 1e-7;
/** And as silent beside the other under a thousandth of its power, 30 dB down. */
const SILENT_BESIDE = 1e-3;

function power(block: Float32Array): number {
  let sum = 0;
  for (const v of block) sum += v * v;
  return sum / block.length;
}

export class ChannelPick {
  /** The side a one-sided mic is on, kept through pauses until both sides are heard again. */
  private side: "left" | "right" | null = null;
  /** Frames left to send in stereo: two seconds past the last time both sides were live and differed. */
  private stereoFrames = 0;
  private readonly holdFrames: number;

  constructor(holdFrames: number) {
    this.holdFrames = holdFrames;
  }

  /** One block of the raw mic, before effects. `right` is absent for a one-channel device. */
  look(left: Float32Array, right: Float32Array | undefined): void {
    if (!right) {
      this.side = null;
      return;
    }
    const l = power(left);
    const r = power(right);
    if (l > HEARD && r < l * SILENT_BESIDE) this.side = "left";
    else if (r > HEARD && l < r * SILENT_BESIDE) this.side = "right";
    else if (l > HEARD && r > HEARD) this.side = null;
    if (this.side) this.stereoFrames = 0;
    else if (left.some((v, i) => Math.abs(v - right[i]) > 1e-4)) this.stereoFrames = this.holdFrames;
  }

  /** One sample of the mono frame. */
  mono(left: number, right: number): number {
    if (this.side === "left") return left;
    if (this.side === "right") return right;
    return (left + right) / 2;
  }

  /** Whether the frame just filled goes out in stereo, counting the hold down. */
  stereoNext(): boolean {
    if (this.stereoFrames <= 0) return false;
    this.stereoFrames--;
    return true;
  }
}
