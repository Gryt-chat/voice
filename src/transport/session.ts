/** The own voice transport on the main thread (GRYT-1818): one WebTransport session to the SFU, the send
    worklet feeding it and the receive worklet playing what comes back. */

import type { VoiceEffectSettings } from "../audio/voiceEffects";
import type { VoiceConfig } from "../types";

import type { ReceiveOptions, ReceiveReport, SendOptions } from "./processors";
import { RECEIVE_PROCESSOR, SEND_PROCESSOR } from "./workletNames";
import { TRANSPORT_WORKLET_SOURCE } from "./workletSource";

/** What room_joined offers: where to dial, the cert hash to pin, and a one-use ticket. */
export interface AudioTransportOffer {
  urls: string[];
  certHash: string;
  ticket: string;
  /** The native engine's plain UDP (GRYT-1822), when the SFU runs it. */
  udp?: AudioUDPOffer;
  /** The video hub's /video and its own ticket, when the SFU runs it (GRYT-2261). `ws` when it also serves /video-ws. */
  video?: { urls: string[]; ticket: string; ws?: boolean };
}

/** A session id and its key; a packet that opens with the key is the only proof the SFU needs. */
export interface AudioUDPOffer {
  addrs: string[];
  session: number;
  key: string;
  /** The SFU answers a keep-alive and serves /audio-ws, so the engine may fall back to it (GRYT-2431). */
  ws?: boolean;
}

export interface AudioTransportSession {
  /** The offered address that answered first. */
  url: string;
  /** Swap the microphone stream, after the pipeline is rebuilt. */
  setInput(stream: MediaStream): void;
  /** Mute and push to talk. The timestamp keeps moving while off. */
  setSending(on: boolean): void;
  setEffects(settings: VoiceEffectSettings): void;
  /** Mono bits per second; stereo follows at 4/3 of it. */
  setBitrate(bitrate: number): void;
  /** Gain for everything heard: 0 when deafened. */
  setOutputGain(gain: number): void;
  /** Volume per sender id on top of that, 1 for anyone not named (GRYT-1831). */
  setSenderGains(gains: Map<number, number>): void;
  close(): void;
  /** Settles when the session ends, for whatever reason. */
  closed: Promise<void>;
}

// 2.5 ms CELT frames; the transport exists for the latency.
const FRAME = 120;
export const TRANSPORT_FRAME_MS = 2.5;
// Sivert's listening test: 96 kbps is the least that holds up. 510, Opus's ceiling, is the default,
// since a 2.5 ms frame gets about 60 bytes at 192 and 160 at 510.
export const TRANSPORT_BITRATE = { min: 96_000, max: 510_000 };
// 256 sounded like the original song in stereo at 192 mono. Only used while the mic's two sides really differ.
const stereoFor = (bitrate: number) => Math.min(TRANSPORT_BITRATE.max, Math.round((bitrate * 4) / 3));
const clampBitrate = (bitrate: number) => Math.min(TRANSPORT_BITRATE.max, Math.max(TRANSPORT_BITRATE.min, bitrate));
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

/** How long WebTransport gets before the WebSocket fallback is tried: blocked UDP fails by timing out. */
const WEBTRANSPORT_WAIT_MS = 3000;
/** Past this much unsent, a WebSocket packet is dropped: TCP would queue it, and late audio is useless. */
const WS_MAX_BUFFERED = 16 * 1024;

/** Packets both ways to the SFU, over WebTransport datagrams or the WebSocket fallback (GRYT-1831). */
export interface Pipe {
  url: string;
  send(packet: Uint8Array): void;
  /** WebTransport's own numbers, where the browser has getStats(). */
  stats?(): Promise<WebTransportConnectionStats>;
  listen(onPacket: (packet: Uint8Array) => void): void;
  close(): void;
  closed: Promise<void>;
}

export async function dialWebTransport(offer: Pick<AudioTransportOffer, "urls" | "certHash" | "ticket">): Promise<Pipe> {
  const value = Uint8Array.from(atob(offer.certHash), (c) => c.charCodeAt(0));
  const dialed = new Map<WebTransport, string>();
  const dial = (url: string) => {
    const t = new WebTransport(`${url}?ticket=${encodeURIComponent(offer.ticket)}`, {
      serverCertificateHashes: [{ algorithm: "sha-256", value }],
    });
    dialed.set(t, url);
    return t.ready.then(() => t, (error: Error) => {
      t.close();
      throw error;
    });
  };
  // Every address at once, like ICE: the LAN one wins on the SFU's own network. The ticket is single use, so the rest get a 401.
  const attempts = offer.urls.map(dial);
  const giveUp = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("WebTransport timed out")), WEBTRANSPORT_WAIT_MS));
  const first = new Promise<WebTransport>((resolve, reject) => {
    let left = attempts.length;
    for (const a of attempts) a.then(resolve, (error: Error) => --left === 0 && reject(error));
  });
  const wt = await Promise.race([first, giveUp]).catch((error: Error) => {
    for (const a of attempts) a.then((t) => t.close(), () => undefined);
    throw error;
  });
  for (const a of attempts) a.then((t) => t !== wt && t.close(), () => undefined);
  const writer = wt.datagrams.writable.getWriter();
  return {
    url: dialed.get(wt) ?? offer.urls[0],
    // A full queue or a closed session loses the packet; audio doesn't wait.
    send: (packet) => void writer.write(packet).catch(() => undefined),
    ...("getStats" in wt ? { stats: () => (wt as WebTransport & { getStats(): Promise<WebTransportConnectionStats> }).getStats() } : {}),
    listen(onPacket) {
      const reader = wt.datagrams.readable.getReader();
      void (async () => {
        for (;;) {
          const { value: d, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done || !d) return;
          onPacket(d);
        }
      })();
    },
    close: () => wt.close(),
    closed: wt.closed.then(() => undefined, () => undefined),
  };
}

function dialWebSocket(url: string, ticket: string, maxBuffered: number): Promise<Pipe> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?ticket=${encodeURIComponent(ticket)}`);
    ws.binaryType = "arraybuffer";
    const closed = new Promise<void>((done) => ws.addEventListener("close", () => done()));
    ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
    ws.addEventListener("close", () => reject(new Error("WebSocket closed")), { once: true });
    ws.addEventListener("open", () => resolve({
      url,
      send(packet) {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < maxBuffered) ws.send(packet);
      },
      listen(onPacket) {
        ws.addEventListener("message", (e: MessageEvent<ArrayBuffer>) => onPacket(new Uint8Array(e.data)));
      },
      close: () => ws.close(),
      closed,
    }), { once: true });
  });
}

/** WebTransport where it works, else the WebSocket fallback at `wsUrl` when there is one. */
export async function dialPipe(
  offer: Pick<AudioTransportOffer, "urls" | "certHash" | "ticket">, wsUrl: string | undefined, maxBuffered = WS_MAX_BUFFERED,
): Promise<Pipe> {
  if (audioTransportSupported()) {
    try {
      return await dialWebTransport(offer);
    } catch (error) {
      if (!wsUrl) throw error;
    }
  }
  if (!wsUrl) throw new Error("no WebTransport and no WebSocket fallback");
  return dialWebSocket(wsUrl, offer.ticket, maxBuffered);
}

/** Dial the SFU and start sending `input` and playing into `output`. Rejects if the handshake fails. */
export async function startAudioTransport(o: {
  offer: AudioTransportOffer;
  context: AudioContext;
  input: MediaStream;
  output: AudioNode;
  wasm: ArrayBuffer;
  effects: VoiceEffectSettings;
  /** Mono bits per second, clamped to TRANSPORT_BITRATE. */
  bitrate?: number;
  /** The SFU's /audio-ws, for when WebTransport is missing or blocked (GRYT-1831). */
  wsUrl?: string;
  /** The sender ids heard speaking, each time that changes (GRYT-1830). */
  onSpeaking?: (senders: number[]) => void;
  /** Each sender's level in dBFS, about twenty times a second, for a halo (GRYT-1830). */
  onLevels?: (levels: Map<number, number>) => void;
  /** Each sender's audio waiting to play, in ms, with the levels: for the latency estimate. */
  onBuffered?: (buffered: Map<number, number>) => void;
  /** Measured round trips by sender, in ms, with the levels (GRYT-1836). */
  onRoundTrip?: (rtt: Map<number, number>) => void;
  /** Frames made up for each sender, late or lost, with the levels (GRYT-2231). */
  onConcealed?: (frames: Map<number, number>) => void;
  /** The mix's left and right in dBFS, with the levels. Null once the call ends. */
  onOutput?: (db: [number, number] | null) => void;
}): Promise<AudioTransportSession> {
  const [pipe] = await Promise.all([dialPipe(o.offer, o.wsUrl), loadWorklets(o.context)]);

  const bitrate = clampBitrate(o.bitrate ?? TRANSPORT_BITRATE.max);
  const sendOptions: SendOptions = { wasm: o.wasm.slice(0), frame: FRAME, bitrate, stereoBitrate: stereoFor(bitrate), settings: o.effects };
  const send = new AudioWorkletNode(o.context, SEND_PROCESSOR, { processorOptions: sendOptions });
  // A node nothing pulls from never runs, so the send worklet ends in a silent gain.
  const sink = o.context.createGain();
  sink.gain.value = 0;
  send.connect(sink).connect(o.context.destination);
  const gain = o.context.createGain();
  gain.connect(o.output);

  let source = o.context.createMediaStreamSource(o.input);
  source.connect(send);

  // The worklets keep the probe clock between them (GRYT-1836): sent pings go to receive, heard pings back to send.
  send.port.onmessage = (e: MessageEvent<Uint8Array | { pingSent: number; at: number }>) => {
    if (e.data instanceof Uint8Array) pipe.send(e.data);
    else receive.port.postMessage(e.data);
  };
  let senderGains: [number, number][] = [];
  const onReport = (e: MessageEvent<ReceiveReport | { ping: number; at: number }>) => {
    if ("ping" in e.data) send.port.postMessage({ type: "pong", nonce: e.data.ping, at: e.data.at });
    else if ("speaking" in e.data) o.onSpeaking?.(e.data.speaking);
    else {
      o.onLevels?.(new Map(e.data.levels));
      o.onBuffered?.(new Map(e.data.buffered));
      o.onRoundTrip?.(new Map(e.data.rtt));
      o.onConcealed?.(new Map(e.data.concealed));
      o.onOutput?.(e.data.output);
    }
  };
  // A processor that throws stops for good (AudioWorklet spec), so a fresh one takes its place (GRYT-2429).
  const makeReceive = (): AudioWorkletNode => {
    const node = new AudioWorkletNode(o.context, RECEIVE_PROCESSOR, { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { wasm: o.wasm.slice(0), frame: FRAME } satisfies ReceiveOptions });
    node.connect(gain);
    node.port.onmessage = onReport;
    node.onprocessorerror = () => {
      node.port.onmessage = null;
      node.disconnect();
      if (receive !== node) return;
      receive = makeReceive();
      receive.port.postMessage({ gains: senderGains });
    };
    return node;
  };
  let receive = makeReceive();
  pipe.listen((d) => receive.port.postMessage(d, [d.buffer]));

  const closed = pipe.closed.finally(() => {
    send.port.onmessage = null;
    receive.port.onmessage = null;
    receive.onprocessorerror = null;
    o.onSpeaking?.([]);
    o.onLevels?.(new Map());
    o.onBuffered?.(new Map());
    o.onRoundTrip?.(new Map());
    o.onConcealed?.(new Map());
    o.onOutput?.(null);
    source.disconnect();
    send.disconnect();
    receive.disconnect();
    gain.disconnect();
    sink.disconnect();
  });

  return {
    url: pipe.url,
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
    setBitrate(bps) {
      const mono = clampBitrate(bps);
      send.port.postMessage({ type: "bitrate", bitrate: mono, stereoBitrate: stereoFor(mono) });
    },
    setOutputGain(g) {
      gain.gain.setValueAtTime(g, o.context.currentTime);
    },
    setSenderGains(gains) {
      senderGains = [...gains];
      receive.port.postMessage({ gains: senderGains });
    },
    close() {
      pipe.close();
    },
    closed,
  };
}
