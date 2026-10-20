// The native engine's C core (GRYT-1822): its own asserts, then the same bytes as the TypeScript packet
// format and as OpenSSL's ChaCha20-Poly1305, so the C isn't only checked against itself. Against dist.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { writePacket } = await import("../dist/transport/packet.js");

const bin = join(mkdtempSync(join(tmpdir(), "gv-core-")), "core_test");
execFileSync("cc", [
  "-std=c99", "-O2", "-Wall", "-Wextra", "-Werror", "-o", bin,
  "native/core/packet.c", "native/core/seal.c", "native/vendor/monocypher/monocypher.c", "native/test/core_test.c",
]);
const run = (...args: string[]) => execFileSync(bin, args, { encoding: "utf8" }).trim();
console.log(run("unit"));

const opus = randomBytes(37);
assert.equal(run("packet", "1", "65534", "4000000000", opus.toString("hex")),
  Buffer.from(writePacket({ flags: 1, seq: 65534, timestamp: 4000000000, opus })).toString("hex"));

// The sealed layout: session, counter, clear part (AAD with both), Opus encrypted, tag. Nonce: dir, 3 zeros, u64 counter.
function seal(key: Buffer, dir: number, session: number, counter: number, clear: Buffer, secret: Buffer): Buffer {
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(session, 0);
  prefix.writeUInt32BE(counter, 4);
  const nonce = Buffer.alloc(12);
  nonce[0] = dir;
  nonce.writeUInt32BE(counter, 8);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const ad = Buffer.concat([prefix, clear]);
  cipher.setAAD(ad, { plaintextLength: secret.length });
  return Buffer.concat([ad, cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
}

for (let i = 0; i < 20; i++) {
  const key = randomBytes(32), clear = randomBytes(i % 2 ? 8 : 12), secret = randomBytes(1 + i * 50);
  const dir = i % 2, session = randomBytes(4).readUInt32BE(), counter = randomBytes(4).readUInt32BE();
  const openssl = seal(key, dir, session, counter, clear, secret);
  const ours = run("seal", key.toString("hex"), String(dir), String(session), String(counter), clear.toString("hex"), secret.toString("hex"));
  assert.equal(ours, openssl.toString("hex"), "C and OpenSSL sealed different bytes");
  assert.equal(run("open", key.toString("hex"), String(dir), String(clear.length), openssl.toString("hex")), secret.toString("hex"));
  openssl[openssl.length - 1] ^= 1;
  assert.equal(run("open", key.toString("hex"), String(dir), String(clear.length), openssl.toString("hex")), "reject");
}

console.log("native core ok: packets match the TypeScript, sealing matches OpenSSL both ways, tampering is refused");
