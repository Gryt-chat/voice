// The own transport's jitter buffer (GRYT-1818), against a simulated network: it holds steady under
// jitter and loss, drains back after a stall, and survives the sequence number wrapping.

import assert from "node:assert/strict";

import { JitterBuffer } from "../dist/transport/jitterBuffer.js";
import type { AudioPacket } from "../dist/transport/packet.js";

const FRAME_MS = 2.5;
const opus = new Uint8Array([1, 2, 3]);

interface Net {
  seconds: number;
  baseMs: number;
  jitterMs: number;
  loss: number;
  stallAtMs?: number;
  stallMs?: number;
  firstSeq?: number;
}

/** Plays `seconds` of a sender through the network and the buffer; returns each played frame's delay. */
function simulate(net: Net) {
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const jb = new JitterBuffer({ frameMs: FRAME_MS });
  const frames = Math.round((net.seconds * 1000) / FRAME_MS);
  const arrivals: { at: number; p: AudioPacket; sentAt: number }[] = [];
  for (let k = 0; k < frames; k++) {
    if (random() < net.loss) continue;
    const sentAt = k * FRAME_MS;
    let at = sentAt + net.baseMs + random() * net.jitterMs;
    // A stall: nothing gets through for a while, then it all lands at once.
    const stallEnd = (net.stallAtMs ?? 0) + (net.stallMs ?? 0);
    if (net.stallAtMs !== undefined && at >= net.stallAtMs && at < stallEnd) at = stallEnd;
    arrivals.push({ at, sentAt, p: { flags: 0, seq: ((net.firstSeq ?? 0) + k) & 0xffff, timestamp: (k * 120) >>> 0, opus } });
  }
  arrivals.sort((a, b) => a.at - b.at);
  const sentAtBySeq = new Map(arrivals.map((a) => [a.p.seq, a.sentAt]));
  const delays: { at: number; delay: number }[] = [];
  let i = 0;
  for (let t = 0; t < net.seconds * 1000 + 200; t += FRAME_MS) {
    while (i < arrivals.length && arrivals[i].at <= t) {
      jb.push(arrivals[i].p, arrivals[i].at);
      i++;
    }
    const out = jb.pull();
    const sentAt = out.kind === "packet" ? sentAtBySeq.get(out.packet.seq) : undefined;
    if (sentAt !== undefined) delays.push({ at: t, delay: t - sentAt });
  }
  return { jb, delays };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const between = (d: { at: number; delay: number }[], from: number, to: number) => median(d.filter((x) => x.at >= from && x.at < to).map((x) => x.delay));

// A clean LAN: plays from the minimum, and nothing is lost or rebuffered once it starts.
{
  const { jb, delays } = simulate({ seconds: 10, baseMs: 2, jitterMs: 0, loss: 0 });
  assert.ok(between(delays, 1000, 10000) <= 2 + 5 + FRAME_MS, `a clean link played ${between(delays, 1000, 10000)} ms behind`);
  assert.equal(jb.stats.lost, 0);
  assert.ok(jb.stats.rebuffered <= 1, `a clean link rebuffered ${jb.stats.rebuffered} times`);
}

// Jitter and loss: holds steady for a minute instead of growing, and conceals what's lost.
{
  const { jb, delays } = simulate({ seconds: 60, baseMs: 3, jitterMs: 6, loss: 0.02 });
  const early = between(delays, 5000, 10000);
  const late = between(delays, 50000, 60000);
  assert.ok(Math.abs(late - early) <= FRAME_MS * 2, `the delay drifted from ${early} to ${late} ms over a minute`);
  assert.ok(early <= 3 + 6 + 10, `6 ms of jitter cost ${early} ms`);
  const lostShare = jb.stats.lost / (60000 / FRAME_MS);
  assert.ok(lostShare > 0.01 && lostShare < 0.04, `lost frames were ${(lostShare * 100).toFixed(1)}% with 2% loss`);
}

// A 150 ms stall, then everything at once: the buffer drains back instead of keeping the extra delay.
{
  const { jb, delays } = simulate({ seconds: 20, baseMs: 3, jitterMs: 2, loss: 0, stallAtMs: 8000, stallMs: 150 });
  const before = between(delays, 3000, 8000);
  const after = between(delays, 15000, 20000);
  assert.ok(after - before <= FRAME_MS * 2, `a stall left the delay at ${after} ms, up from ${before}`);
  assert.ok(jb.stats.drained > 0, "nothing was drained after the stall");
}

// The sequence number wraps from 65535 to 0 mid-call.
{
  const { jb, delays } = simulate({ seconds: 2, baseMs: 2, jitterMs: 1, loss: 0, firstSeq: 65500 });
  assert.ok(delays.length > 700, `only ${delays.length} frames played across the wrap`);
  assert.equal(jb.stats.lost, 0, "the wrap was taken as loss");
}

// Duplicates and stragglers are dropped, not played twice or out of order.
{
  const jb = new JitterBuffer({ frameMs: FRAME_MS });
  const p = (seq: number): AudioPacket => ({ flags: 0, seq, timestamp: seq * 120, opus });
  for (const seq of [0, 1, 2, 3]) jb.push(p(seq), seq * FRAME_MS);
  jb.push(p(2), 10);
  const played: number[] = [];
  for (let k = 0; k < 4; k++) {
    const out = jb.pull();
    if (out.kind === "packet") played.push(out.packet.seq);
  }
  jb.push(p(1), 20);
  assert.equal(jb.stats.duplicate, 1);
  assert.equal(jb.stats.late, 1);
  assert.deepEqual(played, [0, 1, 2, 3]);
}

console.log("jitter buffer: steady under jitter and loss for a minute, drains back after a stall, survives the wrap");
