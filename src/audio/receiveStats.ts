/** One incoming audio stream, as Chromium's receive stats describe it (gh-53). Delays are
    averages over the last poll, so growth over a long call shows up as it happens. */
export interface ReceiveStream {
  id: string;
  ssrc: number | null;
  jitterMs: number | null;
  jitterBufferMs: number | null;
  jitterBufferTargetMs: number | null;
  jitterBufferMinimumMs: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
  concealedSamples: number | null;
  insertedSamplesForDeceleration: number | null;
  removedSamplesForAcceleration: number | null;
  interruptionCount: number | null;
  totalInterruptionDurationMs: number | null;
}

/** The cumulative counters a stream had at the last poll. */
export interface ReceiveCounters {
  emitted: number;
  delay: number;
  target: number | null;
  minimum: number | null;
}

/** The fields of an RTCStats entry read here. Chromium leaves out what it doesn't track. */
interface Stat {
  id?: string;
  type?: string;
  kind?: string;
  ssrc?: number;
  jitter?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  jitterBufferTargetDelay?: number;
  jitterBufferMinimumDelay?: number;
  packetsLost?: number;
  packetsReceived?: number;
  concealedSamples?: number;
  insertedSamplesForDeceleration?: number;
  removedSamplesForAcceleration?: number;
  interruptionCount?: number;
  totalInterruptionDuration?: number;
}

const num = (value: number | undefined): number | null => (typeof value === "number" ? value : null);
const ms = (seconds: number | null): number | null => (seconds === null ? null : seconds * 1000);

/** Cumulative seconds added since `before`, averaged over the samples emitted since, in ms. */
function interval(now: number | null, before: number | null | undefined, dCount: number): number | null {
  if (now === null || before === null || before === undefined || dCount <= 0) return null;
  return ((now - before) / dCount) * 1000;
}

/**
 * Every inbound audio stream in `report`, each against its own previous counters, keyed by
 * stats id. `prev` is updated in place, and streams that have gone are dropped from it.
 */
export function readReceiveStreams(report: Iterable<Stat>, prev: Map<string, ReceiveCounters>): ReceiveStream[] {
  const out: ReceiveStream[] = [];
  const seen = new Set<string>();

  for (const stat of report) {
    if (stat.type !== "inbound-rtp" || stat.kind !== "audio" || typeof stat.id !== "string") continue;
    seen.add(stat.id);

    const emitted = num(stat.jitterBufferEmittedCount);
    const delay = num(stat.jitterBufferDelay);
    const target = num(stat.jitterBufferTargetDelay);
    const minimum = num(stat.jitterBufferMinimumDelay);
    const before = prev.get(stat.id);
    const dCount = emitted !== null && before ? emitted - before.emitted : 0;

    out.push({
      id: stat.id,
      ssrc: num(stat.ssrc),
      jitterMs: ms(num(stat.jitter)),
      jitterBufferMs: interval(delay, before?.delay, dCount),
      jitterBufferTargetMs: interval(target, before?.target, dCount),
      jitterBufferMinimumMs: interval(minimum, before?.minimum, dCount),
      packetsLost: num(stat.packetsLost),
      packetsReceived: num(stat.packetsReceived),
      concealedSamples: num(stat.concealedSamples),
      insertedSamplesForDeceleration: num(stat.insertedSamplesForDeceleration),
      removedSamplesForAcceleration: num(stat.removedSamplesForAcceleration),
      interruptionCount: num(stat.interruptionCount),
      totalInterruptionDurationMs: ms(num(stat.totalInterruptionDuration)),
    });

    if (emitted !== null && delay !== null && emitted > 0) prev.set(stat.id, { emitted, delay, target, minimum });
  }

  for (const id of prev.keys()) if (!seen.has(id)) prev.delete(id);
  return out;
}

/** The largest value present, or null when there is none. */
export function worst(values: (number | null)[]): number | null {
  let max: number | null = null;
  for (const v of values) if (v !== null && (max === null || v > max)) max = v;
  return max;
}

/** A total across streams, or null when none of them reported it. */
export function total(values: (number | null)[]): number | null {
  let sum: number | null = null;
  for (const v of values) if (v !== null) sum = (sum ?? 0) + v;
  return sum;
}
