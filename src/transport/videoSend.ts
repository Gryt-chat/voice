/** One outgoing video track on the video hub (GRYT-2261): WebCodecs H.264 with temporal layers, Annex B as
    client-rs sends it, cut into pieces. The bitrate follows rateControl's estimate of what the uplink takes. */

import { CODEC_H264, splitFrame } from "./videoWire";

export interface VideoSendOptions {
  maxBitrate: number;
  maxFramerate: number;
  /** Frames are scaled down to fit, never up. */
  maxHeight?: number;
}

export interface VideoSendStats {
  /** Frames the source gave, before the frame-rate cap. */
  framesIn: number;
  frames: number;
  keyframes: number;
  bytes: number;
  skipped: number;
  bitrate: number;
  layers: number;
  encodeMs: number;
  hardware: boolean;
}

export interface VideoSender {
  keyframe(): void;
  setBitrate(bps: number): void;
  setOptions(o: VideoSendOptions): void;
  /** Nobody watches: frames are dropped before the encoder, and the first after is a keyframe. */
  pause(on: boolean): void;
  stats(): VideoSendStats;
  stop(): void;
}

// Constrained baseline, level 5.1: what client-rs's VideoToolbox and Media Foundation decoders take, up to 4K.
const H264 = "avc1.42E033";
/** Frames still waiting in the encoder when the next comes; past this it's skipped rather than queued. */
const MAX_QUEUE = 2;
export const MIN_BITRATE = 300_000;

/** The first config the browser takes: hardware before software, three temporal layers before fewer. */
async function pickConfig(width: number, height: number, bitrate: number, framerate: number): Promise<VideoEncoderConfig | null> {
  for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
    for (const scalabilityMode of ["L1T3", "L1T2", undefined]) {
      const config: VideoEncoderConfig = {
        codec: H264, width, height, bitrate, framerate, hardwareAcceleration, latencyMode: "realtime",
        avc: { format: "annexb" }, ...(scalabilityMode ? { scalabilityMode } : {}),
      };
      const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (supported) return config;
    }
  }
  return null;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function startVideoSend(o: {
  track: number;
  source: MediaStreamTrack;
  options: VideoSendOptions;
  /** One frame's pieces, in order. */
  send: (pieces: Uint8Array[]) => void;
  /** Capture time in µs, low 32 bits, as client-rs stamps it. */
  clock?: () => number;
}): VideoSender {
  let options = o.options;
  let bitrate = options.maxBitrate;
  let config: VideoEncoderConfig | null = null;
  let encoder: VideoEncoder | null = null;
  let wantKey = true;
  let frameNo = 0;
  let credit = 1;
  let creditAt = performance.now();
  let stopped = false;
  let paused = false;
  // By the frame's own timestamp: the capture stamp and when it went into the encoder.
  const started = new Map<number, { at: number; stamp: number }>();
  const s: VideoSendStats = { framesIn: 0, frames: 0, keyframes: 0, bytes: 0, skipped: 0, bitrate, layers: 1, encodeMs: 0, hardware: false };
  const clock = o.clock ?? (() => Math.round((performance.timeOrigin + performance.now()) * 1000) >>> 0);

  const output = (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata & { svc?: { temporalLayerId: number } }) => {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const keyframe = chunk.type === "key";
    const t0 = started.get(chunk.timestamp);
    started.delete(chunk.timestamp);
    const layer = keyframe ? 0 : meta?.svc?.temporalLayerId ?? 0;
    const pieces = splitFrame({ keyframe, track: o.track, codec: CODEC_H264, frame: frameNo, layer, timestamp: t0?.stamp ?? clock() }, data);
    if (!pieces) return;
    frameNo = (frameNo + 1) & 0xffff;
    o.send(pieces);
    s.frames++;
    s.bytes += data.length;
    if (keyframe) s.keyframes++;
    if (t0) s.encodeMs += (performance.now() - t0.at - s.encodeMs) / 16;
  };

  const configure = async (width: number, height: number) => {
    const scale = options.maxHeight && height > options.maxHeight ? options.maxHeight / height : 1;
    const picked = await pickConfig(even(width * scale), even(height * scale), bitrate, options.maxFramerate);
    if (!picked || stopped) throw new Error("no H.264 encoder");
    encoder?.close();
    encoder = new VideoEncoder({ output, error: (e) => console.warn("[video] encoder", e) });
    encoder.configure(picked);
    config = picked;
    s.layers = Number(picked.scalabilityMode?.slice(3) ?? 1);
    s.hardware = picked.hardwareAcceleration === "prefer-hardware";
    wantKey = true;
  };

  const reader = new MediaStreamTrackProcessor({ track: o.source }).readable.getReader();
  void (async () => {
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done || stopped) {
          frame?.close();
          return;
        }
        if (paused) {
          frame.close();
          continue;
        }
        const now = performance.now();
        s.framesIn++;
        // A frame's worth of credit per 1/maxFramerate, two at most, so a jittery source at the rate loses nothing.
        credit = Math.min(2, credit + ((now - creditAt) * options.maxFramerate) / 1000);
        creditAt = now;
        if (credit < 1) {
          frame.close();
          continue;
        }
        credit--;
        const scale = options.maxHeight && frame.displayHeight > options.maxHeight ? options.maxHeight / frame.displayHeight : 1;
        const width = even(frame.displayWidth * scale), height = even(frame.displayHeight * scale);
        const current = config as VideoEncoderConfig | null;
        if (!current || current.width !== width || current.height !== height) await configure(frame.displayWidth, frame.displayHeight);
        const enc = encoder as VideoEncoder | null;
        if (!enc) throw new Error("no H.264 encoder");
        if (enc.encodeQueueSize > MAX_QUEUE) {
          s.skipped++;
          frame.close();
          continue;
        }
        if (started.size > 64) started.clear();
        started.set(frame.timestamp, { at: now, stamp: clock() });
        enc.encode(frame, { keyFrame: wantKey });
        wantKey = false;
        frame.close();
      }
    } catch (e) {
      console.warn("[video] send stopped", e);
    }
  })();

  return {
    keyframe: () => (wantKey = true),
    setBitrate(bps) {
      bitrate = Math.round(Math.min(options.maxBitrate, Math.max(MIN_BITRATE, bps)));
      s.bitrate = bitrate;
      const was = config?.bitrate ?? 0;
      if (encoder && config && Math.abs(was - bitrate) > was * 0.05) {
        config = { ...config, bitrate };
        encoder.configure(config);
      }
    },
    setOptions(next) {
      // A new size reconfigures on the next frame; the same size keeps the encoder and its stream.
      options = next;
      this.setBitrate(Math.min(bitrate, next.maxBitrate));
    },
    pause(on) {
      if (paused && !on) wantKey = true;
      paused = on;
    },
    stats: () => ({ ...s }),
    stop() {
      stopped = true;
      void reader.cancel().catch(() => undefined);
      if (encoder?.state !== "closed") encoder?.close();
    },
  };
}
