/** The own transport's datagram (GRYT-1818): version u8, flags u8, seq u16, timestamp u32 (48 kHz
    samples), then one Opus packet. The SFU prefixes the sender id from the session, never the packet. */

export const PACKET_VERSION = 1;
export const HEADER_BYTES = 8;
/** Opus's own maximum; anything longer is dropped unread. */
export const MAX_OPUS_BYTES = 1275;
/** The SFU's prefix on a forwarded packet: the sender's u32 id. */
export const SENDER_BYTES = 4;

export const FLAG_SPEAKING = 1;

export interface AudioPacket {
  flags: number;
  seq: number;
  timestamp: number;
  opus: Uint8Array;
}

export function writePacket(p: AudioPacket): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + p.opus.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, PACKET_VERSION);
  view.setUint8(1, p.flags & 0xff);
  view.setUint16(2, p.seq & 0xffff);
  view.setUint32(4, p.timestamp >>> 0);
  out.set(p.opus, HEADER_BYTES);
  return out;
}

/** Null for anything that isn't a packet this version wrote: wrong version, too short, too long. */
export function readPacket(bytes: Uint8Array): AudioPacket | null {
  if (bytes.length <= HEADER_BYTES || bytes.length > HEADER_BYTES + MAX_OPUS_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PACKET_VERSION) return null;
  return {
    flags: view.getUint8(1),
    seq: view.getUint16(2),
    timestamp: view.getUint32(4),
    opus: bytes.subarray(HEADER_BYTES),
  };
}

/** A forwarded packet: the SFU's sender id, then the packet as the sender wrote it. */
export function readForwarded(bytes: Uint8Array): { sender: number; packet: AudioPacket } | null {
  if (bytes.length <= SENDER_BYTES) return null;
  const packet = readPacket(bytes.subarray(SENDER_BYTES));
  if (!packet) return null;
  return { sender: new DataView(bytes.buffer, bytes.byteOffset, SENDER_BYTES).getUint32(0), packet };
}

/** How far `b` is past `a` in a wrapping u16 sequence, -32768..32767. */
export function seqDelta(a: number, b: number): number {
  return ((b - a + 0x8000) & 0xffff) - 0x8000;
}
