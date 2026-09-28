import { estimateBitrate } from "../../audio/lib/screenBitrate";
import type { CaptureQuality } from "../../types";

/** Which of our own video streams: the camera's m-line or the screen share's. */
export type VideoRole = "camera" | "screen";

/** What the SFU says viewers want of one of our streams. `unknown` viewers never said, so want it all. */
export interface VideoWanted {
  width: number;
  height: number;
  fps: number;
  watchers: number;
  unknown: number;
}

/**
 * What the embedder wants of one outgoing video stream: the user's picks. Each is a ceiling,
 * and the engine may send less when nobody draws it that big.
 */
export interface VideoSendSettings {
  maxSize?: { width: number; height: number } | null;
  maxFramerate?: number;
  maxBitrate?: number | null;
  priority?: RTCPriorityType;
  degradationPreference?: RTCDegradationPreference;
  scalabilityMode?: string;
  /** False keeps the settings as they are, whatever viewers want. For encoders setParameters can't reach. */
  followDemand?: boolean;
}

/** What a viewer reports for one remote video, in device pixels. Zero means nobody can see it. */
export interface VideoDemand {
  width: number;
  height: number;
  fps?: number;
}

export const SCALE_LADDER = [1, 1.5, 2, 3, 4, 6, 8];
export const HOLD_DOWN_MS = 5_000;
export const PAUSE_AFTER_MS = 10_000;
export const RESUME_CHECK_MS = 1_000;
export const RESUME_WATCH_MS = 5_000;
export const MAX_REKICKS = 3;
// The engine ticks once a second too, so a check due a moment from now is taken on this tick.
const CHECK_SLACK_MS = 200;

export interface VideoPlanState {
  /** The demand's rung, held on the way down. The user's ceiling is applied on top of it. */
  rung: number;
  fps: number;
  rungLowerSince: number | null;
  fpsLowerSince: number | null;
  idleSince: number | null;
  paused: boolean;
  /** Paused by the budget rather than by nobody watching. */
  held: boolean;
  /** A resume being watched: the next check, when watching ends, the last frame count, re-kicks so far. */
  resume: { at: number; until: number; frames: number | null; tries: number } | null;
}

export const INITIAL_PLAN_STATE: VideoPlanState = {
  rung: 1, fps: Infinity, rungLowerSince: null, fpsLowerSince: null, idleSince: null, paused: false, held: false, resume: null,
};

export interface VideoPlanInput {
  role: VideoRole;
  source: { width: number; height: number; frameRate?: number } | null;
  settings: VideoSendSettings;
  /** Null until this SFU says anything, which an SFU from before GRYT-1432 never does. */
  wanted: VideoWanted | null;
  now: number;
  /** framesEncoded on this stream's outbound-rtp, when the plan has a resume to check. */
  framesEncoded: number | null;
  /** What the budget allows this second, on top of demand. */
  limit?: VideoLimit | null;
}

/** The budget's say over one stream: at least this scale, at most this frame rate and bitrate. */
export interface VideoLimit {
  scale: number;
  fps: number;
  maxBitrate: number;
  paused: boolean;
}

export interface VideoEncodingPlan {
  active: boolean;
  scaleResolutionDownBy: number;
  maxBitrate?: number;
  maxFramerate?: number;
  /** The encoder produced nothing since a resume: set active off and on again. */
  rekick: boolean;
  state: VideoPlanState;
}

const PIXELS_1080P = 1920 * 1080;
const SCREEN_RUNGS: [number, CaptureQuality][] = [
  [144, "144p"], [240, "240p"], [360, "360p"], [480, "480p"], [720, "720p"],
  [1080, "1080p"], [1440, "1440p"], [2160, "4k"],
];

/** A camera's bitrate: Chrome's 2.5 Mbps at 1080p30, scaled by pixels^0.75 and (fps/30)^0.7. */
export function cameraBitrate(width: number, height: number, fps: number): number {
  return Math.round(2_500_000 * Math.pow((width * height) / PIXELS_1080P, 0.75) * Math.pow(fps / 30, 0.7));
}

/** A share's bitrate: the picker's table, at the smallest quality that holds this height. */
export function screenBitrate(height: number, fps: number): number {
  const quality = SCREEN_RUNGS.find(([h]) => h >= height)?.[1] ?? "4k";
  return estimateBitrate(quality, fps) ?? 50_000_000;
}

/** Viewers round up to 16, so an output within 16 pixels of the wanted size covers it. */
const ROUNDING = 15;

/** The largest ladder scale whose output still covers the wanted size, or 1. */
export function rungFor(source: { width: number; height: number }, wanted: { width: number; height: number }): number {
  let rung = 1;
  for (const scale of SCALE_LADDER) {
    if (source.width / scale + ROUNDING >= wanted.width && source.height / scale + ROUNDING >= wanted.height) rung = scale;
  }
  return rung;
}

/** Takes a better value at once and a worse one only after it has held for HOLD_DOWN_MS. */
function hold<T>(current: T, next: T, lowerSince: number | null, now: number, better: (a: T, b: T) => boolean): [T, number | null] {
  if (next === current || better(next, current)) return [next, null];
  const since = lowerSince ?? now;
  return now - since >= HOLD_DOWN_MS ? [next, null] : [current, since];
}

/**
 * One stream's encoding from its source, the user's settings, what viewers want and the time.
 * Pure, so a check can run it on a clock of its own; the engine runs it every second.
 */
export function planVideoEncoding(input: VideoPlanInput, previous: VideoPlanState): VideoEncodingPlan {
  const { source, settings, wanted, now, framesEncoded } = input;
  const state: VideoPlanState = { ...previous };
  const ceiling = settings.maxSize && source
    ? Math.max(1, source.width / settings.maxSize.width, source.height / settings.maxSize.height)
    : 1;
  const userFps = settings.maxFramerate ?? Infinity;
  const demand = settings.followDemand !== false ? wanted : null;
  const everything = demand === null || demand.unknown > 0;
  const watched = everything || demand.watchers > 0;
  const wasOff = previous.paused || previous.held;
  let rekick = false;

  if (!watched) {
    state.idleSince ??= now;
    state.rungLowerSince = state.fpsLowerSince = null;
    if (!state.paused && now - state.idleSince >= PAUSE_AFTER_MS) {
      state.paused = true;
      state.resume = null;
    }
  } else {
    state.idleSince = null;
    state.paused = false;

    const rung = everything || !source ? 1 : rungFor(source, demand);
    const fps = everything || !(demand.fps > 0) ? userFps : Math.min(userFps, demand.fps);
    [state.rung, state.rungLowerSince] = hold(state.rung, rung, state.rungLowerSince, now, (a, b) => a < b);
    [state.fps, state.fpsLowerSince] = hold(state.fps, fps, state.fpsLowerSince, now, (a, b) => a > b);
  }

  state.held = !state.paused && input.limit?.paused === true;
  if (state.paused || state.held) state.resume = null;
  else if (wasOff) state.resume = { at: now + RESUME_CHECK_MS, until: now + RESUME_WATCH_MS, frames: framesEncoded, tries: 0 };

  if (state.resume && now + CHECK_SLACK_MS >= state.resume.at) {
    const { until, frames, tries } = state.resume;
    // Fewer than two: the frozen resumes drew their first keyframe and nothing after it.
    rekick = now <= until && framesEncoded !== null && frames !== null && framesEncoded - frames < 2;
    const kicked = tries + (rekick ? 1 : 0);
    state.resume = now + RESUME_CHECK_MS <= until && kicked < MAX_REKICKS
      ? { at: now + RESUME_CHECK_MS, until, frames: framesEncoded, tries: kicked }
      : null;
  }

  const scale = Math.max(state.rung, ceiling);
  const maxFramerate = Number.isFinite(state.fps) ? state.fps : settings.maxFramerate;
  let maxBitrate = settings.maxBitrate ?? undefined;
  // Only once demand shrinks it: a stream drawn at full size keeps exactly what the user set.
  if (source && scale > ceiling) {
    const fps = Math.min(maxFramerate ?? 30, source.frameRate || Infinity);
    const rule = input.role === "camera"
      ? cameraBitrate(source.width / scale, source.height / scale, fps)
      : screenBitrate(source.height / scale, fps);
    maxBitrate = Math.min(rule, maxBitrate ?? Infinity);
  }
  const limit = input.limit;
  if (limit) {
    return {
      active: !state.paused && !state.held,
      scaleResolutionDownBy: Math.max(scale, limit.scale),
      maxBitrate: Math.min(maxBitrate ?? Infinity, limit.maxBitrate),
      maxFramerate: Math.min(maxFramerate ?? Infinity, limit.fps),
      rekick,
      state,
    };
  }

  return { active: !state.paused && !state.held, scaleResolutionDownBy: scale, maxBitrate, maxFramerate, rekick, state };
}

/** The payload of video_wanted, or null for one we can't read. */
export function parseVideoWanted(data: unknown): (VideoWanted & { mid: string }) | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const [width, height, fps, watchers, unknown] = [n(p.width), n(p.height), n(p.fps), n(p.watchers), n(p.unknown)];
  if (typeof p.mid !== "string" || width === null || height === null || watchers === null || unknown === null) return null;
  return { mid: p.mid, width, height, fps: fps ?? 0, watchers, unknown };
}

/** Rounded up to a multiple of 16, so a one-pixel resize isn't a message. */
function roundUp16(n: number): number {
  return n > 0 ? Math.ceil(n / 16) * 16 : 0;
}

const DEMAND_UP_MS = 100;
const DEMAND_DOWN_MS = 1_000;

/**
 * Sends what this viewer draws, per remote stream, over the SFU socket. Increases go out after
 * 100 ms of quiet and decreases after 1 s; a new socket gets every stream's last report again.
 */
export function createDemandReporter(getSocket: () => WebSocket | null) {
  const latest = new Map<string, { width: number; height: number; fps: number }>();
  const sent = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let sentOn: WebSocket | null = null;

  const send = (streamId: string) => {
    const ws = getSocket();
    const demand = latest.get(streamId);
    if (!ws || ws.readyState !== WebSocket.OPEN || !demand) return;
    if (ws !== sentOn) {
      sent.clear();
      sentOn = ws;
    }
    const data = JSON.stringify({ stream_id: streamId, ...demand });
    if (sent.get(streamId) === data) return;
    try {
      ws.send(JSON.stringify({ event: "video_demand", data }));
      sent.set(streamId, data);
    } catch {
      /* closed between the check and the send; the next socket re-sends it */
    }
  };

  return {
    report(streamId: string, demand: VideoDemand | null) {
      const pending = timers.get(streamId);
      if (pending) clearTimeout(pending);
      timers.delete(streamId);
      if (!demand) {
        latest.delete(streamId);
        sent.delete(streamId);
        return;
      }
      const hidden = !(demand.width > 0 && demand.height > 0);
      const next = {
        width: hidden ? 0 : roundUp16(demand.width),
        height: hidden ? 0 : roundUp16(demand.height),
        fps: Math.round(demand.fps ?? 0),
      };
      const prev = latest.get(streamId);
      latest.set(streamId, next);
      // A first report of 0x0 is a decrease too, from full size, so a tile mounting late wins.
      const up = !hidden && (!prev || next.width > prev.width || next.height > prev.height || next.fps > prev.fps);
      timers.set(streamId, setTimeout(() => {
        timers.delete(streamId);
        send(streamId);
      }, up ? DEMAND_UP_MS : DEMAND_DOWN_MS));
    },
    /** Every stream's last report, for a socket that has just joined. */
    resend() {
      for (const streamId of latest.keys()) {
        if (!timers.has(streamId)) send(streamId);
      }
    },
  };
}
