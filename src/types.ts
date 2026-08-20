/**
 * The three things this package cannot know for itself.
 *
 * Everything else in here — signalling, ICE, track management, the connection
 * state machine — is the same wherever it runs. These are the seams where it
 * has to ask the thing embedding it.
 *
 * Without them the engine would reach for a settings store, a socket and an
 * Electron bridge directly, and be a package that only works inside Gryt's
 * desktop client.
 */

// ── 1. Config ────────────────────────────────────────────────────────────────

/**
 * Capture resolutions.
 *
 * The client declares this list twice, as `CameraQuality` and
 * `ScreenShareQuality`, with identical members. They are one type here because
 * two copies that must stay equal is how they eventually stop being equal.
 * Both names are still exported from the hooks that used to own them.
 */
export type CaptureQuality =
  | "native" | "4k" | "1440p" | "1080p" | "720p" | "480p" | "360p" | "240p"
  | "144p" | "96p" | "64p" | "48p" | "32p" | "24p" | "16p" | "8p" | "4p";

export type CameraFps = 5 | 10 | 15 | 24 | 30 | 60;

/** Higher than the camera's, because a screen share of a game wants them. */
export type ScreenShareFps = 30 | 60 | 90 | 120 | 144 | 165 | 240;

/**
 * What the person has chosen. Passed in, never read from a store.
 *
 * The client holds these in `useSettings` today and will keep doing so; it
 * hands the relevant subset down rather than the package reaching up for it.
 * That is also what makes the values testable without a React tree.
 */
export interface VoiceConfig {
  audio: {
    /** Empty means "whatever the platform hands back". */
    deviceId?: string;
    muted: boolean;
    /** Set by a moderator, not by the person. Distinct from `muted` on purpose. */
    serverMuted: boolean;
    deafened: boolean;
    serverDeafened: boolean;
    /** Playback gain for everyone else, 0–1. */
    outputVolume: number;
    /**
     * Underscores, matching what `microphonePipeline` compares against.
     *
     * Worth checking in whatever fills this in. An embedder whose own settings
     * type this as a plain string can hand over "push-to-talk", compile on both
     * sides, and only meet this at runtime — where `inputMode !== "push_to_talk"`
     * is always true and push-to-talk never engages. That is how it shipped
     * wrong once (GRYT-340).
     */
    inputMode: "voice_activity" | "push_to_talk";
    /** How loud the captured signal is sent, 0–1. */
    volume: number;
    /** Play the microphone back locally, for testing it. */
    loopback: boolean;
    /** Off on native: the platform does its own noise suppression. */
    noiseSuppression: boolean;
    /** Threshold in dB. 0 disables gating, which push-to-talk relies on. */
    noiseGate: number;
    /** How long the gate stays open after the signal drops, in ms. */
    noiseGateRelease: number;
    autoGain: {
      enabled: boolean;
      targetDb: number;
    };
    compressorEnabled: boolean;
    compressorAmount: number;
  };

  camera: {
    deviceId?: string;
    quality: CaptureQuality;
    fps: CameraFps;
    codec?: string;
    mirrored: boolean;
  };

  screen: {
    quality: CaptureQuality;
    fps: ScreenShareFps;
    codec?: string;
    /** Prefers framerate over resolution. */
    gamingMode: boolean;
  };

  connection: {
    /**
     * STUN servers to gather candidates against.
     *
     * The client derives these from whichever server is on screen, through
     * `serverDetailsList[host].stun_hosts`. The engine is not told which server
     * that is — knowing about a server list, and which of it is being looked
     * at, is the one thing the engine is deliberately kept out of — so it gets
     * the answer rather than the lookup.
     */
    stunHosts: string[];
    /** Lower latency, fewer niceties. */
    eSportsMode: boolean;
    maxBitrate?: number | null;
  };
}

// ── 2. Transport ─────────────────────────────────────────────────────────────

/**
 * Signalling with the SFU.
 *
 * This half is generic WebRTC: offer, answer, candidate, and a keep-alive. The
 * package owns the meaning of these messages and the caller owns the socket, so
 * a different embedder can carry them over anything it likes.
 */
export interface SfuTransport {
  send(message: SfuOutbound): void;
  onMessage(handler: (message: SfuInbound) => void): () => void;
  readonly ready: boolean;
  close(): void;
}

export type SfuOutbound =
  | { event: "client_join"; data: string }
  | { event: "offer"; data: string }
  | { event: "answer"; data: string }
  | { event: "candidate"; data: string }
  | { event: "renegotiate"; data: string }
  | { event: "keep_alive"; data: string };

export type SfuInbound =
  | { event: "room_joined"; data: string }
  | { event: "offer"; data: string }
  | { event: "answer"; data: string }
  | { event: "candidate"; data: string };

/**
 * Room orchestration, which is not generic.
 *
 * Asking permission to join, and telling the server what is being published,
 * are Gryt's rules rather than WebRTC's — the server decides who may enter a
 * channel and what the capacity is. So the package asks, and something else
 * answers. An embedder that is not Gryt supplies its own.
 *
 * The Gryt client satisfies this with the `voice:*` events on its socket.
 */
export interface RoomCoordinator {
  requestAccess(channelId: string): Promise<RoomAccess>;
  /** Mirrors `voice:room:leave`, which carries nothing. */
  leave(): void;
  /** Mirrors `voice:channel:joined`. False on the way out. */
  announceJoined(joined: boolean): void;
  /**
   * Mirrors `voice:stream:set`. Null clears it.
   *
   * A stream id, not a description of what is being published — the server
   * matches the id against what arrives at the SFU, and does not care whether
   * it is a camera or a screen.
   */
  setLocalStream(streamId: string | null): void;
  /**
   * Mirrors `voice:peer:connected` / `voice:peer:disconnected`.
   *
   * The engine is the only thing that can see a remote stream appear or go
   * away, so it says so. What the server does about it is not its business.
   */
  peerChanged(streamId: string, present: boolean): void;

  /**
   * Whether signalling to this target is up right now.
   *
   * The reconnect policy needs it: retrying the SFU while the signalling
   * connection is down burns attempts against something that cannot answer.
   * The client reads its socket; another embedder reads whatever it has.
   */
  readonly connected: boolean;

  /**
   * Fires when signalling comes back after being down.
   *
   * Replaces a `server_socket_reconnected` window event with a `host` in its
   * detail — a DOM event the package had no business listening for, and which
   * React Native does not have.
   */
  onReconnected(handler: () => void): () => void;
}

export interface RoomAccess {
  granted: boolean;
  roomId?: string;
  /**
   * Where the SFU is, as candidates rather than an answer.
   *
   * The server returns these when it grants access, and the engine probes them
   * and picks — that is what `selectBestSfuUrl` is for, and it has been in this
   * package since voice#3. Handing over a single chosen URL instead would
   * either throw that away or move it into every embedder.
   */
  sfuUrls?: string[];
  /** Opaque; the engine forwards it to the SFU and does not read it. */
  joinToken?: unknown;
  /**
   * What to key the chosen-URL cache on, so a reconnect skips the probing.
   *
   * Opaque to the engine. The Gryt client passes the server's host, which is
   * exactly the sort of thing the engine is not supposed to know it is.
   */
  cacheKey?: string;
  /** Populated when refused, so the caller can say why rather than "failed". */
  reason?: string;
  retryAfterMs?: number;
}

// ── 3. Platform ──────────────────────────────────────────────────────────────

/**
 * Capture, playback and peer construction, which differ per platform.
 *
 * The web implementation is getUserMedia and the AudioContext graph. A native
 * one is `react-native-webrtc` plus `react-native-audio-api`.
 *
 * Deliberately narrow: everything that is not capture or playback is shared, so
 * anything added here should be re-examined first.
 */
export interface VoicePlatform {
  /** For logs and for the one or two places behaviour genuinely differs. */
  readonly name: string;

  createPeerConnection(config: RTCConfiguration): RTCPeerConnection;

  /**
   * One attempt at the named device, or at whatever the platform considers
   * default when the id is undefined.
   *
   * Deliberately one attempt. Falling back to the default device when the
   * stored one has gone away is the engine's decision, not the platform's, and
   * it makes that decision by calling this a second time with no id.
   */
  getMicrophone(deviceId?: string): Promise<MediaStream>;
  getCamera(constraints: CameraConstraints): Promise<MediaStream>;
  /** Undefined where the platform has no such concept, which is phones. */
  getScreen?(constraints: ScreenConstraints): Promise<MediaStream>;

  /**
   * The audio graph, where the platform can build one outside React.
   *
   * Undefined means "use the Web Audio pipeline", which is what a browser and
   * Electron get. It is undefined there rather than a web implementation, and
   * that is worth explaining: the web graph is not a standalone object. It
   * hands out the AudioNodes that the client's meters, visualiser, noise gate
   * and microphone test read directly, and a React effect rebuilds it whenever
   * a setting changes. Returning an `AudioPipeline` from here would either drop
   * that surface or grow a second copy of it.
   *
   * Native supplies one, and it is nearly empty on purpose — see
   * `platform/native.ts`.
   */
  createAudioPipeline?(options: AudioPipelineOptions): AudioPipeline;
}

export interface CameraConstraints {
  deviceId?: string;
  width?: number;
  height?: number;
  fps: number;
}

export interface ScreenConstraints {
  width?: number;
  height?: number;
  fps: number;
  withAudio: boolean;
}

/*
 * There was a `listDevices(): Promise<VoiceDevice[]>` here, and a `VoiceDevice`
 * to go with it. Both are gone rather than left declared.
 *
 * Nothing called them. Device enumeration in the engine returns
 * `InputDeviceInfo[]` — the DOM type, straight from `enumerateDevices` — and
 * both `useMicrophone` and `useDeviceEnumeration` hand that to the client,
 * whose settings dropdowns read it. Routing that through a narrower type is a
 * change to the client's surface, and it is the same size of change whether it
 * happens now or later.
 *
 * Leaving the declaration in place until then is the exact thing this file was
 * being fixed for: a seam that typechecks, exports, reads as supported and is
 * wired to nothing. GRYT-387 covers doing it properly, including what a device
 * list should even mean on a phone, where the answer is an audio route.
 */

export interface AudioPipelineOptions {
  /** The capture stream to process. */
  source: MediaStream;
  noiseSuppression: boolean;
  compressorAmount: number;
  /** Ignored where the platform has no equivalent. */
  gain?: number;
}

export interface AudioPipeline {
  /**
   * What gets sent.
   *
   * A stream rather than a track because that is what every consumer of it
   * wants: `sfuConnectFlow` reads `processedStream` off the microphone buffer
   * and hands it to `addTrack`, and the local monitor plays it back. The track
   * is `output.getAudioTracks()[0]` for anything that needs it.
   */
  readonly output: MediaStream;
  /** For the speaking indicator. Null where the platform cannot measure it. */
  getLevel(): number | null;
  setGain(value: number): void;
  setMuted(muted: boolean): void;
  destroy(): void;
}

// ── Putting them together ────────────────────────────────────────────────────

export interface VoiceEngineOptions {
  config: VoiceConfig;
  transport: SfuTransport;
  room: RoomCoordinator;
  platform: VoicePlatform;
  /** The client's `voiceLog`, which is how every hard bug here has been found. */
  log?: VoiceLogger;
}

export interface VoiceLogger {
  info(scope: string, message: string, detail?: unknown): void;
  warn(scope: string, message: string, detail?: unknown): void;
  fail(scope: string, message: string, detail?: unknown): void;
}
