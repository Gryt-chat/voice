import {
  INITIAL_BUDGET_STATE,
  learnRate,
  planVideoBudget,
  type BudgetState,
  type BudgetStream,
} from "./videoBudget";
import {
  INITIAL_PLAN_STATE,
  planVideoEncoding,
  type VideoEncodingPlan,
  type VideoLimit,
  type VideoPlanState,
  type VideoRole,
  type VideoSendSettings,
  type VideoWanted,
} from "./videoDemand";
import { voiceLog } from "./voiceLogger";

const BITRATE_STEP = 0.1;
/** A size or frame rate change sends a keyframe, so the next seconds say nothing about the picture. */
const SETTLE_MS = 2_000;

type EncodingWithDownTo = RTCRtpEncodingParameters & { scaleResolutionDownTo?: unknown; scalabilityMode?: string };

interface Written {
  active: boolean;
  scale: number;
  fps: number;
  maxBitrate: number | null;
}

interface RoleState {
  settings: VideoSendSettings | null;
  sender: RTCRtpSender | null;
  state: VideoPlanState;
  /** The last write without its bitrate, which only goes out again once it moves by BITRATE_STEP. */
  written: string | null;
  /** What the last write asked for, which is what the next second's bytes are measured against. */
  last: Written | null;
  changedAt: number;
  rate: number | null;
  starved: boolean;
  limit: VideoLimit | null;
}

interface OutboundSample {
  bytes: number;
  frames: number | null;
  /** Chrome's own target for it, which a camera's encoder fills whatever it's showing. */
  target: number | null;
  limited: boolean;
}

interface Sample {
  at: number;
  estimate: number | null;
  outbound: Map<string, OutboundSample>;
  audioBytes: number;
}

type StatsReport = {
  type?: string;
  id?: string;
  kind?: string;
  mid?: string;
  bytesSent?: number;
  headerBytesSent?: number;
  framesEncoded?: number;
  targetBitrate?: number;
  qualityLimitationReason?: string;
  state?: string;
  nominated?: boolean;
  selectedCandidatePairId?: string;
  availableOutgoingBitrate?: number;
};

async function sample(pc: RTCPeerConnection): Promise<Sample | null> {
  let stats: RTCStatsReport;
  try {
    stats = await pc.getStats();
  } catch {
    return null;
  }
  const all: StatsReport[] = [];
  stats.forEach((report: StatsReport) => all.push(report));
  const selected = all.find((r) => r.type === "transport" && r.selectedCandidatePairId)?.selectedCandidatePairId;
  const pair = all.find((r) => r.type === "candidate-pair" && (selected ? r.id === selected : r.nominated && r.state === "succeeded"));
  const outbound = new Map<string, OutboundSample>();
  let audioBytes = 0;
  for (const r of all) {
    if (r.type !== "outbound-rtp") continue;
    const bytes = (r.bytesSent ?? 0) + (r.headerBytesSent ?? 0);
    if (r.kind === "audio") audioBytes += bytes;
    else if (r.mid !== undefined) {
      outbound.set(r.mid, {
        bytes,
        frames: typeof r.framesEncoded === "number" ? r.framesEncoded : null,
        target: typeof r.targetBitrate === "number" && r.targetBitrate > 0 ? r.targetBitrate : null,
        limited: r.qualityLimitationReason === "bandwidth",
      });
    }
  }
  const estimate = typeof pair?.availableOutgoingBitrate === "number" ? pair.availableOutgoingBitrate : null;
  return { at: Date.now(), estimate, outbound, audioBytes };
}

/**
 * The one writer of the camera's and the share's encodings. Once a second it merges the
 * embedder's settings, what viewers want and the send estimate, and writes both senders.
 */
export function createVideoSendController(
  getPc: () => RTCPeerConnection | null,
  getSender: (role: VideoRole) => RTCRtpSender | null,
) {
  const fresh = (): RoleState => ({
    settings: null, sender: null, state: INITIAL_PLAN_STATE, written: null, last: null, changedAt: 0, rate: null, starved: false, limit: null,
  });
  const roles: Record<VideoRole, RoleState> = { camera: fresh(), screen: fresh() };
  const wanted = new Map<string, VideoWanted>();
  let wantedFor: RTCPeerConnection | null = null;
  let budget: BudgetState = INITIAL_BUDGET_STATE;
  let budgetFor: RTCPeerConnection | null = null;
  let previous: Sample | null = null;
  let audio = 0;
  let reservedLast = 0;
  let ingestCap: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  const write = async (role: VideoRole, sender: RTCRtpSender, plan: VideoEncodingPlan, demand: VideoWanted | null, fps: number) => {
    const r = roles[role];
    const settings = r.settings;
    const params = sender.getParameters();
    const enc = params.encodings?.[0] as EncodingWithDownTo | undefined;
    if (!enc || !settings) return;
    if (settings.degradationPreference) params.degradationPreference = settings.degradationPreference;
    if (settings.priority) enc.priority = settings.priority;
    if (settings.scalabilityMode) enc.scalabilityMode = settings.scalabilityMode;
    enc.active = plan.active;
    enc.scaleResolutionDownBy = plan.scaleResolutionDownBy;
    delete enc.scaleResolutionDownTo;
    if (plan.maxFramerate !== undefined && Number.isFinite(plan.maxFramerate)) enc.maxFramerate = plan.maxFramerate;
    else delete enc.maxFramerate;
    const bitrate = plan.maxBitrate !== undefined && Number.isFinite(plan.maxBitrate) ? plan.maxBitrate : null;
    const key = JSON.stringify([params.degradationPreference, { ...enc, maxBitrate: undefined }]);
    const had = r.last?.maxBitrate ?? null;
    const small = key === r.written && bitrate !== null && had !== null && Math.abs(bitrate - had) < had * BITRATE_STEP;
    const next = small ? had : bitrate;
    if (next !== null) enc.maxBitrate = next;
    else delete enc.maxBitrate;
    if (!r.last || r.last.active !== plan.active || r.last.scale !== plan.scaleResolutionDownBy || r.last.fps !== fps) r.changedAt = Date.now();
    r.last = { active: plan.active, scale: plan.scaleResolutionDownBy, fps, maxBitrate: next };

    if (key !== r.written || next !== had) {
      voiceLog.info(role === "camera" ? "CAMERA" : "SCREEN", `encoding: active=${enc.active} scale=${enc.scaleResolutionDownBy} maxBitrate=${enc.maxBitrate ?? "none"} maxFramerate=${enc.maxFramerate ?? "none"} wanted=${demand ? `${demand.width}x${demand.height}@${demand.fps} watchers=${demand.watchers} unknown=${demand.unknown}` : "not said"} estimate=${budget.estimate === null ? "none" : Math.round(budget.estimate / 1000)} seen=${r.rate === null ? "none" : Math.round(r.rate / 1000)}`);
      await sender.setParameters(params);
      r.written = key;
    }

    if (plan.rekick) {
      voiceLog.warn(role === "camera" ? "CAMERA" : "SCREEN", "Encoder produced nothing since resuming, toggling it off and on");
      for (const active of [false, true]) {
        const again = sender.getParameters();
        if (!again.encodings?.[0]) return;
        again.encodings[0].active = active;
        await sender.setParameters(again);
      }
    }
  };

  const update = async (tick: boolean) => {
    const pc = getPc();
    if (!pc) return;
    if (pc !== budgetFor) {
      budget = INITIAL_BUDGET_STATE;
      budgetFor = pc;
      previous = null;
      audio = reservedLast = 0;
    }
    const now = Date.now();
    const sending = (["camera", "screen"] as const).some((role) => roles[role].settings && getSender(role)?.track?.kind === "video");
    if (!sending) {
      previous = null;
      return;
    }
    const current = await sample(pc);
    const dt = current && previous ? (current.at - previous.at) / 1000 : 0;
    const perSecond = (a: number, b: number) => Math.max(0, (a - b) * 8 / dt);
    let sent = 0;
    let reserved = 0;
    if (current && previous && dt >= 0.5) {
      audio = Math.max(perSecond(current.audioBytes, previous.audioBytes), audio * 0.9);
      sent += audio;
      reserved += audio;
    }

    type Pending = { role: VideoRole; sender: RTCRtpSender; demand: VideoWanted | null; input: Parameters<typeof planVideoEncoding>[0]; free: VideoEncodingPlan; budgeted: boolean };
    const pending: Pending[] = [];
    for (const role of ["camera", "screen"] as const) {
      const r = roles[role];
      const sender = getSender(role);
      const track = sender?.track;
      if (!sender || !track || track.kind !== "video" || !r.settings) continue;
      if (sender !== r.sender) {
        Object.assign(r, fresh(), { settings: r.settings, sender });
      }
      const mid = pc.getTransceivers().find((t) => t.sender === sender)?.mid ?? null;
      const demand = pc === wantedFor && mid !== null ? wanted.get(mid) ?? null : null;
      const size = track.getSettings?.() ?? {};
      const source = size.width && size.height
        ? { width: size.width, height: size.height, frameRate: size.frameRate }
        : null;
      const out = mid !== null ? current?.outbound.get(mid) : undefined;
      const before = mid !== null ? previous?.outbound.get(mid) : undefined;
      if (tick && out && before && dt >= 0.5) {
        const used = perSecond(out.bytes, before.bytes);
        sent += used;
        if (r.settings.followDemand === false) reserved += used;
        else if (r.last?.active && now - r.changedAt >= SETTLE_MS) {
          const held = Math.min(r.last.maxBitrate ?? Infinity, out.target ?? Infinity);
          const frames = out.frames !== null && before.frames !== null ? (out.frames - before.frames) / dt : null;
          r.starved = frames !== null && frames < r.last.fps * 0.6;
          r.rate = learnRate(r.rate, used, r.last.scale, r.last.fps, used >= held * 0.85 || out.limited);
        }
      }
      const input = { role, source, settings: r.settings, wanted: demand, now, framesEncoded: out?.frames ?? null };
      const free = planVideoEncoding(input, r.state);
      pending.push({ role, sender, demand, input, free, budgeted: r.settings.followDemand !== false && source !== null && free.active });
    }

    const streams: BudgetStream[] = [];
    const index = new Map<VideoRole, number>();
    for (const p of pending) {
      if (!p.budgeted || !p.input.source) continue;
      const r = roles[p.role];
      const sourceFps = p.input.source.frameRate || 30;
      index.set(p.role, streams.length);
      streams.push({
        role: p.role,
        source: p.input.source,
        scale: p.free.scaleResolutionDownBy,
        fps: Math.min(p.free.maxFramerate ?? Infinity, sourceFps),
        maxBitrate: r.settings?.maxBitrate ?? undefined,
        large: p.role === "screen" && p.free.state.rung < 2,
        keepFramerate: r.settings?.degradationPreference === "maintain-framerate",
        rate: r.rate,
        starved: r.starved,
        was: r.limit,
      });
    }
    let limits: VideoLimit[] | null = null;
    if (tick) {
      const planned = planVideoBudget({ now, estimate: current?.estimate ?? null, ingestCap, reserved, sent, streams }, budget);
      budget = planned.state;
      limits = planned.limits;
      reservedLast = reserved;
    } else if (budget.estimate !== null) {
      const planned = planVideoBudget({ now, estimate: null, ingestCap, reserved: reservedLast, sent, streams }, budget);
      limits = planned.limits;
    }
    if (tick && current) previous = current;

    for (const p of pending) {
      const r = roles[p.role];
      const i = index.get(p.role);
      const limit = limits && i !== undefined ? limits[i] : null;
      r.limit = limit;
      const plan = limit ? planVideoEncoding({ ...p.input, limit }, r.state) : p.free;
      r.state = plan.state;
      const fps = Math.min(plan.maxFramerate ?? Infinity, p.input.source?.frameRate || 30);
      await write(p.role, p.sender, plan, p.demand, fps);
    }
  };

  const schedule = (tick: boolean) => {
    chain = chain.then(() => update(tick)).catch((err: unknown) => {
      roles.camera.written = roles.screen.written = null;
      voiceLog.warn("CAMERA", `setParameters failed: ${err}`);
    });
  };

  return {
    /** The embedder's settings for one role, or null once that stream has stopped. */
    setSettings(role: VideoRole, settings: VideoSendSettings | null) {
      roles[role].settings = settings;
      if (!settings) roles[role].rate = null;
      schedule(false);
    },
    onWanted(update: VideoWanted & { mid: string }) {
      const pc = getPc();
      if (pc !== wantedFor) {
        wanted.clear();
        wantedFor = pc;
      }
      const { mid, ...rest } = update;
      wanted.set(mid, rest);
      schedule(false);
    },
    /** The SFU's cap on what this peer sends it, in bits per second, from room_joined. */
    setIngestCap(bps: number | null) {
      ingestCap = bps;
    },
    /** Once a second while connected: the estimate, the holds, the pause and the resume check. */
    tick: () => schedule(true),
  };
}
