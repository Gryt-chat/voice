/**
 * The three things this package cannot know for itself.
 *
 * Everything else in here — signalling, ICE, track management, the connection
 * state machine — is the same wherever it runs. These are the seams where it
 * has to ask the thing embedding it.
 *
 * They exist because the code being extracted currently reaches for them
 * directly: `useSettings` in 10 places, `useSockets` and `useServerManagement`
 * in 4, and `lib/electron` in 7. Moving that as-is would produce a package that
 * only works inside Gryt's desktop client, which is the one outcome worth
 * avoiding.
 */

// ── 1. Config ────────────────────────────────────────────────────────────────

/**
 * What the person has chosen. Passed in, never read from a store.
 *
 * The client holds these in `useSettings` today and will keep doing so; it
 * hands the relevant subset down rather than the package reaching up for it.
 * That is also what makes the values testable without a React tree.
 */
export interface VoiceConfig {
  audio: {
    muted: boolean;
    /** Set by a moderator, not by the person. Distinct from `muted` on purpose. */
    serverMuted: boolean;
    serverDeafened: boolean;
    inputMode: "voice-activity" | "push-to-talk";
    /** Off on native: the platform does its own noise suppression. */
    noiseSuppression: boolean;
    compressorAmount: number;
  };

  camera: {
    deviceId?: string;
    quality: string;
    fps: number;
    codec?: string;
    mirrored: boolean;
  };

  screen: {
    quality: string;
    fps: number;
    codec?: string;
    /** Prefers framerate over resolution. */
    gamingMode: boolean;
  };

  connection: {
    /** Chosen by the caller. Selecting between several is the app's job. */
    sfuUrl: string;
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
 * Mirrors the `voice:*` events the client emits today.
 */
export interface RoomCoordinator {
  requestAccess(channelId: string): Promise<RoomAccess>;
  leave(channelId: string): void;
  announceJoined(channelId: string): void;
  setStreamState(state: { camera?: boolean; screen?: boolean }): void;
  onPeerChange(handler: (peerId: string, present: boolean) => void): () => void;
}

export interface RoomAccess {
  granted: boolean;
  roomId?: string;
  /** Populated when refused, so the caller can say why rather than "failed". */
  reason?: string;
  retryAfterMs?: number;
}

// ── 3. Platform ──────────────────────────────────────────────────────────────

/**
 * Capture, playback and peer construction, which differ per platform.
 *
 * The web implementation is the code moving out of the client. The native one
 * is `react-native-webrtc` plus `react-native-audio-api`.
 *
 * Deliberately narrow: everything that is not capture or playback is shared, so
 * anything added here should be re-examined first.
 */
export interface VoicePlatform {
  createPeerConnection(config: RTCConfiguration): RTCPeerConnection;

  getMicrophone(deviceId?: string): Promise<MediaStream>;
  getCamera(constraints: CameraConstraints): Promise<MediaStream>;
  /** Undefined where the platform has no such concept, which is phones. */
  getScreen?(constraints: ScreenConstraints): Promise<MediaStream>;

  listDevices(): Promise<VoiceDevice[]>;

  /**
   * The audio graph.
   *
   * Web builds this from AudioContext and AudioWorklet. Native uses
   * react-native-audio-api, and skips noise suppression entirely because
   * libwebrtc and the phone already do it.
   */
  createAudioPipeline(options: AudioPipelineOptions): AudioPipeline;
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

export interface VoiceDevice {
  id: string;
  label: string;
  kind: "audioinput" | "audiooutput" | "videoinput";
}

export interface AudioPipelineOptions {
  noiseSuppression: boolean;
  compressorAmount: number;
  /** Ignored where the platform has no equivalent. */
  gain?: number;
}

export interface AudioPipeline {
  readonly output: MediaStreamTrack;
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
