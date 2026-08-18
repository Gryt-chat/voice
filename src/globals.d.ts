/**
 * Insertable Streams, which TypeScript's DOM lib still does not describe.
 *
 * The client declares these in vite-env.d.ts, a file that also carries Vite's
 * own ambient types and so cannot be copied wholesale. Only the parts the voice
 * code actually uses are reproduced here.
 *
 * Chromium-only and experimental. The native adapter will not have them, which
 * is the usual reason a capture path is web-specific.
 */
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: "video" | "audio" });
  readonly writable: WritableStream<VideoFrame>;
}
