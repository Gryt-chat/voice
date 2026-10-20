/** The own voice transport on the main thread (GRYT-1818): one WebTransport session to the SFU, the send
    worklet feeding it and the receive worklet playing what comes back. */

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
  /** Swap the microphone stream, after the pipeline is rebuilt. */
  setInput(stream: MediaStream): void;
  /** Gain for everything heard: 0 when deafened. */
  setOutputGain(gain: number): void;
  close(): void;
  /** Settles when the session ends, for whatever reason. */
  closed: Promise<void>;
}

// 2.5 ms CELT frames; the transport exists for the latency.
const FRAME = 120;
const BITRATE = 64_000;
// The microphone pipeline already applied the user's processing, so the worklet passes it through.
const PASS_THROUGH = {
  volume: 100, gateThreshold: 0, gateReleaseMs: 200, gateSmoothing: 0.8, autoGain: false,
  autoGainTargetDb: -20, compressor: false, compressorAmount: 50, limiter: false,
};

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
}): Promise<AudioTransportSession> {
  const value = Uint8Array.from(atob(o.offer.certHash), (c) => c.charCodeAt(0));
  const url = `${o.offer.urls[0]}?ticket=${encodeURIComponent(o.offer.ticket)}`;
  const wt = new WebTransport(url, { serverCertificateHashes: [{ algorithm: "sha-256", value }] });
  try {
    await Promise.all([wt.ready, loadWorklets(o.context)]);
  } catch (error) {
    wt.close();
    throw error;
  }

  const sendOptions: SendOptions = { wasm: o.wasm.slice(0), frame: FRAME, bitrate: BITRATE, settings: PASS_THROUGH };
  const receiveOptions: ReceiveOptions = { wasm: o.wasm.slice(0), frame: FRAME };
  const send = new AudioWorkletNode(o.context, SEND_PROCESSOR, { processorOptions: sendOptions });
  const receive = new AudioWorkletNode(o.context, RECEIVE_PROCESSOR, { numberOfInputs: 0, processorOptions: receiveOptions });
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
    source.disconnect();
    send.disconnect();
    receive.disconnect();
    gain.disconnect();
    sink.disconnect();
  });

  return {
    setInput(stream) {
      source.disconnect();
      source = o.context.createMediaStreamSource(stream);
      source.connect(send);
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
