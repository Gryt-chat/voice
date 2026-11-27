/* Insertable Streams: TypeScript's DOM lib still has no types for these. */
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: "video" | "audio" });
  readonly writable: WritableStream<VideoFrame>;
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
