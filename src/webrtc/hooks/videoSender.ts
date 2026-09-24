import {
  INITIAL_PLAN_STATE,
  planVideoEncoding,
  type VideoPlanState,
  type VideoRole,
  type VideoSendSettings,
  type VideoWanted,
} from "./videoDemand";
import { voiceLog } from "./voiceLogger";

type EncodingWithDownTo = RTCRtpEncodingParameters & { scaleResolutionDownTo?: unknown; scalabilityMode?: string };

interface RoleState {
  settings: VideoSendSettings | null;
  sender: RTCRtpSender | null;
  state: VideoPlanState;
  written: string | null;
  chain: Promise<void>;
}

/** framesEncoded on the outbound-rtp for this mid, or null when the stats don't say. */
async function framesEncoded(pc: RTCPeerConnection, mid: string | null): Promise<number | null> {
  if (mid === null) return null;
  try {
    const stats = await pc.getStats();
    let frames: number | null = null;
    stats.forEach((report: { type?: string; mid?: string; framesEncoded?: number }) => {
      if (report.type === "outbound-rtp" && report.mid === mid && typeof report.framesEncoded === "number") {
        frames = report.framesEncoded;
      }
    });
    return frames;
  } catch {
    return null;
  }
}

/**
 * The one writer of the camera's and the share's encodings. It merges the embedder's settings
 * with what viewers want, one setParameters at a time per sender.
 */
export function createVideoSendController(
  getPc: () => RTCPeerConnection | null,
  getSender: (role: VideoRole) => RTCRtpSender | null,
) {
  const fresh = (): RoleState => ({
    settings: null, sender: null, state: INITIAL_PLAN_STATE, written: null, chain: Promise.resolve(),
  });
  const roles: Record<VideoRole, RoleState> = { camera: fresh(), screen: fresh() };
  const wanted = new Map<string, VideoWanted>();
  let wantedFor: RTCPeerConnection | null = null;

  const apply = async (role: VideoRole) => {
    const r = roles[role];
    const pc = getPc();
    const sender = getSender(role);
    const track = sender?.track;
    if (!pc || !sender || !track || track.kind !== "video" || !r.settings) return;
    if (sender !== r.sender) {
      r.sender = sender;
      r.state = INITIAL_PLAN_STATE;
      r.written = null;
    }

    const mid = pc.getTransceivers().find((t) => t.sender === sender)?.mid ?? null;
    const demand = pc === wantedFor && mid !== null ? wanted.get(mid) ?? null : null;
    const size = track.getSettings?.() ?? {};
    const source = size.width && size.height
      ? { width: size.width, height: size.height, frameRate: size.frameRate }
      : null;
    const frames = r.state.paused || r.state.resume ? await framesEncoded(pc, mid) : null;
    const plan = planVideoEncoding(
      { role, source, settings: r.settings, wanted: demand, now: Date.now(), framesEncoded: frames },
      r.state,
    );
    r.state = plan.state;

    const params = sender.getParameters();
    const enc = params.encodings?.[0] as EncodingWithDownTo | undefined;
    if (!enc) return;
    const settings = r.settings;
    if (settings.degradationPreference) params.degradationPreference = settings.degradationPreference;
    if (settings.priority) enc.priority = settings.priority;
    if (settings.scalabilityMode) enc.scalabilityMode = settings.scalabilityMode;
    enc.active = plan.active;
    enc.scaleResolutionDownBy = plan.scaleResolutionDownBy;
    delete enc.scaleResolutionDownTo;
    if (plan.maxBitrate !== undefined) enc.maxBitrate = plan.maxBitrate;
    else delete enc.maxBitrate;
    if (plan.maxFramerate !== undefined) enc.maxFramerate = plan.maxFramerate;
    else delete enc.maxFramerate;

    const key = JSON.stringify([params.degradationPreference, enc]);
    if (key !== r.written) {
      voiceLog.info(role === "camera" ? "CAMERA" : "SCREEN", `encoding: active=${enc.active} scale=${enc.scaleResolutionDownBy} maxBitrate=${enc.maxBitrate ?? "none"} maxFramerate=${enc.maxFramerate ?? "none"} wanted=${demand ? `${demand.width}x${demand.height}@${demand.fps} watchers=${demand.watchers} unknown=${demand.unknown}` : "not said"}`);
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

  const schedule = (role: VideoRole) => {
    const r = roles[role];
    r.chain = r.chain.then(() => apply(role)).catch((err: unknown) => {
      r.written = null;
      voiceLog.warn(role === "camera" ? "CAMERA" : "SCREEN", `setParameters failed: ${err}`);
    });
  };
  const both = () => {
    schedule("camera");
    schedule("screen");
  };

  return {
    /** The embedder's settings for one role, or null once that stream has stopped. */
    setSettings(role: VideoRole, settings: VideoSendSettings | null) {
      roles[role].settings = settings;
      schedule(role);
    },
    onWanted(update: VideoWanted & { mid: string }) {
      const pc = getPc();
      if (pc !== wantedFor) {
        wanted.clear();
        wantedFor = pc;
      }
      const { mid, ...rest } = update;
      wanted.set(mid, rest);
      both();
    },
    /** Once a second while connected, for the holds, the pause and the resume check. */
    tick: both,
  };
}
