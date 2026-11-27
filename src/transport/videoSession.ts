/** The browser's end of the SFU's video hub (GRYT-2261): one WebTransport session at /video carrying our tracks
    out and everyone else's in, with the requests that keep them whole. client-rs video_receive.rs is the twin. */

import { dialPipe, type Pipe } from "./session";
import { LayerControl, QueueDelay, RateControl } from "./rateControl";
import { VideoAssembler } from "./videoAssembly";
import { startVideoReceive, type VideoReceiver, type VideoReceiveStats } from "./videoReceive";
import { MIN_BITRATE, startVideoSend, type VideoSender, type VideoSendOptions, type VideoSendStats } from "./videoSend";
import { CONTROL_RESEND, type Demand, demandRequest, keyframeRequest, LAYERS_ALL, LAYERS_NONE, layersRequest, readForwardedVideo } from "./videoWire";

/** room_joined's audio_transport.video, with the audio offer's cert hash. */
export interface VideoTransportOffer {
  urls: string[];
  ticket: string;
  certHash: string;
}

export interface VideoTransportStats {
  url: string;
  targetBitrate: number;
  sending: Record<number, VideoSendStats>;
  /** By `sender/track`. `top` is the highest temporal layer asked for, 255 for all. */
  receiving: Record<string, VideoReceiveStats & { top: number; watched: boolean }>;
}

export interface VideoTransportSession {
  url: string;
  /** Starts or replaces what goes out on `track` (1 and up for shared windows, 0 for a camera). */
  send(track: number, source: MediaStreamTrack, options: VideoSendOptions): void;
  /** New ceilings for what goes out on `track`. */
  configure(track: number, options: VideoSendOptions): void;
  stopSending(track: number): void;
  /** How big this viewer draws a member's track, or null when it doesn't: the SFU forwards nothing of that. */
  watch(sender: number, track: number, drawn: Demand | null): void;
  /** A member that left the hub. */
  forget(sender: number): void;
  stats(): VideoTransportStats;
  close(): void;
  closed: Promise<void>;
}

/** Drawn heights round up to one of these, so resizing a tile doesn't reconfigure the encoder at every step. */
const HEIGHTS = [360, 540, 720, 1080, 1440, 2160];
const POLL_MS = 5;
const STATS_MS = 500;
/** A request for nobody, as client-rs sends: keeps an idle session from timing out. */
const HELLO_MS = 5000;

/** A keyframe's pieces fit under this; past it pieces drop and viewers ask for a resend. */
const WS_MAX_BUFFERED = 1024 * 1024;

/** WebTransport is optional: without it, or with UDP blocked, the session goes over `wsUrl`. */
export const videoTransportSupported = (): boolean =>
  typeof VideoEncoder === "function" && typeof MediaStreamTrackProcessor === "function" && typeof MediaStreamTrackGenerator === "function";

export async function startVideoTransport(o: {
  offer: VideoTransportOffer;
  /** The SFU's /video-ws, for when WebTransport is missing or blocked. */
  wsUrl?: string;
  /** A stream from a member's track appeared, or went (null). */
  onStream: (sender: number, track: number, stream: MediaStream | null) => void;
}): Promise<VideoTransportSession> {
  const pipe: Pipe = await dialPipe(o.offer, o.wsUrl, WS_MAX_BUFFERED);
  const senders = new Map<number, { sender: VideoSender; options: VideoSendOptions; wanted: Demand | null }>();
  // The user's ceiling, lowered to what viewers draw once the SFU says.
  const applied = (s: { options: VideoSendOptions; wanted: Demand | null }): VideoSendOptions => (!s.wanted ? s.options : {
    ...s.options,
    maxHeight: Math.min(s.options.maxHeight ?? Infinity, HEIGHTS.find((h) => h >= (s.wanted?.height ?? 0)) ?? Infinity) || s.options.maxHeight,
    maxFramerate: Math.min(s.options.maxFramerate, s.wanted.fps || Infinity),
  });
  const receivers = new Map<string, { sender: number; track: number; r: VideoReceiver; layers: LayerControl; delay: QueueDelay; watched: boolean; drawn: Demand | null }>();
  const assembler = new VideoAssembler();
  const rate = new RateControl(0, MIN_BITRATE, 0);
  const key = (sender: number, track: number) => `${sender}/${track}`;

  const request = (b: Uint8Array) => {
    if (b[1] === CONTROL_RESEND) receivers.get(key(new DataView(b.buffer).getUint32(4), b[2]))?.layers.resent(b[3]);
    pipe.send(b);
  };
  const setTop = (sender: number, track: number, top: number) => {
    assembler.setLayers(sender, track, top);
    pipe.send(layersRequest(sender, track, top));
  };

  pipe.listen((d) => {
    const got = readForwardedVideo(d);
    if (!got) return;
    if (got.kind === "keyframe") {
      senders.get(got.track)?.sender.keyframe();
      return;
    }
    if (got.kind === "demand") {
      const s = senders.get(got.track);
      if (!s) return;
      viewerLoss = Math.max(viewerLoss, got.demand.loss ?? 0);
      viewerDelay = Math.max(viewerDelay, got.demand.delay ?? 0);
      s.sender.pause(got.watchers === 0);
      s.wanted = got.watchers > 0 ? got.demand : null;
      s.sender.setOptions(applied(s));
      return;
    }
    const { sender, head } = got;
    // A share's sound has no player here yet; its WebRTC copy still plays.
    if (head.track & 0x80) return;
    const k = key(sender, head.track);
    let rx = receivers.get(k);
    if (!rx) {
      const r = startVideoReceive({ onBroken: () => pipe.send(keyframeRequest(sender, head.track)) });
      rx = { sender, track: head.track, r, layers: new LayerControl(3, performance.now()), delay: new QueueDelay(), watched: true, drawn: null };
      receivers.set(k, rx);
      o.onStream(sender, head.track, r.stream);
    }
    rx.layers.received();
    const now = performance.now();
    for (const f of assembler.push(sender, got.piece, now)) {
      rx.delay.arrived(f.timestamp, now);
      rx.r.push(f);
    }
  });

  const poll = setInterval(() => {
    const now = performance.now();
    for (const req of assembler.poll(now)) request(req);
    for (const rx of receivers.values()) {
      if (!rx.watched) continue;
      const ticked = rx.layers.ticks;
      const top = rx.layers.tick(now);
      if (top !== null) setTop(rx.sender, rx.track, top >= 2 ? LAYERS_ALL : top);
      // Once a second, with what this viewer draws, so the sender hears about loss and queueing.
      if (rx.layers.ticks !== ticked && rx.drawn) pipe.send(demandRequest(rx.sender, rx.track, { ...rx.drawn, loss: rx.layers.loss, delay: rx.delay.take() }));
    }
  }, POLL_MS);

  const hello = setInterval(() => pipe.send(keyframeRequest(0, 0)), HELLO_MS);
  // Chromium 144 has no WebTransport.getStats(); then only our own byte count and what viewers report are known.
  let sentBytes = 0;
  let viewerLoss = 0;
  let viewerDelay = 0;
  const sendPiece = (piece: Uint8Array) => {
    sentBytes += piece.length;
    pipe.send(piece);
  };
  const readStats = setInterval(() => {
    if (!senders.size) return;
    const stats = pipe.stats ? pipe.stats().catch(() => ({})) : Promise.resolve({});
    void stats.then((st: WebTransportConnectionStats) => {
      const max = [...senders.values()].reduce((n, s) => n + s.options.maxBitrate, 0);
      rate.setMax(max);
      if (rate.target === 0) rate.target = max;
      const target = rate.update({
        at: performance.now(),
        bytesSent: st.bytesSent ?? sentBytes,
        packetsSent: st.packetsSent ?? 0,
        packetsLost: st.packetsLost ?? 0,
        smoothedRtt: st.smoothedRtt ?? 0,
        minRtt: st.minRtt ?? st.smoothedRtt ?? 0,
        dropped: (st.datagrams?.expiredOutgoing ?? 0) + (st.datagrams?.lostOutgoing ?? 0),
        viewerLoss,
        viewerDelay,
      });
      viewerLoss = viewerDelay = 0;
      for (const s of senders.values()) s.sender.setBitrate((target * s.options.maxBitrate) / max);
    }, () => undefined);
  }, STATS_MS);

  const closed = pipe.closed.finally(() => {
    clearInterval(poll);
    clearInterval(readStats);
    clearInterval(hello);
    for (const s of senders.values()) s.sender.stop();
    for (const rx of receivers.values()) {
      rx.r.close();
      o.onStream(rx.sender, rx.track, null);
    }
    senders.clear();
    receivers.clear();
  });

  return {
    url: pipe.url,
    send(track, source, options) {
      senders.get(track)?.sender.stop();
      senders.set(track, { options, wanted: null, sender: startVideoSend({ track, source, options, send: sendPiece }) });
    },
    configure(track, options) {
      const s = senders.get(track);
      if (!s) return;
      s.options = options;
      s.sender.setOptions(applied(s));
    },
    stopSending(track) {
      senders.get(track)?.sender.stop();
      senders.delete(track);
    },
    watch(sender, track, drawn) {
      const on = !!drawn && drawn.width > 0 && drawn.height > 0;
      const rx = receivers.get(key(sender, track));
      const was = rx?.watched ?? false;
      if (rx) {
        rx.watched = on;
        rx.drawn = on ? drawn : null;
      }
      pipe.send(demandRequest(sender, track, on && drawn ? drawn : { width: 0, height: 0, fps: 0 }));
      if (on === was && rx) return;
      setTop(sender, track, on ? LAYERS_ALL : LAYERS_NONE);
      if (on) pipe.send(keyframeRequest(sender, track));
    },
    forget(sender) {
      assembler.forget(sender);
      for (const [k, rx] of receivers) {
        if (rx.sender !== sender) continue;
        rx.r.close();
        receivers.delete(k);
        o.onStream(sender, rx.track, null);
      }
    },
    stats: () => ({
      url: pipe.url,
      targetBitrate: rate.target,
      sending: Object.fromEntries([...senders].map(([t, s]) => [t, s.sender.stats()])),
      receiving: Object.fromEntries([...receivers].map(([k, rx]) => [k, { ...rx.r.stats(), top: rx.layers.top >= 2 ? LAYERS_ALL : rx.layers.top, watched: rx.watched }])),
    }),
    close: () => pipe.close(),
    closed,
  };
}
