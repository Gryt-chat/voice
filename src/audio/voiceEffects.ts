/**
 * The microphone effects, sample by sample with no lookahead, for the own voice transport (GRYT-1819).
 * No imports and no Web Audio, so an AudioWorklet can run it as it is. Same settings as the graph's.
 */

export interface VoiceEffectSettings {
  /** The volume slider, 0–200 %, 100 = unchanged. */
  volume: number;
  /** The gate slider, 0–100 on the meter's scale. 0 means no gate. */
  gateThreshold: number;
  gateReleaseMs: number;
  /** Level smoothing, as AnalyserNode.smoothingTimeConstant: 0.8, or 0.3 in eSports. */
  gateSmoothing: number;
  autoGain: boolean;
  autoGainTargetDb: number;
  compressor: boolean;
  /** The compressor slider, 0–100. */
  compressorAmount: number;
  /** Whether the soft limiter runs. The graph runs it whenever any processing does. */
  limiter: boolean;
}

/* The gate meter's window, as the AnalyserNode the gate replaced (noiseGateProcessor.ts). */
const METER_MIN_DB = -100;
const METER_MAX_DB = -30;
const GATE_RAMP_SECONDS = 0.01;
/* The graph's compressor: 3 ms attack, 250 ms release, +3 dB makeup (microphonePipeline.ts). */
const COMPRESSOR_ATTACK_SECONDS = 0.003;
const COMPRESSOR_RELEASE_SECONDS = 0.25;
const COMPRESSOR_MAKEUP_DB = 3;
/* Auto gain as the graph's 50 ms loop: +12 dB at most, peak kept under -6 dBFS. */
const AGC_STEP_SECONDS = 0.05;
const AGC_SILENCE = 0.001;
const AGC_MIN_GAIN = 0.1;
const AGC_MAX_GAIN = 4;
const AGC_PEAK_CEILING = Math.pow(10, -6 / 20);
const AGC_SMOOTH_UP = 0.02;
const AGC_SMOOTH_DOWN = 0.5;
const AGC_GLIDE_SECONDS = 0.05;
/* The soft clip at -1 dBFS, the curve the graph's WaveShaper draws, applied directly. */
const CEILING = Math.pow(10, -1 / 20);

const dbToGain = (db: number) => Math.pow(10, db / 20);

export class VoiceEffects {
  private settings: VoiceEffectSettings;
  private readonly sampleRate: number;
  private level = 0;
  private gateGain = 1;
  private gateOpen = true;
  private holdSamples = 0;
  private compEnv = 0;
  private agcTarget = 1;
  private agcGain = 1;
  private agcSum = 0;
  private agcPeak = 0;
  private agcCount = 0;

  constructor(sampleRate: number, settings: VoiceEffectSettings) {
    this.sampleRate = sampleRate;
    this.settings = settings;
  }

  set(settings: VoiceEffectSettings): void {
    this.settings = settings;
  }

  /** The gate's smoothed level, 0–100, the number the gate slider is compared with. */
  get meter(): number {
    return this.level;
  }

  get open(): boolean {
    return this.gateOpen;
  }

  /** In place. Every output sample depends only on samples up to it. */
  process(block: Float32Array): void {
    const s = this.settings;
    const sr = this.sampleRate;
    const volume = Math.max(0, s.volume) / 100;

    // The gate decides once a block on the block's level, measured after the volume, as the graph does.
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * volume * (block[i] * volume);
    const rms = Math.sqrt(sum / Math.max(1, block.length));
    const db = rms > 0 ? 20 * Math.log10(rms) : METER_MIN_DB;
    const clamped = Math.min(METER_MAX_DB, Math.max(METER_MIN_DB, db));
    const instant = ((clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100;
    this.level = s.gateSmoothing * this.level + (1 - s.gateSmoothing) * instant;

    if (s.gateThreshold <= 0) {
      this.gateOpen = true;
    } else if (this.level >= s.gateThreshold) {
      this.gateOpen = true;
      this.holdSamples = (s.gateReleaseMs / 1000) * sr;
    } else if (this.gateOpen) {
      this.holdSamples -= block.length;
      if (this.holdSamples <= 0) this.gateOpen = false;
    }

    const gateTarget = this.gateOpen ? 1 : 0;
    const gateStep = 1 / (GATE_RAMP_SECONDS * sr);
    const attack = Math.exp(-1 / (COMPRESSOR_ATTACK_SECONDS * sr));
    const release = Math.exp(-1 / (COMPRESSOR_RELEASE_SECONDS * sr));
    // The slider mapping the graph's compressor uses.
    const t = s.compressorAmount / 100;
    const threshold = -10 + t * -30;
    const ratio = 1 + t * 19;
    const makeup = s.compressorAmount > 0 ? dbToGain(COMPRESSOR_MAKEUP_DB) : 1;
    const agcGlide = 1 - Math.exp(-1 / (AGC_GLIDE_SECONDS * sr));
    const agcStep = Math.round(AGC_STEP_SECONDS * sr);
    const agcWanted = dbToGain(s.autoGainTargetDb);

    for (let i = 0; i < block.length; i++) {
      let x = block[i] * volume;

      if (s.autoGain) {
        // Measured on what comes in, applied with a glide, so a word never waits for its own level.
        this.agcSum += x * x;
        this.agcPeak = Math.max(this.agcPeak, Math.abs(x));
        if (++this.agcCount >= agcStep) {
          const r = Math.sqrt(this.agcSum / this.agcCount);
          if (r > AGC_SILENCE) {
            const desired = Math.min(agcWanted / r, AGC_PEAK_CEILING / Math.max(this.agcPeak, 1e-6));
            const want = Math.max(AGC_MIN_GAIN, Math.min(AGC_MAX_GAIN, desired));
            this.agcTarget += (want - this.agcTarget) * (want > this.agcTarget ? AGC_SMOOTH_UP : AGC_SMOOTH_DOWN);
          }
          this.agcSum = 0;
          this.agcPeak = 0;
          this.agcCount = 0;
        }
        this.agcGain += (this.agcTarget - this.agcGain) * agcGlide;
        x *= this.agcGain;
      }

      if (s.compressor) {
        const a = Math.abs(x);
        this.compEnv = a > this.compEnv ? attack * this.compEnv + (1 - attack) * a : release * this.compEnv + (1 - release) * a;
        const envDb = 20 * Math.log10(this.compEnv + 1e-9);
        const over = envDb - threshold;
        if (over > 0) x *= dbToGain(-over * (1 - 1 / ratio));
        x *= makeup;
      }

      if (s.limiter) x = CEILING * Math.tanh(x / CEILING);

      if (this.gateGain < gateTarget) this.gateGain = Math.min(gateTarget, this.gateGain + gateStep);
      else if (this.gateGain > gateTarget) this.gateGain = Math.max(gateTarget, this.gateGain - gateStep);
      block[i] = x * this.gateGain;
    }
  }
}
