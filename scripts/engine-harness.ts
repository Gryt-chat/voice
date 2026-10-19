// Runs the engine's hooks under a real React renderer, on a virtual clock, against a fake
// phone platform, SFU socket and signalling server. Checks drive the code, not its text.

import { act, type ComponentType, createElement, type ReactNode } from "react";
import TestRenderer, { type ReactTestRenderer } from "react-test-renderer";

// Opts out of the renderer's deprecation warning; `unstable_isConcurrent` keeps createRoot.
Object.assign(globalThis, { IS_REACT_NATIVE_TEST_ENVIRONMENT: true, IS_REACT_ACT_ENVIRONMENT: true });

// The engine logs every step. Errors are kept so a check can look at them.
export const log = console.log.bind(console);
export const consoleErrors: string[] = [];
console.log = () => {};
console.info = () => {};
console.debug = () => {};
console.warn = () => {};
console.error = (...args) => consoleErrors.push(args.map(String).join(" "));

// ── Virtual clock ────────────────────────────────────────────────────────────

const timers = new Map<number, { run: () => void; at: number; every: number }>();
let now = 0;
let nextTimerId = 1;

Object.assign(globalThis, {
  setTimeout: <A extends unknown[]>(fn: (...args: A) => void, ms = 0, ...args: A) => {
    const id = nextTimerId++;
    timers.set(id, { run: () => fn(...args), at: now + Math.max(0, Number(ms) || 0), every: 0 });
    return id;
  },
  setInterval: <A extends unknown[]>(fn: (...args: A) => void, ms = 0, ...args: A) => {
    const id = nextTimerId++;
    const every = Math.max(1, Number(ms) || 0);
    timers.set(id, { run: () => fn(...args), at: now + every, every });
    return id;
  },
  clearTimeout: (id: number) => timers.delete(id),
  clearInterval: (id: number) => timers.delete(id),
});

/** Runs `fn`, then lets every promise, render and effect it started finish. */
export async function settle(fn = () => {}) {
  await act(async () => {
    fn();
  });
}

/** Moves the clock, firing each timer in order and settling after every one. */
export async function advance(ms: number) {
  const end = now + ms;
  await settle();
  for (;;) {
    let due: { id: number; timer: { run: () => void; at: number; every: number } } | null = null;
    for (const [id, timer] of timers) {
      if (timer.at <= end && (!due || timer.at < due.timer.at)) due = { id, timer };
    }
    if (!due) break;

    now = due.timer.at;
    if (due.timer.every) due.timer.at = now + due.timer.every;
    else timers.delete(due.id);
    await settle(due.timer.run);
  }
  now = end;
}

// ── What the engine reaches for outside itself ───────────────────────────────

Object.defineProperty(globalThis.navigator, "mediaDevices", {
  configurable: true,
  value: {
    enumerateDevices: () => Promise.resolve([]),
    addEventListener() {},
    removeEventListener() {},
  },
});

/** The m-lines the SFU opens for every client in `peer.go`: microphone, camera, screen, screen audio. */
export const SFU_SLOTS = ["audio", "video", "video", "audio"];

/** An offer shaped like the SFU's: its receive slots, then one sendonly m-line per forwarded track. */
export function sfuOffer(forwarded: string[] = []): Description {
  const lines = ["v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=-", "t=0 0"];
  [...SFU_SLOTS.map((kind) => [kind, "recvonly"]), ...forwarded.map((kind) => [kind, "sendonly"])].forEach(
    ([kind, direction], mid) => lines.push(`m=${kind} 9 UDP/TLS/RTP/SAVPF 96`, `a=mid:${mid}`, `a=${direction}`),
  );
  return { type: "offer", sdp: `${lines.join("\r\n")}\r\n` };
}

/** What goes over the SFU socket, both ways: an event name and its JSON payload. */
export interface SocketMessage {
  event: string;
  data: string;
}


/**
 * The SFU's WebSocket. It answers `client_join` with `room_joined` and an offer, and every
 * `renegotiate` with a new one, unless `hold` is set, which queues them for `release`.
 */
export class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];

  url: string;
  readyState: number;
  sent: SocketMessage[];
  answers: Description[];
  forwarded: string[];
  hold: boolean;
  held: number;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string; wasClean: boolean }) => void;

  constructor(url: string) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    this.answers = [];
    this.forwarded = [];
    this.hold = false;
    this.held = 0;
    FakeSocket.all.push(this);

    queueMicrotask(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }

  deliver(event: string, data: object) {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ event, data: JSON.stringify(data) }) }));
  }

  offer() {
    this.deliver("offer", sfuOffer(this.forwarded));
  }

  /** Sends the offers `hold` kept back, as one, the way the SFU coalesces them. */
  release() {
    this.hold = false;
    if (this.held > 0) this.offer();
    this.held = 0;
  }

  send(text: string) {
    const message: SocketMessage = JSON.parse(text);
    this.sent.push(message);
    if (message.event === "answer") this.answers.push(JSON.parse(message.data));
    if (message.event === "renegotiate") {
      if (this.hold) this.held += 1;
      else this.offer();
    }
    if (message.event !== "client_join") return;
    this.deliver("room_joined", { call_alone_timeout_seconds: 0 });
    this.offer();
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  /** The SFU going away mid-call. */
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "", wasClean: false });
  }
}

Object.assign(globalThis, { WebSocket: FakeSocket });

if (!("RTCSessionDescription" in globalThis)) {
  Object.assign(globalThis, {
    RTCSessionDescription: class {
      type: string;
      sdp: string;
      constructor({ type, sdp }: Description) {
        this.type = type;
        this.sdp = sdp;
      }
    },
  });
}
if (!("RTCIceCandidate" in globalThis)) {
  Object.assign(globalThis, {
    RTCIceCandidate: class {
      constructor(init: object) {
        Object.assign(this, init);
      }
    },
  });
}

/** An SDP offer or answer. */
export interface Description {
  type: string;
  sdp: string;
}

function parseSections(sdp: string) {
  return sdp.split(/\r?\nm=/).slice(1).map((section) => ({
    kind: section.slice(0, section.indexOf(" ")),
    mid: /\na=mid:(\S+)/.exec(section)?.[1] ?? null,
    direction: /\na=(sendrecv|sendonly|recvonly|inactive)\b/.exec(section)?.[1] ?? "sendrecv",
  }));
}

const sends = (direction: string) => direction === "sendrecv" || direction === "sendonly";
const receives = (direction: string) => direction === "sendrecv" || direction === "recvonly";
function directionOf(send: boolean, receive: boolean) {
  if (send) return receive ? "sendrecv" : "sendonly";
  return receive ? "recvonly" : "inactive";
}

export type FakeTrack = ReturnType<typeof fakeTrack>;
export type FakeStream = ReturnType<typeof fakeStream>;

export interface FakeSender {
  track: FakeTrack | null;
  streams: FakeStream[];
  kind: string;
  parameters: { encodings: RTCRtpEncodingParameters[] };
  replaces: number;
  getParameters(): { encodings: RTCRtpEncodingParameters[] };
  setParameters(parameters: { encodings: RTCRtpEncodingParameters[] }): Promise<void>;
  replaceTrack(next: FakeTrack | null): Promise<void>;
  setStreams(...next: FakeStream[]): void;
}

export interface FakeTransceiver {
  mid: string | null;
  kind: string;
  direction: string;
  currentDirection: string | null;
  remoteDirection: string | null;
  everSent: boolean;
  byAddTrack: boolean;
  sender: FakeSender;
  receiver: { track: { kind: string }; getParameters(): { codecs: object[] } };
}

/**
 * Answers an offer the way a browser does, so a transceiver the page adds itself stays at
 * mid null and never sends, which is how #67 passed here and failed through the SFU.
 */
export class FakePeerConnection {
  config: object;
  connectionState: string;
  iceConnectionState: string;
  signalingState: string;
  remoteDescription: Description | null;
  localDescription: Description | null;
  transceivers: FakeTransceiver[];
  stats: Map<string, object>;
  statsCalls: number;
  onconnectionstatechange?: () => void;

  constructor(config: object) {
    this.config = config;
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.signalingState = "stable";
    this.remoteDescription = null;
    this.localDescription = null;
    this.transceivers = [];
    this.stats = new Map();
    this.statsCalls = 0;
  }

  /** Keeps what was set and counts replaces, so a check can read both back. */
  newTransceiver(
    kind: string,
    {
      track = null,
      streams = [],
      direction = "sendrecv",
      mid = null,
      byAddTrack = false,
    }: { track?: FakeTrack | null; streams?: FakeStream[]; direction?: string; mid?: string | null; byAddTrack?: boolean } = {},
  ) {
    const sender: FakeSender = {
      track,
      streams,
      kind,
      parameters: { encodings: [{}] },
      replaces: 0,
      getParameters: () => structuredClone(sender.parameters),
      setParameters: (parameters) => {
        sender.parameters = structuredClone(parameters);
        return Promise.resolve();
      },
      replaceTrack: (next) => {
        sender.replaces += 1;
        sender.track = next;
        return Promise.resolve();
      },
      setStreams: (...next) => {
        sender.streams = next;
      },
    };
    const transceiver: FakeTransceiver = {
      mid,
      kind,
      direction,
      currentDirection: null,
      remoteDirection: null,
      everSent: false,
      byAddTrack,
      sender,
      receiver: { track: { kind }, getParameters: () => ({ codecs: [] }) },
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  /** The spec's reuse rule: a transceiver of this kind with no track that has never sent. */
  addTrack(track: FakeTrack, stream?: FakeStream) {
    const free = this.transceivers.find(
      (t) => t.kind === track.kind && t.direction !== "stopped" && t.sender.track === null && !t.everSent,
    );
    if (free) {
      free.sender.track = track;
      free.sender.streams = stream ? [stream] : [];
      if (free.direction === "recvonly") free.direction = "sendrecv";
      if (free.direction === "inactive") free.direction = "sendonly";
      return free.sender;
    }
    return this.newTransceiver(track.kind, { track, streams: stream ? [stream] : [], byAddTrack: true }).sender;
  }

  addTransceiver(trackOrKind: FakeTrack | string, init: { streams?: FakeStream[]; direction?: string } = {}) {
    const track = typeof trackOrKind === "string" ? null : trackOrKind;
    const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
    return this.newTransceiver(kind, { track, streams: init.streams ?? [], direction: init.direction ?? "sendrecv" });
  }

  removeTrack(sender: FakeSender) {
    const transceiver = this.transceivers.find((t) => t.sender === sender);
    if (!transceiver) return;
    sender.track = null;
    transceiver.direction = directionOf(false, receives(transceiver.direction));
  }

  /** Every sender whose transceiver is not stopped, a removed one included, as in a browser. */
  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }

  get senders() {
    return this.getSenders();
  }

  getTransceivers() {
    return this.transceivers;
  }

  setRemoteDescription(description: Description) {
    for (const section of parseSections(description.sdp)) {
      let transceiver = this.transceivers.find((t) => t.mid === section.mid);
      transceiver ??= this.transceivers.find((t) => t.mid === null && t.byAddTrack && t.kind === section.kind);
      transceiver ??= this.newTransceiver(section.kind, { direction: "recvonly" });
      transceiver.mid = section.mid;
      transceiver.remoteDirection = section.direction;
    }
    this.remoteDescription = description;
    this.signalingState = "have-remote-offer";
    return Promise.resolve();
  }

  createAnswer(): Promise<Description> {
    if (!this.remoteDescription) throw new Error("createAnswer before setRemoteDescription");
    const lines = ["v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=-", "t=0 0"];
    for (const section of parseSections(this.remoteDescription.sdp)) {
      const t = this.transceivers.find((candidate) => candidate.mid === section.mid);
      if (!t) throw new Error(`no transceiver for mid ${section.mid}`);
      const direction = directionOf(
        sends(t.direction) && receives(section.direction),
        receives(t.direction) && sends(section.direction),
      );
      lines.push(`m=${section.kind} 9 UDP/TLS/RTP/SAVPF 96`, `a=mid:${section.mid}`, `a=${direction}`);
      if (sends(direction)) lines.push(`a=msid:${t.sender.streams[0]?.id ?? "-"} ${t.sender.track?.id ?? "-"}`);
    }
    return Promise.resolve({ type: "answer", sdp: `${lines.join("\r\n")}\r\n` });
  }

  setLocalDescription(description: Description) {
    for (const section of parseSections(description.sdp)) {
      const t = this.transceivers.find((candidate) => candidate.mid === section.mid);
      if (!t) throw new Error(`no transceiver for mid ${section.mid}`);
      t.currentDirection = section.direction;
      if (sends(section.direction)) t.everSent = true;
    }
    this.localDescription = description;
    this.signalingState = "stable";
    return Promise.resolve();
  }

  addIceCandidate() {
    return Promise.resolve();
  }

  createDataChannel() {
    return {};
  }

  restartIce() {}

  getStats() {
    this.statsCalls += 1;
    return Promise.resolve(this.stats);
  }

  close() {
    this.connectionState = "closed";
    this.signalingState = "closed";
  }

  /** ICE and DTLS finishing, or failing, as the engine sees it. */
  reach(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

/** What the last answer says each mid carries: its direction and, when sending, its stream id. */
export function answered(socket: FakeSocket) {
  const answer = socket.answers.at(-1);
  if (!answer) return [];
  return answer.sdp.split(/\r?\nm=/).slice(1).map((section) => ({
    kind: section.slice(0, section.indexOf(" ")),
    mid: /\na=mid:(\S+)/.exec(section)?.[1],
    direction: /\na=(sendrecv|sendonly|recvonly|inactive)\b/.exec(section)?.[1],
    stream: /\na=msid:(\S+)/.exec(section)?.[1] ?? null,
    track: /\na=msid:\S+ (\S+)/.exec(section)?.[1] ?? null,
  }));
}

let nextTrackId = 1;

export function fakeTrack(kind = "audio", deviceId = "default") {
  return {
    id: `${kind}-${nextTrackId++}`,
    kind,
    label: deviceId,
    enabled: true,
    muted: false,
    readyState: "live",
    stop() {
      this.readyState = "ended";
    },
    getSettings: () => ({ deviceId }),
  };
}

export function fakeStream(track: FakeTrack) {
  return {
    id: `stream-${track.id}`,
    active: true,
    track,
    getTracks: () => [track],
    getAudioTracks: () => (track.kind === "audio" ? [track] : []),
    getVideoTracks: () => (track.kind === "video" ? [track] : []),
  };
}

/** A microphone request the harness can answer by hand when `microphone.manual` is set. */
export interface MicrophoneRequest {
  deviceId?: string;
  stream: FakeStream | null;
  resolve: () => void;
  reject: (error: Error) => void;
}


/**
 * Shaped like `nativePlatform`: it builds its own audio pipeline and has no screen capture.
 * Microphone requests answer at once unless `microphone.manual` is set.
 */
export function fakePhonePlatform() {
  const microphone: { manual: boolean; requests: MicrophoneRequest[] } = { manual: false, requests: [] };
  const peers: FakePeerConnection[] = [];

  return {
    microphone,
    peers,
    name: "react-native",
    createPeerConnection(config: object) {
      const pc = new FakePeerConnection(config);
      peers.push(pc);
      return pc;
    },
    getMicrophone(deviceId?: string) {
      const { promise, resolve, reject } = Promise.withResolvers<FakeStream>();
      const request: MicrophoneRequest = {
        deviceId,
        stream: null,
        resolve: () => {
          const stream = fakeStream(fakeTrack("audio", deviceId ?? "default"));
          request.stream = stream;
          resolve(stream);
        },
        reject,
      };
      microphone.requests.push(request);
      if (!microphone.manual) request.resolve();
      return promise;
    },
    getCamera() {
      return Promise.reject(new Error("No camera in this harness"));
    },
    createAudioPipeline({ source }: { source: FakeStream }) {
      return {
        output: source,
        getLevel: () => null,
        setGain() {},
        setMuted() {},
        destroy() {},
      };
    },
  };
}

/** One server's signalling, as the engine sees it through RoomCoordinator. */
export function fakeRoom(id: string) {
  const listeners = new Set<() => void>();
  const refusal: { reason: string; retryAfterMs?: number } = { reason: "refused by the fake", retryAfterMs: 2000 };
  const room = {
    id,
    connected: true,
    refusals: 0,
    // A refusal with retryAfterMs is one the engine asks again after; without, it stops.
    refusal,
    requests: [] as string[],
    joined: [] as object[],
    requestAccess(channelId: string) {
      room.requests.push(channelId);
      if (room.refusals > 0) {
        room.refusals -= 1;
        return Promise.resolve({ granted: false, ...room.refusal });
      }
      return Promise.resolve({
        granted: true,
        roomId: channelId,
        sfuUrls: [`ws://sfu.${id}.test`],
        joinToken: { room_id: channelId },
        cacheKey: id,
      });
    },
    leave() {},
    announceJoined(joined: object) {
      room.joined.push(joined);
    },
    setLocalStream() {},
    peerChanged() {},
    onReconnected(handler: () => void) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    /** Signalling back after a drop, which is when the embedder calls these handlers. */
    reconnect() {
      room.connected = true;
      for (const handler of [...listeners]) handler();
    },
    get listening() {
      return listeners.size;
    },
  };
  return room;
}

export function voiceConfig({ stunHosts = [], deviceId }: { stunHosts?: string[]; deviceId?: string } = {}) {
  return {
    audio: {
      deviceId,
      muted: false,
      serverMuted: false,
      deafened: false,
      serverDeafened: false,
      outputVolume: 1,
      inputMode: "voice_activity",
      volume: 1,
      loopback: false,
      noiseSuppression: false,
      noiseGate: 0,
      noiseGateRelease: 0,
      autoGain: { enabled: false, targetDb: -20 },
      compressorEnabled: false,
      compressorAmount: 0,
    },
    camera: { quality: "720p", fps: 30, mirrored: false },
    screen: { quality: "1080p", fps: 30, gamingMode: false },
    connection: { stunHosts, eSportsMode: false },
  };
}

/**
 * Mounts the engine the way an app does: a provider, the singleton runner, and a probe
 * that stores what `read(probe)` returns. `update` changes any of the three props.
 */
export async function mountEngine<Config, Target, P, R>({
  provider,
  runner,
  read,
  config,
  target,
  probe,
}: {
  provider: ComponentType<{ config: Config; target: Target; children?: ReactNode }>;
  runner: ComponentType;
  read: (probe: P) => R;
  config: Config;
  target: Target;
  probe: P;
}) {
  const seen: { current: R | null } = { current: null };
  let props = { config, target, probe };

  function Probe({ probe: value }: { probe: P }) {
    seen.current = read(value);
    return null;
  }

  const tree = () =>
    createElement(
      provider,
      { config: props.config, target: props.target },
      createElement(runner),
      createElement(Probe, { probe: props.probe }),
    );

  const mounted: { renderer?: ReactTestRenderer } = {};
  await settle(() => {
    mounted.renderer = TestRenderer.create(tree(), { unstable_isConcurrent: true });
  });

  return {
    get current() {
      return seen.current;
    },
    async update(next: Partial<typeof props>) {
      props = { ...props, ...next };
      await settle(() => mounted.renderer?.update(tree()));
    },
    // Drops leftover timers too, so nothing from one scenario runs in the next.
    async unmount() {
      await settle(() => mounted.renderer?.unmount());
      timers.clear();
    },
  };
}
