/** Frames out of a MediaStreamTrack and into a new one. Chromium does both on the main thread. Safari only has
    MediaStreamTrackProcessor and VideoTrackGenerator in a dedicated worker, so there the frames go through one (GRYT-2431). */

const onMainThread = () => typeof MediaStreamTrackProcessor === "function" && typeof MediaStreamTrackGenerator === "function";

export const frameTracksSupported = (): boolean => onMainThread() || typeof Worker === "function";

// Runs in the worker, from its source text, so it may use nothing from this module.
function workerMain() {
  self.onmessage = ({ data }) => {
    if (data === "generate") {
      const generator = new VideoTrackGenerator();
      const writer = generator.writable.getWriter();
      self.postMessage(generator.track, { transfer: [generator.track] });
      self.onmessage = ({ data: frame }: MessageEvent<VideoFrame | null>) => {
        if (!frame) return (generator.track.stop(), self.close());
        // A track nobody reads backs up; the newest picture matters, not the queue.
        if ((writer.desiredSize ?? 1) <= 0) return frame.close();
        void writer.write(frame).catch(() => frame.close());
      };
      return;
    }
    const track = data as MediaStreamTrack;
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    self.onmessage = () => (void reader.cancel().catch(() => undefined), track.stop(), self.close());
    let last = -1;
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return self.postMessage(null);
        // WebKit stamps a canvas capture's frames all 0, and the encoder and our stats key on the timestamp.
        const frame = value.timestamp > last ? value : new VideoFrame(value, { timestamp: Math.max(last + 1, Math.round(performance.now() * 1000)) });
        if (frame !== value) value.close();
        last = frame.timestamp;
        self.postMessage(frame, { transfer: [frame] });
      }
    })().catch(() => self.postMessage(null));
  };
}

const startWorker = () =>
  new Worker(URL.createObjectURL(new Blob([`(${String(workerMain)})()`], { type: "text/javascript" })));

/** The track's frames. A clone goes to the worker, so `track` itself keeps playing where it's shown. */
export function readFrames(track: MediaStreamTrack): ReadableStream<VideoFrame> {
  if (onMainThread()) return new MediaStreamTrackProcessor({ track }).readable;
  const worker = startWorker();
  let cancelled = false;
  return new ReadableStream<VideoFrame>({
    start(c) {
      worker.onmessage = ({ data }: MessageEvent<VideoFrame | null>) => {
        if (cancelled) return data?.close();
        if (!data) return (c.close(), worker.terminate());
        // Two waiting is enough; past that the reader is behind and older frames go.
        if ((c.desiredSize ?? 1) <= 0) return data.close();
        c.enqueue(data);
      };
      worker.onerror = () => c.error(new Error("this browser can't read frames from a track"));
      const clone = track.clone();
      worker.postMessage(clone, [clone]);
    },
    cancel() {
      cancelled = true;
      worker.postMessage("stop");
    },
  }, { highWaterMark: 2 });
}

/** A video track drawing what's written to `writable`. On Safari the track arrives from the worker, hence the promise. */
export function writeFrames(): { track: Promise<MediaStreamTrack>; writable: WritableStream<VideoFrame> } {
  if (onMainThread()) {
    const generator = new MediaStreamTrackGenerator({ kind: "video" });
    return { track: Promise.resolve(generator), writable: generator.writable };
  }
  const worker = startWorker();
  const track = new Promise<MediaStreamTrack>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<MediaStreamTrack>) => resolve(data);
    worker.onerror = () => reject(new Error("this browser can't make a track from frames"));
  });
  worker.postMessage("generate");
  return {
    track,
    writable: new WritableStream<VideoFrame>({
      write: (frame) => worker.postMessage(frame, [frame]),
      close: () => worker.postMessage(null),
    }),
  };
}
