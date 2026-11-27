/* Insertable Streams: TypeScript's DOM lib still has no types for these. */
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: "video" | "audio" });
  readonly writable: WritableStream<VideoFrame>;
}

/* Tracks are transferable to and from a dedicated worker; the DOM lib doesn't list them. */
interface Worker {
  postMessage(message: MediaStreamTrack, transfer: MediaStreamTrack[]): void;
}
interface Window {
  postMessage(message: MediaStreamTrack | VideoFrame | null, options?: { transfer: (MediaStreamTrack | VideoFrame)[] }): void;
}

/* The spec's worker-only generator, which is what Safari has. */
declare class VideoTrackGenerator {
  readonly writable: WritableStream<VideoFrame>;
  readonly track: MediaStreamTrack;
}

declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<VideoFrame>;
}

/* WebTransport.getStats() as Chromium has it; times in ms. */
interface WebTransportConnectionStats {
  bytesSent?: number;
  packetsSent?: number;
  packetsLost?: number;
  smoothedRtt?: number;
  minRtt?: number;
  datagrams?: { expiredOutgoing?: number; lostOutgoing?: number };
}
