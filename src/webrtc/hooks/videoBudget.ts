import { cameraBitrate, SCALE_LADDER, screenBitrate, type VideoLimit, type VideoRole } from "./videoDemand";

/** Video spends this much of what's left after audio; the rest absorbs the estimate's wobble. */
export const SPEND = 0.9;
export const RISE_MARGIN = 1.2;
export const RISE_AFTER_MS = 2_000;
/** A keyframe at 0.8 Mbps stalled a 1080p share for up to 7 s, which is no reason to shrink it. */
export const DRASTIC_AFTER_MS = 10_000;
export const MIN_CAMERA_FPS = 15;
/** Under 10 fps, VideoToolbox stalled a text share for seconds at a time at 0.8 Mbps. */
export const MIN_SCREEN_FPS = 10;
export const MIN_HEIGHT = 180;
/** A stream's need is 25% over what it was seen to use, so a busier picture has room to show. */
export const HEADROOM = 1.25;
/** A fall with the sender this far under the estimate is Chrome decaying an idle estimate, not congestion. */
export const APP_LIMITED = 1.5;
const LEARN = 0.2;
const MIN_CAP = 50_000;

export interface BudgetStream {
  role: VideoRole;
  source: { width: number; height: number };
  /** What demand and the user's ceiling ask for, before the budget. */
  scale: number;
  fps: number;
  maxBitrate?: number;
  /** A share drawn at half its size or more: the one kept sharp, and cut last. */
  large: boolean;
  /** maintain-framerate, as a gaming share asks: it gives up size before frames. */
  keepFramerate?: boolean;
  /** Bits per second it was seen to need at its source size and 30 fps, or null before any. */
  rate: number | null;
  /** It encoded under 60% of the frames it's allowed last second. */
  starved?: boolean;
  /** Last second's limit: nothing goes back up until it fits with RISE_MARGIN to spare. */
  was?: VideoLimit | null;
}

const pixelFactor = (scale: number) => Math.pow(1 / (scale * scale), 0.75);
const fpsFactor = (fps: number) => Math.pow(fps / 30, 0.7);

/** The most a stream may take at this size: the bitrate rule, under the user's own cap. */
export function streamCeiling(s: BudgetStream, scale: number, fps: number): number {
  const w = s.source.width / scale, h = s.source.height / scale;
  const rule = s.role === "camera" ? cameraBitrate(w, h, fps) : screenBitrate(h, fps);
  return Math.min(rule, s.maxBitrate ?? Infinity);
}

/** What a stream needs at this size: its ceiling, or less when it was seen to use less. */
export function streamNeed(s: BudgetStream, scale: number, fps: number): number {
  const seen = s.rate === null ? Infinity : s.rate * pixelFactor(scale) * fpsFactor(fps) * HEADROOM;
  return Math.min(streamCeiling(s, scale, fps), seen);
}

/** A rate sample from bits sent, normalised to the source size and 30 fps, averaged in slowly. */
export function learnRate(previous: number | null, used: number, scale: number, fps: number, limited: boolean): number | null {
  // Held down, an encoder fills whatever it's given, so the bytes say nothing about the picture.
  if (limited) return previous;
  const sample = used / (pixelFactor(scale) * fpsFactor(Math.max(1, fps)));
  return previous === null ? sample : previous + (sample - previous) * LEARN;
}

function floorScale(s: BudgetStream, scale: number): number {
  let floor = scale;
  for (const step of SCALE_LADDER) if (step > floor && s.source.height / step >= MIN_HEIGHT) floor = step;
  return floor;
}

const FPS_STEPS = [60, 48, 30, 24, 20, 15, 12, 10, 8, 6, 5];
const nextRung = (scale: number) => SCALE_LADDER.find((step) => step > scale + 1e-9) ?? scale;

export interface BudgetSplit {
  limits: VideoLimit[];
  /** It only fits by pausing the camera or shrinking the large share, which wait for DRASTIC_AFTER_MS. */
  short: boolean;
  /** Short even with RISE_MARGIN to spare, which is what lifting those two cuts waits for. */
  shortWithMargin?: boolean;
}

/** Section 3's cuts, in order, until the streams fit. `drastic` allows the last two. */
function cutToFit(budget: number, streams: BudgetStream[], drastic: boolean): BudgetSplit {
  const out: VideoLimit[] = streams.map((s) => ({ scale: s.scale, fps: s.fps, maxBitrate: 0, paused: false }));
  const need = (i: number) => (out[i].paused ? 0 : streamNeed(streams[i], out[i].scale, out[i].fps));
  const total = () => out.reduce((sum, _, i) => sum + need(i), 0);
  const fits = () => total() <= budget;
  const each = (pick: (s: BudgetStream) => boolean, cut: (i: number) => void) => {
    streams.forEach((s, i) => {
      if (!fits() && pick(s)) cut(i);
    });
  };
  const camera = (s: BudgetStream) => s.role === "camera";
  const small = (s: BudgetStream) => s.role === "screen" && !s.large;
  const large = (s: BudgetStream) => s.role === "screen" && s.large;
  const sharp = (s: BudgetStream) => large(s) && !s.keepFramerate;
  const smooth = (s: BudgetStream) => large(s) && s.keepFramerate === true;
  const shrink = (i: number) => {
    const floor = floorScale(streams[i], out[i].scale);
    while (!fits() && out[i].scale < floor) out[i].scale = Math.min(nextRung(out[i].scale), floor);
  };
  const slow = (i: number) => {
    while (!fits() && out[i].fps > MIN_SCREEN_FPS) out[i].fps = Math.max(MIN_SCREEN_FPS, FPS_STEPS.find((f) => f < out[i].fps) ?? 0);
  };

  each(camera, (i) => { out[i].fps = Math.min(out[i].fps, MIN_CAMERA_FPS); });
  each(camera, shrink);
  each(small, shrink);
  each(sharp, slow);
  each(smooth, shrink);

  // Entered only when the large share is dropping frames. The model alone overstates a text share: at
  // 0.8 Mbps one ran its full 10 fps on 350-400 kbps while the model asked for 550.
  const known = streams.every((s) => !large(s) || (s.rate !== null && s.starved === true));
  const short = !fits() && (known || drastic);
  if (short && drastic) {
    each(camera, (i) => { out[i].paused = true; });
    each(sharp, shrink);
    each(smooth, slow);
  }
  return { limits: out, short };
}

/**
 * Section 3's rule: cut until the streams fit the budget, then share out what's left, the
 * large share first. A cut takes effect at once; undoing one waits for RISE_MARGIN of room.
 */
export function splitVideoBudget(budget: number, streams: BudgetStream[], drastic: boolean, spend = budget): BudgetSplit {
  const tight = cutToFit(budget, streams, drastic);
  const margin = cutToFit(budget / RISE_MARGIN, streams, drastic);
  // Each value lies between the two splits, so it's cut at least as far as one that fits.
  const out: VideoLimit[] = streams.map((s, i) => {
    const t = tight.limits[i], m = margin.limits[i], was = s.was;
    if (!was) return t;
    return {
      scale: Math.max(t.scale, Math.min(was.scale, m.scale)),
      fps: Math.min(t.fps, Math.max(was.fps, m.fps)),
      maxBitrate: 0,
      paused: t.paused || (was.paused && m.paused),
    };
  });
  const need = (i: number) => (out[i].paused ? 0 : streamNeed(streams[i], out[i].scale, out[i].fps));
  const total = () => out.reduce((sum, _, i) => sum + need(i), 0);
  const large = (s: BudgetStream) => s.role === "screen" && s.large;

  let spare = spend - total();
  const order = [...streams.keys()].sort((a, b) => Number(large(streams[b])) - Number(large(streams[a])));
  for (const i of order) {
    if (out[i].paused) continue;
    const base = need(i);
    const extra = Math.max(0, Math.min(spare, streamCeiling(streams[i], out[i].scale, out[i].fps) - base));
    out[i].maxBitrate = Math.round(base + extra);
    spare -= extra;
  }
  // Still over: the large share takes the shortfall, since everything else is at its floor already.
  for (const i of order) {
    if (spare >= 0 || out[i].paused || !large(streams[i])) continue;
    const cut = Math.round(Math.min(-spare, out[i].maxBitrate - MIN_CAP));
    if (cut > 0) {
      out[i].maxBitrate -= cut;
      spare += cut;
    }
  }
  return { limits: out, short: tight.short, shortWithMargin: margin.short };
}

export interface BudgetState {
  /** The estimate the split follows: down at once, up only after RISE_AFTER_MS of RISE_MARGIN headroom. */
  estimate: number | null;
  riseSince: number | null;
  riseLow: number;
  shortSince: number | null;
  /** This second's estimate, which the bitrates follow both ways; null when it only sank for want of traffic. */
  current: number | null;
}

export const INITIAL_BUDGET_STATE: BudgetState = { estimate: null, riseSince: null, riseLow: Infinity, shortSince: null, current: null };

/** Follows availableOutgoingBitrate, given what was sent over the same second. */
export function followEstimate(state: BudgetState, raw: number | null, sent: number, now: number): BudgetState {
  const next = { ...state };
  if (raw === null || !(raw > 0)) return next;
  next.current = raw;
  if (next.estimate === null) {
    next.estimate = raw;
  } else if (raw < next.estimate) {
    // While little is sent the estimate sinks towards it, which says nothing about the link.
    if (raw <= sent * APP_LIMITED) next.estimate = raw;
    else next.current = null;
    next.riseSince = null;
    next.riseLow = Infinity;
  } else if (raw >= next.estimate * RISE_MARGIN) {
    next.riseSince ??= now;
    next.riseLow = Math.min(next.riseLow, raw);
    if (now - next.riseSince >= RISE_AFTER_MS) {
      next.estimate = next.riseLow;
      next.riseSince = null;
      next.riseLow = Infinity;
    }
  } else {
    next.riseSince = null;
    next.riseLow = Infinity;
  }
  return next;
}

export interface BudgetPlanInput {
  now: number;
  estimate: number | null;
  /** The SFU's ingest cap for this peer, in bits per second, if the operator set one. */
  ingestCap: number | null;
  /** Bits per second going to audio, and to any video the engine can't set. */
  reserved: number;
  sent: number;
  streams: BudgetStream[];
}

/** The split for this second, or null limits when there's no estimate to split. */
export function planVideoBudget(input: BudgetPlanInput, previous: BudgetState): { limits: VideoLimit[] | null; budget: number | null; state: BudgetState } {
  const state = followEstimate(previous, input.estimate, input.sent, input.now);
  if (state.estimate === null || input.streams.length === 0) return { limits: null, budget: null, state: { ...state, shortSince: null } };
  const ceiling = Math.min(state.estimate, input.ingestCap ?? Infinity);
  const budget = Math.max(0, (ceiling - input.reserved) * SPEND);
  // Sizes and frame rates follow the held estimate; bitrates follow this second's, as Chrome's own targets do.
  const current = Math.min(state.current ?? state.estimate, input.ingestCap ?? Infinity);
  const spend = Math.max(0, (current - input.reserved) * SPEND);
  const drastic = state.shortSince !== null && input.now - state.shortSince >= DRASTIC_AFTER_MS;
  const split = splitVideoBudget(budget, input.streams, drastic, spend);
  const stay = drastic && split.shortWithMargin;
  state.shortSince = split.short || stay ? state.shortSince ?? input.now : null;
  return { limits: split.limits, budget, state };
}
