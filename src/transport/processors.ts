/** The own transport's AudioWorklet processors (GRYT-1818), joined with what they use into one source
    string by scripts/build-worklet-source.ts. Never imported: it only runs inside a worklet. */

import { loadOpus, type OpusDecoder, type OpusEncoder } from "../codec/opus";
import { type VoiceEffectSettings, VoiceEffects } from "../audio/voiceEffects";
import { JitterBuffer } from "./jitterBuffer";
import { FLAG_PROBE, FLAG_SPEAKING, readForwarded, writePacket } from "./packet";
import { type Probe, PROBE_EVERY_S, PROBE_PING, PROBE_PONG, readProbe, writeProbe } from "./probe";
import { RECEIVE_PROCESSOR, SEND_PROCESSOR } from "./workletNames";

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: object);
}
declare function registerProcessor(name: string, ctor: new (options: never) => AudioWorkletProcessor): void;

export interface SendOptions {
  wasm: ArrayBuffer;
  frame: number;
  bitrate: number;
  stereoBitrate: number;
  settings: VoiceEffectSettings;
}

export interface ReceiveOptions {
  wasm: ArrayBuffer;
  frame: number;
}

/** Mic in, packets out on the port: effects, then one Opus packet per frame. */
class SendProcessor extends AudioWorkletProcessor {
  private readonly effects: VoiceEffects;
  private readonly frame: Float32Array;
  private readonly stereoFrame: Float32Array;
  private filled = 0;
  private encoder: OpusEncoder | null = null;
  private stereoEncoder: OpusEncoder | null = null;
  /** Frames left to send in stereo: two seconds past the last time left and right differed. */
  private stereoFor = 0;
  private sending = true;
  private seq = 0;
  private timestamp = 0;
  private probeAt = 0;
  /** Pings heard by the receive worklet, to answer: their nonce and when they arrived, in ms. */
  private pongs: { nonce: number; at: number }[] = [];

  constructor(options: { processorOptions: SendOptions }) {
    super(options);
    const o = options.processorOptions;
    this.effects = new VoiceEffects(sampleRate, o.settings);
    this.frame = new Float32Array(o.frame);
    this.stereoFrame = new Float32Array(o.frame * 2);
    loadOpus(o.wasm).then((opus) => {
      this.encoder = opus.encoder({ frame: o.frame, bitrate: o.bitrate });
      this.stereoEncoder = opus.encoder({ frame: o.frame, bitrate: o.stereoBitrate, channels: 2 });
    });
    this.port.onmessage = (e: MessageEvent<{ type: string; settings?: VoiceEffectSettings; on?: boolean; nonce?: number; at?: number }>) => {
      if (e.data.type === "settings" && e.data.settings) this.effects.set(e.data.settings);
      if (e.data.type === "sending") this.sending = !!e.data.on;
      if (e.data.type === "pong" && e.data.nonce !== undefined && e.data.at !== undefined) this.pongs.push({ nonce: e.data.nonce, at: e.data.at });
    };
  }

  /** Under the last audio packet's seq and timestamp, so an older client drops it rather than decoding it. */
  private sendProbe(probe: Probe) {
    const bytes = writePacket({ flags: FLAG_PROBE, seq: (this.seq - 1) & 0xffff, timestamp: this.timestamp, opus: writeProbe(probe) });
    this.port.postMessage(bytes, [bytes.buffer]);
  }

  /** Pongs go out muted too, so someone listening still has a round trip; pings only while sending. */
  private probe() {
    for (const p of this.pongs.splice(0)) this.sendProbe({ kind: PROBE_PONG, nonce: p.nonce, holdMs: currentTime * 1000 - p.at });
    if (!this.sending || currentTime - this.probeAt < PROBE_EVERY_S) return;
    this.probeAt = currentTime;
    const nonce = (Math.random() * 0x100000000) >>> 0;
    this.sendProbe({ kind: PROBE_PING, nonce });
    this.port.postMessage({ pingSent: nonce, at: currentTime * 1000 });
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    this.probe();
    const block = Float32Array.from(input);
    // Stereo only when the sides really differ: a mono mic, or one copied to both, stays mono at its own bitrate.
    const right = inputs[0][1] && Float32Array.from(inputs[0][1]);
    if (right && block.some((v, i) => Math.abs(v - right[i]) > 1e-4)) this.stereoFor = 2 * sampleRate / this.frame.length;
    this.effects.process(block, right);
    for (let i = 0; i < block.length; i++) {
      const r = right ? right[i] : block[i];
      this.stereoFrame[2 * this.filled] = block[i];
      this.stereoFrame[2 * this.filled + 1] = r;
      this.frame[this.filled++] = (block[i] + r) / 2;
      if (this.filled < this.frame.length) continue;
      this.filled = 0;
      const stereo = this.stereoFor > 0 ? this.stereoEncoder : null;
      if (this.stereoFor > 0) this.stereoFor--;
      // The timestamp moves on while muted, so the far side's clock stays right across a pause.
      if (this.sending && this.encoder) {
        const bytes = writePacket({
          flags: this.effects.open ? FLAG_SPEAKING : 0,
          seq: this.seq,
          timestamp: this.timestamp,
          opus: stereo ? stereo.encode(this.stereoFrame) : this.encoder.encode(this.frame),
        });
        this.port.postMessage(bytes, [bytes.buffer]);
        this.seq = (this.seq + 1) & 0xffff;
      }
      this.timestamp = (this.timestamp + this.frame.length) >>> 0;
    }
    return true;
  }
}

interface Sender {
  jitter: JitterBuffer;
  decoder: OpusDecoder;
  pending: Float32Array<ArrayBufferLike>;
  lastHeard: number;
  /** When a packet played last carried the speaking flag (GRYT-1830). */
  lastSpeaking: number;
  /** Mean square of what played from them in the last block, for the halo. */
  power: number;
}

// A muted sender stops sending, so a ring goes out this long after the last speaking packet.
const SPEAKING_HOLD_S = 0.25;
// Levels go out about twenty times a second: often enough for a halo, rarely enough to cost nothing.
const LEVELS_EVERY_S = 0.05;

/** What the receive worklet tells the page: who is speaking when that changes, and levels in dBFS by sender. */
export type ReceiveReport = { speaking: number[] } | { levels: [number, number][]; buffered: [number, number][]; rtt: [number, number][] };

/** How many of this client's pings wait for answers; older ones are forgotten. */
const MAX_PINGS = 8;

/** Forwarded packets in on the port, everyone mixed out: a jitter buffer and a decoder per sender. */
class ReceiveProcessor extends AudioWorkletProcessor {
  private readonly frameSize: number;
  private readonly senders = new Map<number, Sender>();
  private speakingKey = "";
  /** Per-sender volume, 1 for anyone not named: a user's own volume for someone (GRYT-1831). */
  private gains = new Map<number, number>();
  private levelsAt = 0;
  private opus: Awaited<ReturnType<typeof loadOpus>> | null = null;
  /** This client's recent pings by nonce with when they went (ms), and round trips by sender: out, back, minus the hold. */
  private pings = new Map<number, number>();
  private rtt = new Map<number, number>();

  constructor(options: { processorOptions: ReceiveOptions }) {
    super(options);
    this.frameSize = options.processorOptions.frame;
    loadOpus(options.processorOptions.wasm).then((opus) => (this.opus = opus));
    this.port.onmessage = (e: MessageEvent<Uint8Array | { gains: [number, number][] } | { pingSent: number; at: number }>) => {
      if (e.data instanceof Uint8Array) this.receive(e.data);
      else if ("pingSent" in e.data) {
        this.pings.set(e.data.pingSent, e.data.at);
        for (const nonce of this.pings.keys()) if (this.pings.size > MAX_PINGS) this.pings.delete(nonce);
      } else this.gains = new Map(e.data.gains);
    };
  }

  private receive(bytes: Uint8Array) {
    const forwarded = readForwarded(bytes);
    if (!forwarded || !this.opus) return;
    if (forwarded.packet.flags & FLAG_PROBE) {
      const probe = readProbe(forwarded.packet.opus);
      const now = currentTime * 1000;
      if (probe?.kind === PROBE_PING) this.port.postMessage({ ping: probe.nonce, at: now });
      const sent = probe?.kind === PROBE_PONG ? this.pings.get(probe.nonce) : undefined;
      if (probe?.kind === PROBE_PONG && sent !== undefined) this.rtt.set(forwarded.sender, now - sent - probe.holdMs);
      return;
    }
    let s = this.senders.get(forwarded.sender);
    if (!s) {
      s = {
        jitter: new JitterBuffer({ frameMs: (this.frameSize / sampleRate) * 1000 }),
        // Always stereo out: a mono packet comes out on both sides.
        decoder: this.opus.decoder(this.frameSize, 2),
        pending: new Float32Array(0),
        lastHeard: currentTime,
        lastSpeaking: -Infinity,
        power: 0,
      };
      this.senders.set(forwarded.sender, s);
    }
    s.lastHeard = currentTime;
    s.jitter.push(forwarded.packet, currentTime * 1000);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const outRight = outputs[0][1] ?? out;
    out.fill(0);
    outRight.fill(0);
    for (const [id, s] of this.senders) {
      // Someone silent for 10 s has left or muted: free their decoder until they speak again.
      if (currentTime - s.lastHeard > 10) {
        s.decoder.destroy();
        this.senders.delete(id);
        this.rtt.delete(id);
        continue;
      }
      // Pending is interleaved stereo, as the decoder gives it.
      while (s.pending.length < out.length * 2) {
        const next = s.jitter.pull();
        let pcm: Float32Array<ArrayBufferLike> = new Float32Array(this.frameSize * 2);
        if (next.kind === "packet") {
          pcm = s.decoder.decode(next.packet.opus);
          if (next.packet.flags & FLAG_SPEAKING) s.lastSpeaking = currentTime;
        }
        else if (next.kind === "lost") pcm = s.decoder.decode(null);
        const joined = new Float32Array(s.pending.length + pcm.length);
        joined.set(s.pending);
        joined.set(pcm, s.pending.length);
        s.pending = joined;
      }
      let sum = 0;
      const gain = this.gains.get(id) ?? 1;
      for (let i = 0; i < out.length; i++) {
        out[i] += s.pending[2 * i] * gain;
        if (outRight !== out) outRight[i] += s.pending[2 * i + 1] * gain;
        sum += s.pending[2 * i] ** 2 + s.pending[2 * i + 1] ** 2;
      }
      s.power = sum / (out.length * 2);
      s.pending = s.pending.subarray(out.length * 2);
    }
    // Who is speaking as heard, so a ring lights with the voice; sent only when it changes.
    const speaking = [...this.senders].filter(([, s]) => currentTime - s.lastSpeaking < SPEAKING_HOLD_S).map(([id]) => id);
    const key = speaking.join(",");
    if (key !== this.speakingKey) {
      this.speakingKey = key;
      this.port.postMessage({ speaking } satisfies ReceiveReport);
    }
    if (currentTime - this.levelsAt >= LEVELS_EVERY_S) {
      this.levelsAt = currentTime;
      const levels = [...this.senders].map(([id, s]): [number, number] => [id, s.power > 0 ? 10 * Math.log10(s.power) : -120]);
      // Waiting to play, in ms: the jitter buffer plus decoded samples not out yet. For the latency estimate.
      const buffered = [...this.senders].map(([id, s]): [number, number] => [id, s.jitter.depthMs + (s.pending.length / 2 / sampleRate) * 1000]);
      this.port.postMessage({ levels, buffered, rtt: [...this.rtt] } satisfies ReceiveReport);
    }
    return true;
  }
}

registerProcessor(SEND_PROCESSOR, SendProcessor);
registerProcessor(RECEIVE_PROCESSOR, ReceiveProcessor);
