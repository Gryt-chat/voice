/* The own transport's datagram, as src/transport/packet.ts writes it: version u8, flags u8, seq u16,
   timestamp u32 (48 kHz), then one Opus packet. Big-endian. GRYT-1822. */
#ifndef GRYT_VOICE_PACKET_H
#define GRYT_VOICE_PACKET_H

#include <stddef.h>
#include <stdint.h>

#define GV_PACKET_VERSION 1
#define GV_HEADER_BYTES 8
#define GV_MAX_OPUS_BYTES 1275
#define GV_SENDER_BYTES 4
#define GV_FLAG_SPEAKING 1
/* The payload is a round-trip probe, as src/transport/probe.ts writes it, not Opus (GRYT-1836). */
#define GV_FLAG_PROBE 2

typedef struct {
  uint8_t flags;
  uint16_t seq;
  uint32_t timestamp;
  const uint8_t *opus;
  size_t opus_len;
} gv_packet;

/* Bytes written, or 0 when the Opus payload is empty, too long, or doesn't fit in cap. */
size_t gv_write_packet(const gv_packet *p, uint8_t *out, size_t cap);
/* 0 and p filled for a packet this version wrote; -1 for anything else. p->opus points into bytes. */
int gv_read_packet(const uint8_t *bytes, size_t len, gv_packet *p);
/* A forwarded packet: the SFU's u32 sender id, then the packet as the sender wrote it. */
int gv_read_forwarded(const uint8_t *bytes, size_t len, uint32_t *sender, gv_packet *p);
/* How far b is past a in a wrapping u16 sequence, -32768..32767. */
int gv_seq_delta(uint16_t a, uint16_t b);

#endif
