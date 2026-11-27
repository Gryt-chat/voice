/** The video hub's datagrams (sfu internal/audiotransport, limits.go and video.go): a 16-byte clear header on
    each piece of an encoded frame, and a viewer's requests back to the SFU. Byte for byte client-rs video_wire.rs. */

export const VIDEO_VERSION = 2;
export const VIDEO_HEADER = 16;
export const MAX_PIECE = 1100;
export const MAX_PIECES = 4096;
/** What the SFU puts in front of everything it forwards. Zero means the SFU itself asked. */
export const SENDER_BYTES = 4;

export const CONTROL_VERSION = 3;
export const CONTROL_KEYFRAME = 1;
export const CONTROL_RESEND = 2;
export const CONTROL_LAYERS = 3;
/** Proposed for the Rust SFU (GRYT-2261): what a viewer draws, and the SFU's max over viewers back to the sender. */
export const CONTROL_DEMAND = 4;
export const MAX_RESEND = 32;
export const LAYERS_ALL = 0xff;
export const LAYERS_NONE = 0xfe;

export const FLAG_KEYFRAME = 1;
export const CODEC_H264 = 1;
export const CODEC_AV1 = 2;
/** A share's sound rides its screen track with this bit set. */
export const AUDIO_TRACK = 0x80;

export interface PieceHeader {
  keyframe: boolean;
  track: number;
  codec: number;
  frame: number;
  piece: number;
  pieces: number;
  /** Temporal layer, 0 the base. */
  layer: number;
  /** Capture time in microseconds, low 32 bits, as client-rs stamps it. */
  timestamp: number;
}

/** The SFU's own checks, so a piece it would drop is dropped here too. */
export function readPiece(b: Uint8Array): PieceHeader | null {
  if (b.length <= VIDEO_HEADER || b.length > VIDEO_HEADER + MAX_PIECE || b[0] !== VIDEO_VERSION) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const h: PieceHeader = {
    keyframe: (b[1] & FLAG_KEYFRAME) !== 0,
    track: b[2],
    codec: b[3],
    frame: v.getUint16(4),
    piece: v.getUint16(6),
    pieces: v.getUint16(8),
    layer: b[10],
    timestamp: v.getUint32(12),
  };
  return h.pieces > 0 && h.pieces <= MAX_PIECES && h.piece < h.pieces ? h : null;
}

function writeHeader(h: PieceHeader, out: Uint8Array): void {
  const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = VIDEO_VERSION;
  out[1] = h.keyframe ? FLAG_KEYFRAME : 0;
  out[2] = h.track;
  out[3] = h.codec;
  v.setUint16(4, h.frame & 0xffff);
  v.setUint16(6, h.piece);
  v.setUint16(8, h.pieces);
  out[10] = h.layer;
  out[11] = 0;
  v.setUint32(12, h.timestamp >>> 0);
}

/** One encoded frame cut into pieces, each with its header. Null for an empty frame or one past MAX_PIECES. */
export function splitFrame(head: Omit<PieceHeader, "piece" | "pieces">, data: Uint8Array): Uint8Array[] | null {
  const count = Math.ceil(data.length / MAX_PIECE);
  if (count === 0 || count > MAX_PIECES) return null;
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = data.subarray(i * MAX_PIECE, (i + 1) * MAX_PIECE);
    const b = new Uint8Array(VIDEO_HEADER + chunk.length);
    writeHeader({ ...head, piece: i, pieces: count }, b);
    b.set(chunk, VIDEO_HEADER);
    out.push(b);
  }
  return out;
}

function control(kind: number, sender: number, track: number, count: number, extra = 0): Uint8Array {
  const b = new Uint8Array(VIDEO_HEADER + extra);
  b.set([CONTROL_VERSION, kind, track, count]);
  new DataView(b.buffer).setUint32(4, sender >>> 0);
  return b;
}

export const keyframeRequest = (sender: number, track: number): Uint8Array => control(CONTROL_KEYFRAME, sender, track, 0);

/** Up to 32 (frame, piece) pairs; the rest are left off. */
export function resendRequest(sender: number, track: number, pieces: [number, number][]): Uint8Array {
  const some = pieces.slice(0, MAX_RESEND);
  const b = control(CONTROL_RESEND, sender, track, some.length, 4 * some.length);
  const v = new DataView(b.buffer);
  some.forEach(([frame, piece], i) => {
    v.setUint16(VIDEO_HEADER + 4 * i, frame);
    v.setUint16(VIDEO_HEADER + 4 * i + 2, piece);
  });
  return b;
}

export function layersRequest(sender: number, track: number, top: number): Uint8Array {
  const b = control(CONTROL_LAYERS, sender, track, 0);
  b[8] = top;
  return b;
}

export interface Demand {
  width: number;
  height: number;
  fps: number;
  /** Share of pieces asked for again, 0 to 1: the viewer's, or the worst of them coming back. */
  loss?: number;
  /** Queueing delay in ms, sent in 4 ms steps: how far frames arrive behind the quickest one lately. */
  delay?: number;
}

export function demandRequest(sender: number, track: number, d: Demand): Uint8Array {
  const b = control(CONTROL_DEMAND, sender, track, 0);
  const v = new DataView(b.buffer);
  v.setUint16(8, Math.min(0xffff, d.width));
  v.setUint16(10, Math.min(0xffff, d.height));
  v.setUint16(12, Math.min(0xffff, d.fps));
  b[14] = Math.round(Math.min(1, Math.max(0, d.loss ?? 0)) * 255);
  b[15] = Math.round(Math.min(255, Math.max(0, (d.delay ?? 0) / 4)));
  return b;
}

export type Forwarded =
  | { kind: "piece"; sender: number; piece: Uint8Array; head: PieceHeader }
  | { kind: "keyframe"; track: number }
  | { kind: "demand"; track: number; watchers: number; demand: Demand };

/** What the SFU forwarded: another member's piece, or a viewer's keyframe request for one of our tracks. */
export function readForwardedVideo(b: Uint8Array): Forwarded | null {
  if (b.length <= SENDER_BYTES) return null;
  const sender = new DataView(b.buffer, b.byteOffset, SENDER_BYTES).getUint32(0);
  const rest = b.subarray(SENDER_BYTES);
  if (sender === 0) {
    if (rest.length !== VIDEO_HEADER || rest[0] !== CONTROL_VERSION) return null;
    if (rest[1] === CONTROL_KEYFRAME) return { kind: "keyframe", track: rest[2] };
    if (rest[1] !== CONTROL_DEMAND) return null;
    const v = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
    return { kind: "demand", track: rest[2], watchers: rest[3], demand: { width: v.getUint16(8), height: v.getUint16(10), fps: v.getUint16(12), loss: rest[14] / 255, delay: rest[15] * 4 } };
  }
  const head = readPiece(rest);
  return head ? { kind: "piece", sender, piece: rest, head } : null;
}

/** Whether frame a comes after b, across the u16 wrap. */
export const frameAfter = (a: number, b: number): boolean => ((a - b) & 0xffff) !== 0 && ((a - b) & 0xffff) < 0x8000;
