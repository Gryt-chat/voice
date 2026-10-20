/**
 * libopus, built by codec/opus/build.sh, without Emscripten's JS: one import, a few exports.
 * Takes the module's bytes, so a worklet, a page and Node all load it the same way (GRYT-1818).
 */

interface OpusExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  free(ptr: number): void;
  gryt_encoder_create(rate: number, channels: number, application: number, bitrate: number, complexity: number): number;
  gryt_encode(enc: number, pcm: number, frame: number, out: number, max: number): number;
  gryt_encoder_destroy(enc: number): void;
  gryt_decoder_create(rate: number, channels: number): number;
  gryt_decode(dec: number, data: number, len: number, pcm: number, frame: number): number;
  gryt_decoder_destroy(dec: number): void;
}

/** CELT only: the lowest delay Opus has, and the only mode that takes 2.5 ms frames. */
export const OPUS_RESTRICTED_LOWDELAY = 2051;
const SAMPLE_RATE = 48000;
const MAX_FRAME = 960;
const MAX_PACKET = 1275;

export interface OpusCodec {
  encoder(options: { frame: number; bitrate: number; complexity?: number; channels?: 1 | 2 }): OpusEncoder;
  /** Decodes mono and stereo packets alike; a stereo decoder gives a mono packet on both sides. */
  decoder(frame: number, channels?: 1 | 2): OpusDecoder;
}

export interface OpusEncoder {
  /** One frame of float PCM in, interleaved when stereo, one packet out. */
  encode(pcm: Float32Array): Uint8Array;
  destroy(): void;
}

export interface OpusDecoder {
  /** A packet in, one frame out, interleaved when stereo. Null for a packet that never came: Opus fills the gap. */
  decode(packet: Uint8Array | null): Float32Array;
  destroy(): void;
}

export async function loadOpus(bytes: BufferSource): Promise<OpusCodec> {
  const { instance } = await WebAssembly.instantiate(bytes, { env: { emscripten_notify_memory_growth: () => {} } });
  // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-restricted-types -- WebAssembly exports are untyped; the shim in codec/opus defines these
  const wasm = instance.exports as unknown as OpusExports;
  wasm._initialize();
  // Re-read on every call: a grown memory detaches the old buffer.
  const heap = () => wasm.memory.buffer;

  return {
    encoder({ frame, bitrate, complexity = 5, channels = 1 }) {
      if (frame > MAX_FRAME) throw new Error(`opus frame ${frame} is over ${MAX_FRAME}`);
      const enc = wasm.gryt_encoder_create(SAMPLE_RATE, channels, OPUS_RESTRICTED_LOWDELAY, bitrate, complexity);
      if (!enc) throw new Error("opus encoder could not be created");
      const pcm = wasm.malloc(frame * channels * 4);
      const out = wasm.malloc(MAX_PACKET);
      return {
        encode(input) {
          new Float32Array(heap(), pcm, frame * channels).set(input.subarray(0, frame * channels));
          const n = wasm.gryt_encode(enc, pcm, frame, out, MAX_PACKET);
          if (n < 0) throw new Error(`opus encode failed (${n})`);
          return new Uint8Array(heap(), out, n).slice();
        },
        destroy() {
          wasm.free(pcm);
          wasm.free(out);
          wasm.gryt_encoder_destroy(enc);
        },
      };
    },
    decoder(frame, channels = 1) {
      const dec = wasm.gryt_decoder_create(SAMPLE_RATE, channels);
      if (!dec) throw new Error("opus decoder could not be created");
      const data = wasm.malloc(MAX_PACKET);
      const pcm = wasm.malloc(MAX_FRAME * channels * 4);
      return {
        decode(packet) {
          const len = packet ? Math.min(packet.length, MAX_PACKET) : 0;
          if (packet) new Uint8Array(heap(), data, len).set(packet.subarray(0, len));
          const n = wasm.gryt_decode(dec, data, len, pcm, frame);
          if (n < 0) throw new Error(`opus decode failed (${n})`);
          return new Float32Array(heap(), pcm, n * channels).slice();
        },
        destroy() {
          wasm.free(data);
          wasm.free(pcm);
          wasm.gryt_decoder_destroy(dec);
        },
      };
    },
  };
}
