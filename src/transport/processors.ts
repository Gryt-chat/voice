/** The own transport's AudioWorklet processors (GRYT-1818), joined with what they use into one source
    string by scripts/build-worklet-source.ts. Never imported: it only runs inside a worklet. */

import { loadOpus, type OpusDecoder, type OpusEncoder } from "../codec/opus";
import { type VoiceEffectSettings, VoiceEffects } from "../audio/voiceEffects";
import { JitterBuffer } from "./jitterBuffer";
import { FLAG_SPEAKING, readForwarded, writePacket } from "./packet";
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
    this.port.onmessage = (e: MessageEvent<{ type: string; settings?: VoiceEffectSettings; on?: boolean }>) => {
      if (e.data.type === "settings" && e.data.settings) this.effects.set(e.data.settings);
      if (e.data.type === "sending") this.sending = !!e.data.on;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
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
}

/** Forwarded packets in on the port, everyone mixed out: a jitter buffer and a decoder per sender. */
class ReceiveProcessor extends AudioWorkletProcessor {
  private readonly frameSize: number;
  private readonly senders = new Map<number, Sender>();
  private opus: Awaited<ReturnType<typeof loadOpus>> | null = null;

  constructor(options: { processorOptions: ReceiveOptions }) {
    super(options);
    this.frameSize = options.processorOptions.frame;
    loadOpus(options.processorOptions.wasm).then((opus) => (this.opus = opus));
    this.port.onmessage = (e: MessageEvent<Uint8Array>) => this.receive(e.data);
  }

  private receive(bytes: Uint8Array) {
    const forwarded = readForwarded(bytes);
    if (!forwarded || !this.opus) return;
    let s = this.senders.get(forwarded.sender);
    if (!s) {
      s = {
        jitter: new JitterBuffer({ frameMs: (this.frameSize / sampleRate) * 1000 }),
        // Always stereo out: a mono packet comes out on both sides.
        decoder: this.opus.decoder(this.frameSize, 2),
        pending: new Float32Array(0),
        lastHeard: currentTime,
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
        continue;
      }
      // Pending is interleaved stereo, as the decoder gives it.
      while (s.pending.length < out.length * 2) {
        const next = s.jitter.pull();
        let pcm: Float32Array<ArrayBufferLike> = new Float32Array(this.frameSize * 2);
        if (next.kind === "packet") pcm = s.decoder.decode(next.packet.opus);
        else if (next.kind === "lost") pcm = s.decoder.decode(null);
        const joined = new Float32Array(s.pending.length + pcm.length);
        joined.set(s.pending);
        joined.set(pcm, s.pending.length);
        s.pending = joined;
      }
      for (let i = 0; i < out.length; i++) {
        out[i] += s.pending[2 * i];
        if (outRight !== out) outRight[i] += s.pending[2 * i + 1];
      }
      s.pending = s.pending.subarray(out.length * 2);
    }
    return true;
  }
}

registerProcessor(SEND_PROCESSOR, SendProcessor);
registerProcessor(RECEIVE_PROCESSOR, ReceiveProcessor);
