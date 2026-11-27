/** One incoming video stream from the video hub (GRYT-2261): whole frames into WebCodecs, pictures out as a
    MediaStreamTrack, so a tile draws it like any WebRTC track. */

import type { AssembledFrame } from "./videoAssembly";
import { CODEC_AV1, CODEC_H264 } from "./videoWire";

export interface VideoReceiveStats {
  width: number;
  height: number;
  frames: number;
  bytes: number;
  /** Frames decoded but not drawn, because the track was still busy with the one before. */
  dropped: number;
  /** Capture on the sender to decoded here, by the two machines' clocks, smoothed. Null before the first frame. */
  latencyMs: number | null;
  decodeMs: number;
}

export interface VideoReceiver {
  stream: MediaStream;
  push(frame: AssembledFrame): void;
  stats(): VideoReceiveStats;
  close(): void;
}

const CODECS: Record<number, string> = { [CODEC_H264]: "avc1.42E033", [CODEC_AV1]: "av01.0.08M.08" };

/** `now` and the frame's stamp in µs, low 32 bits. `onBroken` asks for a keyframe after a decoder error. */
export function startVideoReceive(o: { onBroken: () => void; clock?: () => number }): VideoReceiver {
  const generator = new MediaStreamTrackGenerator({ kind: "video" });
  const writer = generator.writable.getWriter();
  const clock = o.clock ?? (() => Math.round((performance.timeOrigin + performance.now()) * 1000) >>> 0);
  const s: VideoReceiveStats = { width: 0, height: 0, frames: 0, bytes: 0, dropped: 0, latencyMs: null, decodeMs: 0 };
  let decoder: VideoDecoder | null = null;
  let codec = 0;
  let needKey = true;
  const sentAt = new Map<number, { at: number; stamp: number }>();

  const output = (picture: VideoFrame) => {
    const t = sentAt.get(picture.timestamp);
    sentAt.delete(picture.timestamp);
    if (t) {
      s.decodeMs += (performance.now() - t.at - s.decodeMs) / 16;
      const age = ((clock() - t.stamp) | 0) / 1000;
      if (age >= 0 && age < 5000) s.latencyMs = s.latencyMs === null ? age : s.latencyMs + (age - s.latencyMs) / 16;
    }
    s.width = picture.displayWidth;
    s.height = picture.displayHeight;
    // A track nobody reads backs up; the newest picture matters, not the queue.
    if ((writer.desiredSize ?? 1) <= 0) {
      s.dropped++;
      picture.close();
      return;
    }
    void writer.write(picture).catch(() => picture.close());
  };

  const reset = () => {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
    needKey = true;
  };

  return {
    stream: new MediaStream([generator]),
    push(f) {
      if (f.codec !== codec) {
        reset();
        codec = f.codec;
      }
      if (needKey && !f.keyframe) return;
      if (!decoder) {
        const name = CODECS[f.codec];
        if (!name) return;
        decoder = new VideoDecoder({
          output,
          error: (e) => {
            console.warn("[video] decoder", e);
            reset();
            o.onBroken();
          },
        });
        decoder.configure({ codec: name, optimizeForLatency: true });
      }
      needKey = false;
      s.frames++;
      s.bytes += f.data.length;
      // The frame number, unwrapped enough to be unique among the few in the decoder at once.
      const ts = s.frames;
      if (sentAt.size > 64) sentAt.clear();
      sentAt.set(ts, { at: performance.now(), stamp: f.timestamp });
      try {
        decoder.decode(new EncodedVideoChunk({ type: f.keyframe ? "key" : "delta", timestamp: ts, data: f.data }));
      } catch (e) {
        console.warn("[video] decode", e);
        reset();
        o.onBroken();
      }
    },
    stats: () => ({ ...s }),
    close() {
      reset();
      void writer.close().catch(() => undefined);
      generator.stop();
    },
  };
}
