#include "packet.h"

#include <string.h>

static uint16_t get16(const uint8_t *b) { return (uint16_t)(b[0] << 8 | b[1]); }
static uint32_t get32(const uint8_t *b) { return (uint32_t)b[0] << 24 | (uint32_t)b[1] << 16 | (uint32_t)b[2] << 8 | b[3]; }

size_t gv_write_packet(const gv_packet *p, uint8_t *out, size_t cap) {
  size_t len = GV_HEADER_BYTES + p->opus_len;
  if (p->opus_len == 0 || p->opus_len > GV_MAX_OPUS_BYTES || len > cap) return 0;
  out[0] = GV_PACKET_VERSION;
  out[1] = p->flags;
  out[2] = (uint8_t)(p->seq >> 8);
  out[3] = (uint8_t)p->seq;
  out[4] = (uint8_t)(p->timestamp >> 24);
  out[5] = (uint8_t)(p->timestamp >> 16);
  out[6] = (uint8_t)(p->timestamp >> 8);
  out[7] = (uint8_t)p->timestamp;
  memcpy(out + GV_HEADER_BYTES, p->opus, p->opus_len);
  return len;
}

int gv_read_packet(const uint8_t *bytes, size_t len, gv_packet *p) {
  if (len <= GV_HEADER_BYTES || len > GV_HEADER_BYTES + GV_MAX_OPUS_BYTES) return -1;
  if (bytes[0] != GV_PACKET_VERSION) return -1;
  p->flags = bytes[1];
  p->seq = get16(bytes + 2);
  p->timestamp = get32(bytes + 4);
  p->opus = bytes + GV_HEADER_BYTES;
  p->opus_len = len - GV_HEADER_BYTES;
  return 0;
}

int gv_read_forwarded(const uint8_t *bytes, size_t len, uint32_t *sender, gv_packet *p) {
  if (len <= GV_SENDER_BYTES || gv_read_packet(bytes + GV_SENDER_BYTES, len - GV_SENDER_BYTES, p) != 0) return -1;
  *sender = get32(bytes);
  return 0;
}

int gv_seq_delta(uint16_t a, uint16_t b) { return (int)((uint16_t)(b - a + 0x8000)) - 0x8000; }
