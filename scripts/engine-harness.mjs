/* eslint-env node */

// Runs the engine's hooks under a real React renderer, on a virtual clock, against a fake
// phone platform, SFU socket and signalling server. Checks drive the code, not its text.

import { act, createElement } from "react";
import TestRenderer from "react-test-renderer";

// Opts out of the renderer's deprecation warning; `unstable_isConcurrent` keeps createRoot.
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The engine logs every step. Errors are kept so a check can look at them.
export const log = console.log.bind(console);
export const consoleErrors = [];
console.log = () => {};
console.info = () => {};
console.debug = () => {};
console.warn = () => {};
console.error = (...args) => consoleErrors.push(args.map(String).join(" "));

// ── Virtual clock ────────────────────────────────────────────────────────────

const timers = new Map();
let now = 0;
let nextTimerId = 1;

globalThis.setTimeout = (fn, ms = 0, ...args) => {
  const id = nextTimerId++;
  timers.set(id, { fn, args, at: now + Math.max(0, Number(ms) || 0), every: 0 });
  return id;
};
globalThis.setInterval = (fn, ms = 0, ...args) => {
  const id = nextTimerId++;
  const every = Math.max(1, Number(ms) || 0);
  timers.set(id, { fn, args, at: now + every, every });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.clearInterval = (id) => timers.delete(id);

/** Runs `fn`, then lets every promise, render and effect it started finish. */
export async function settle(fn = () => {}) {
  await act(async () => {
    fn();
  });
}

/** Moves the clock, firing each timer in order and settling after every one. */
export async function advance(ms) {
  const end = now + ms;
  await settle();
  for (;;) {
    let due = null;
    for (const [id, timer] of timers) {
      if (timer.at <= end && (!due || timer.at < due.timer.at)) due = { id, timer };
    }
    if (!due) break;

    now = due.timer.at;
    if (due.timer.every) due.timer.at = now + due.timer.every;
    else timers.delete(due.id);
    await settle(() => due.timer.fn(...due.timer.args));
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

/** The SFU's WebSocket. It opens and answers `client_join` with `room_joined`. */
export class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    FakeSocket.all.push(this);

    queueMicrotask(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }

  send(text) {
    const message = JSON.parse(text);
    this.sent.push(message);
    if (message.event !== "client_join") return;
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({
          event: "room_joined",
          data: JSON.stringify({ call_alone_timeout_seconds: 0 }),
        }),
      }),
    );
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

globalThis.WebSocket = FakeSocket;

export class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.signalingState = "stable";
    this.remoteDescription = null;
    this.localDescription = null;
    this.senders = [];
    this.transceivers = [];
    this.stats = new Map();
    this.statsCalls = 0;
  }

  /** Keeps what was set and counts replaces, so a check can read both back. */
  newSender(track, stream) {
    const sender = {
      track,
      stream,
      kind: track.kind,
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
    };
    this.senders.push(sender);
    this.transceivers.push({ sender, receiver: { track: { kind: track.kind } }, direction: "sendrecv" });
    return sender;
  }

  // What the browser does with a sender that has never sent, which is every paused one here:
  // the first of this kind with no track on it is reused instead of a new m-line being made.
  addTrack(track, stream) {
    const free = this.senders.find(
      (sender) => sender.track === null && sender.kind === track.kind,
    );
    if (free) {
      free.track = track;
      free.stream = stream;
      return free;
    }
    return this.newSender(track, stream);
  }

  /** Always its own m-line, which is the point of it over `addTrack`. */
  addTransceiver(track, init) {
    const sender = this.newSender(track, init?.streams?.[0]);
    return this.transceivers.find((transceiver) => transceiver.sender === sender);
  }

  removeTrack(sender) {
    this.senders = this.senders.filter((candidate) => candidate !== sender);
    this.transceivers = this.transceivers.filter((candidate) => candidate.sender !== sender);
  }

  getSenders() {
    return this.senders;
  }

  getTransceivers() {
    return this.transceivers;
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
  reach(state) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
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

export function fakeStream(track) {
  return {
    id: `stream-${track.id}`,
    active: true,
    track,
    getTracks: () => [track],
    getAudioTracks: () => (track.kind === "audio" ? [track] : []),
    getVideoTracks: () => (track.kind === "video" ? [track] : []),
  };
}

/**
 * Shaped like `nativePlatform`: it builds its own audio pipeline and has no screen capture.
 * Microphone requests answer at once unless `microphone.manual` is set.
 */
export function fakePhonePlatform() {
  const microphone = { manual: false, requests: [] };
  const peers = [];

  return {
    microphone,
    peers,
    name: "react-native",
    createPeerConnection(config) {
      const pc = new FakePeerConnection(config);
      peers.push(pc);
      return pc;
    },
    getMicrophone(deviceId) {
      const request = { deviceId, stream: null };
      microphone.requests.push(request);
      const promise = new Promise((resolve, reject) => {
        request.resolve = () => {
          request.stream = fakeStream(fakeTrack("audio", deviceId ?? "default"));
          resolve(request.stream);
        };
        request.reject = reject;
      });
      if (!microphone.manual) request.resolve();
      return promise;
    },
    getCamera() {
      return Promise.reject(new Error("No camera in this harness"));
    },
    createAudioPipeline({ source }) {
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
export function fakeRoom(id) {
  const listeners = new Set();
  const room = {
    id,
    connected: true,
    refusals: 0,
    requests: [],
    joined: [],
    requestAccess(channelId) {
      room.requests.push(channelId);
      if (room.refusals > 0) {
        room.refusals -= 1;
        return Promise.resolve({ granted: false, reason: "refused by the fake" });
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
    announceJoined(joined) {
      room.joined.push(joined);
    },
    setLocalStream() {},
    peerChanged() {},
    onReconnected(handler) {
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

export function voiceConfig({ stunHosts = [], deviceId } = {}) {
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
export async function mountEngine({ provider, runner, read, config, target, probe }) {
  const seen = { current: null };
  let props = { config, target, probe };

  function Probe({ probe: value }) {
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

  let renderer;
  await settle(() => {
    renderer = TestRenderer.create(tree(), { unstable_isConcurrent: true });
  });

  return {
    get current() {
      return seen.current;
    },
    async update(next) {
      props = { ...props, ...next };
      await settle(() => renderer.update(tree()));
    },
    // Drops leftover timers too, so nothing from one scenario runs in the next.
    async unmount() {
      await settle(() => renderer.unmount());
      timers.clear();
    },
  };
}
