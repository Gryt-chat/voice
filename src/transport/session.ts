/** The own voice transport on the main thread (GRYT-1818): one WebTransport session to the SFU, the send
    worklet feeding it and the receive worklet playing what comes back. */

import type { VoiceEffectSettings } from "../audio/voiceEffects";
import type { VoiceConfig } from "../types";

import type { ReceiveOptions, SendOptions } from "./processors";
import { RECEIVE_PROCESSOR, SEND_PROCESSOR } from "./workletNames";
import { TRANSPORT_WORKLET_SOURCE } from "./workletSource";

/** What room_joined offers: where to dial, the cert hash to pin, and a one-use ticket. */
export interface AudioTransportOffer {
  urls: string[];
  certHash: string;
  ticket: string;
}

export interface AudioTransportSession {
  /** The offered address that answered first. */
  url: string;
  /** Swap the microphone stream, after the pipeline is rebuilt. */
  setInput(stream: MediaStream): void;
  /** Mute and push to talk. The timestamp keeps moving while off. */
  setSending(on: boolean): void;
  setEffects(settings: VoiceEffectSettings): void;
  /** Gain for everything heard: 0 when deafened. */
  setOutputGain(gain: number): void;
  close(): void;
  /** Settles when the session ends, for whatever reason. */
  closed: Promise<void>;
}

// 2.5 ms CELT frames; the transport exists for the latency.
const FRAME = 120;
// Sivert's listening test: 96 kbps is the least that holds up, 192 sounds the same as the original.
const BITRATE = 192_000;
// 256 sounded like the original song in stereo. Only used while the mic's two sides really differ.
const STEREO_BITRATE = 256_000;
// For a stream the microphone pipeline already processed.
export const PASS_THROUGH: VoiceEffectSettings = {
  volume: 100, gateThreshold: 0, gateReleaseMs: 200, gateSmoothing: 0.8, autoGain: false,
  autoGainTargetDb: -20, compressor: false, compressorAmount: 50, limiter: false,
};

/** The user's settings as the worklet's effects, chosen the way the graph chooses (microphonePipeline.ts). */
type EffectInputs = Pick<
  VoiceConfig["audio"], "volume" | "noiseGate" | "noiseGateRelease" | "autoGain" | "compressorEnabled" | "compressorAmount"
>;

export function transportEffects(audio: EffectInputs, eSports: boolean): VoiceEffectSettings {
  const lean = eSports || (!audio.autoGain.enabled && !audio.compressorEnabled);
  return {
    volume: audio.volume,
    gateThreshold: audio.noiseGate,
    gateReleaseMs: audio.noiseGateRelease,
    gateSmoothing: eSports ? 0.3 : 0.8,
    autoGain: audio.autoGain.enabled && !lean,
    autoGainTargetDb: audio.autoGain.targetDb,
    compressor: audio.compressorEnabled && !lean,
    compressorAmount: audio.compressorAmount,
    limiter: !lean,
  };
}

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

function loadWorklets(context: AudioContext): Promise<void> {
  let p = loaded.get(context);
  if (!p) {
    const url = URL.createObjectURL(new Blob([TRANSPORT_WORKLET_SOURCE], { type: "text/javascript" }));
    p = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loaded.set(context, p);
  }
  return p;
}

export const audioTransportSupported = (): boolean => typeof WebTransport === "function";

/** Dial the SFU and start sending `input` and playing into `output`. Rejects if the handshake fails. */
export async function startAudioTransport(o: {
  offer: AudioTransportOffer;
  context: AudioContext;
  input: MediaStream;
  output: AudioNode;
  wasm: ArrayBuffer;
  effects: VoiceEffectSettings;
  /** The sender ids heard speaking, each time that changes (GRYT-1830). */
  onSpeaking?: (senders: number[]) => void;
}): Promise<AudioTransportSession> {
  const value = Uint8Array.from(atob(o.offer.certHash), (c) => c.charCodeAt(0));
  const dialed = new Map<WebTransport, string>();
  const dial = (url: string) => {
    const t = new WebTransport(`${url}?ticket=${encodeURIComponent(o.offer.ticket)}`, {
      serverCertificateHashes: [{ algorithm: "sha-256", value }],
    });
    dialed.set(t, url);
    return t.ready.then(() => t, (error: Error) => {
      t.close();
      throw error;
    });
  };
  // Every address at once, like ICE: the LAN one wins on the SFU's own network. The ticket is single use, so the rest get a 401.
  const attempts = o.offer.urls.map(dial);
  const first = new Promise<WebTransport>((resolve, reject) => {
    let left = attempts.length;
    for (const a of attempts) a.then(resolve, (error: Error) => --left === 0 && reject(error));
  });
  const wt = await Promise.all([first, loadWorklets(o.context)]).then(([t]) => t, (error: Error) => {
    for (const a of attempts) a.then((t) => t.close(), () => undefined);
    throw error;
  });
  for (const a of attempts) a.then((t) => t !== wt && t.close(), () => undefined);

  const sendOptions: SendOptions = { wasm: o.wasm.slice(0), frame: FRAME, bitrate: BITRATE, stereoBitrate: STEREO_BITRATE, settings: o.effects };
  const receiveOptions: ReceiveOptions = { wasm: o.wasm.slice(0), frame: FRAME };
  const send = new AudioWorkletNode(o.context, SEND_PROCESSOR, { processorOptions: sendOptions });
  const receive = new AudioWorkletNode(o.context, RECEIVE_PROCESSOR, { numberOfInputs: 0, outputChannelCount: [2], processorOptions: receiveOptions });
  // A node nothing pulls from never runs, so the send worklet ends in a silent gain.
  const sink = o.context.createGain();
  sink.gain.value = 0;
  send.connect(sink).connect(o.context.destination);
  const gain = o.context.createGain();
  receive.connect(gain).connect(o.output);

  let source = o.context.createMediaStreamSource(o.input);
  source.connect(send);

  const writer = wt.datagrams.writable.getWriter();
  // A full queue or a closed session loses the packet; audio doesn't wait.
  send.port.onmessage = (e: MessageEvent<Uint8Array>) => void writer.write(e.data).catch(() => undefined);
  receive.port.onmessage = (e: MessageEvent<number[]>) => o.onSpeaking?.(e.data);
  const reader = wt.datagrams.readable.getReader();
  void (async () => {
    for (;;) {
      const { value: d, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !d) return;
      receive.port.postMessage(d, [d.buffer]);
    }
  })();

  const closed = wt.closed.then(() => undefined, () => undefined).finally(() => {
    send.port.onmessage = null;
    receive.port.onmessage = null;
    o.onSpeaking?.([]);
    source.disconnect();
    send.disconnect();
    receive.disconnect();
    gain.disconnect();
    sink.disconnect();
  });

  return {
    url: dialed.get(wt) ?? o.offer.urls[0],
    setInput(stream) {
      source.disconnect();
      source = o.context.createMediaStreamSource(stream);
      source.connect(send);
    },
    setSending(on) {
      send.port.postMessage({ type: "sending", on });
    },
    setEffects(settings) {
      send.port.postMessage({ type: "settings", settings });
    },
    setOutputGain(g) {
      gain.gain.setValueAtTime(g, o.context.currentTime);
    },
    close() {
      wt.close();
    },
    closed,
  };
}
