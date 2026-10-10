// Signalsmith Audio / Geraint Luff (MIT), fixed-window PeakHold and limiter adaptation.
// See docs/receive-leveling.md and third-party/Signalsmith-LICENSE.txt for provenance.
export class ReceivePeakHold {
  private buffer: Float64Array;
  private mask: number;
  private back: number;
  private middleStart: number;
  private working = 0;
  private middleEnd = 0;
  private front = 0;
  private frontMax = -Infinity;
  private workingMax = -Infinity;
  private middleMax = -Infinity;
  private length: number;

  constructor(length: number) {
    this.length = length;
    let size = 1;
    while (size <= length) size *= 2;
    this.buffer = new Float64Array(size);
    this.buffer.fill(-Infinity);
    this.mask = size - 1;
    this.back = -length;
    this.middleStart = -Math.floor(length / 2);
  }
  reset() {
    this.buffer.fill(-Infinity);
    this.front = this.middleEnd = this.working = 0;
    this.back = -this.length;
    this.middleStart = -Math.floor(this.length / 2);
    this.frontMax = this.workingMax = this.middleMax = -Infinity;
  }

  next(value: number): number {
    this.buffer[this.front & this.mask] = value;
    ++this.front;
    this.frontMax = Math.max(this.frontMax, value);
    if (this.back === this.middleStart) {
      this.workingMax = -Infinity;
      this.middleMax = this.frontMax;
      this.frontMax = -Infinity;
      const previousFront = this.front - this.middleEnd;
      const previousMiddle = this.middleEnd - this.middleStart;
      if (previousFront <= previousMiddle + 1) {
        this.middleStart = this.middleEnd;
        this.middleEnd = this.front;
        this.working = this.middleEnd;
      } else {
        const middleLength = Math.floor((this.front - this.middleStart) / 2);
        this.middleStart = this.middleEnd;
        this.middleEnd += middleLength;
        const backLength = this.middleStart - this.back;
        this.working = this.middleStart + Math.min(backLength, this.middleEnd - this.middleStart);
        for (let i = this.middleEnd; i !== this.front; ++i) {
          this.frontMax = Math.max(this.frontMax, this.buffer[i & this.mask]);
        }
        for (let i = this.middleEnd - 1; i !== this.working - 1; --i) {
          const index = i & this.mask;
          this.buffer[index] = this.workingMax = Math.max(this.workingMax, this.buffer[index]);
        }
      }
      if (this.back === this.middleStart) {
        this.workingMax = -Infinity;
        this.middleMax = this.frontMax;
        this.frontMax = -Infinity;
        this.middleStart = this.working = this.middleEnd;
        if (this.back === this.middleStart) --this.back;
      }
      this.buffer[this.front & this.mask] = -Infinity;
    }
    ++this.back;
    if (this.working !== this.middleStart) {
      --this.working;
      const index = this.working & this.mask;
      this.buffer[index] = this.workingMax = Math.max(this.workingMax, this.buffer[index]);
    }
    return Math.max(this.buffer[this.back & this.mask], this.middleMax, this.frontMax);
  }
}

export class ReceiveBoxFilter {
  private buffer: Float64Array;
  private index = 0;
  private sum = 0;
  private wrapJump: number;
  constructor(private length: number) {
    this.buffer = new Float64Array(length + 1);
    for (let i = 0; i <= length; ++i) this.buffer[i] = i;
    this.wrapJump = length + 1;
  }
  reset() {
    for (let i = 0; i < this.buffer.length; ++i) this.buffer[i] = i;
    this.index = this.sum = 0;
    this.wrapJump = this.length + 1;
  }
  next(value: number): number {
    if (++this.index === this.buffer.length) {
      this.index = 0;
      this.wrapJump = this.sum;
      this.sum = 0;
    }
    this.sum += value;
    this.buffer[this.index] = this.sum;
    let read = this.index - this.length;
    let result = this.sum;
    if (read < 0) {
      result += this.wrapJump;
      read += this.buffer.length;
    }
    return (result - this.buffer[read]) / this.length;
  }
}

export class ReceiveLimiter {
  readonly latencySamples: number;
  private hold: ReceivePeakHold;
  private smoother: ReceiveBoxFilter;
  private delay: Float64Array[];
  private protectedSamples: Uint8Array;
  private index = 0;
  private released = 1;
  private releaseSlew: number;
  constructor(rate: number, private ceiling = Math.pow(10, -3 / 20), channels = 2) {
    this.latencySamples = Math.ceil(rate * 0.003);
    this.hold = new ReceivePeakHold(this.latencySamples + 1);
    this.smoother = new ReceiveBoxFilter(this.latencySamples + 1);
    this.delay = Array.from({ length: channels }, () => new Float64Array(this.latencySamples + 1));
    this.protectedSamples = new Uint8Array(this.latencySamples + 1);
    this.releaseSlew = Math.LN2 / (rate * 0.06 + Math.LN2);
  }
  reset() {
    this.hold.reset();
    this.smoother.reset();
    for (const channel of this.delay) channel.fill(0);
    this.protectedSamples.fill(0);
    this.index = 0;
    this.released = 1;
  }
  process(input: Float32Array[], output: Float32Array[], enabled: boolean): void {
    const length = output[0]?.length ?? 0;
    const channels = Math.min(output.length, this.delay.length);
    for (let i = 0; i < length; ++i) {
      this.protectedSamples[this.index] = enabled ? 1 : 0;
      let peak = this.ceiling;
      for (let c = 0; c < channels; ++c) {
        const raw = input[c]?.[i] ?? 0;
        const value = Number.isFinite(raw) ? raw : 0;
        this.delay[c][this.index] = value;
        peak = Math.max(peak, Math.abs(value));
      }
      const minGain = -this.hold.next(-this.ceiling / peak);
      this.released += (minGain - this.released) * this.releaseSlew;
      this.released = Math.min(minGain, this.released);
      const gain = Math.max(0, Math.min(1, this.smoother.next(this.released)));
      const read = (this.index + 1) % (this.latencySamples + 1);
      const protect = enabled || this.protectedSamples[read] !== 0;
      for (let c = 0; c < channels; ++c) {
        const delayed = this.delay[c][read];
        const value = protect ? delayed * gain : delayed;
        output[c][i] = protect ? Math.max(-this.ceiling, Math.min(this.ceiling, value)) : value;
      }
      for (let c = channels; c < output.length; ++c) output[c][i] = 0;
      this.index = read;
    }
  }
}

// Original receiver gain/compressor; energy activity gating is a heuristic, not a speech VAD.
export class ReceiveLeveler {
  gainDb = 0;
  private appliedGain = 1;
  private compression = 1;
  private peak = 0;
  private energy = 0;
  private count = 0;
  private activeSamples = 0;
  private quietSamples = 0;
  private noise = Math.pow(10, -55 / 20);
  private frame: number;
  private peakRelease: number;
  private attack: number;
  private release: number;
  private gainSlew: number;
  private wet = 0;
  private targetGain = 1;
  constructor(private rate: number) {
    this.frame = Math.max(1, Math.round(rate * 0.01));
    this.peakRelease = Math.exp(-1 / (rate * 0.08));
    this.attack = 1 - Math.exp(-1 / (rate * 0.002));
    this.release = 1 - Math.exp(-1 / (rate * 0.15));
    this.gainSlew = 1 - Math.exp(-1 / (rate * 0.01));
  }
  reset() {
    this.gainDb = this.peak = this.energy = this.count = this.activeSamples = this.quietSamples = this.wet = 0;
    this.appliedGain = this.compression = this.targetGain = 1;
    this.noise = Math.pow(10, -55 / 20);
  }
  process(input: Float32Array[], output: Float32Array[], enabled: boolean): void {
    const length = output[0]?.length ?? 0;
    if (!enabled) {
      if (this.gainDb !== 0 || this.peak !== 0 || this.wet !== 0) this.reset();
      for (let c = 0; c < output.length; ++c) for (let i = 0; i < length; ++i) {
        const raw = input[c]?.[i] ?? 0;
        output[c][i] = Number.isFinite(raw) ? raw : 0;
      }
      return;
    }
    for (let i = 0; i < length; ++i) {
      let peak = 0;
      for (let c = 0; c < output.length; ++c) {
        const raw = input[c]?.[i] ?? 0;
        if (Number.isFinite(raw)) peak = Math.max(peak, Math.abs(raw));
      }
      this.energy += peak * peak;
      if (++this.count === this.frame) {
        const rms = Math.sqrt(this.energy / this.count);
        const active = rms > Math.pow(10, -48 / 20) && rms > this.noise * 3;
        this.activeSamples = active ? this.activeSamples + this.count : 0;
        this.quietSamples = active ? 0 : this.quietSamples + this.count;
        if (!active) this.noise += (rms - this.noise) * (rms < this.noise ? 0.1 : 0.001);
        const level = 20 * Math.log10(Math.max(1e-9, rms));
        const noiseDb = 20 * Math.log10(Math.max(1e-9, this.noise));
        let target = Math.max(-9, Math.min(9, -24 - level, -42 - noiseDb));
        if (this.quietSamples > this.rate * 0.5) target = 0;
        const upAllowed = this.activeSamples >= this.rate * 0.1 || this.quietSamples > this.rate * 0.5;
        const difference = target - this.gainDb;
        this.gainDb += Math.max(-0.06, Math.min(upAllowed ? 0.015 : 0, difference));
        this.targetGain = Math.pow(10, this.gainDb / 20);
        this.energy = this.count = 0;
      }
      this.wet = Math.max(0, Math.min(1, this.wet + (enabled ? 1 : -1) / (this.rate * 0.01)));
      this.appliedGain += (this.targetGain - this.appliedGain) * this.gainSlew;
      this.peak = Math.max(peak * this.appliedGain, this.peak * this.peakRelease);
      const threshold = Math.pow(10, -18 / 20);
      const over = 20 * Math.log10(Math.max(1e-9, this.peak) / threshold);
      const reduction = over <= -3 ? 0 : over >= 3 ? -0.75 * over : -0.75 * (over + 3) ** 2 / 12;
      const target = Math.pow(10, reduction / 20);
      this.compression += (target - this.compression) * (target < this.compression ? this.attack : this.release);
      for (let c = 0; c < output.length; ++c) {
        const raw = input[c]?.[i] ?? 0;
        output[c][i] = Number.isFinite(raw) ? raw * (1 + (this.appliedGain * this.compression - 1) * this.wet) : 0;
      }
    }
  }
}
