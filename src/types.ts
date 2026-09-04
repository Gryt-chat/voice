/* The three seams where the engine has to ask whatever embeds it. Everything
   else — signalling, ICE, tracks, connection state — is the same anywhere. */

// ── 1. Config ────────────────────────────────────────────────────────────────

/* One type, not two. The client's `CameraQuality` and `ScreenShareQuality` had
   identical members, and two lists that must stay equal stop being equal. */
export type CaptureQuality =
  | "native" | "4k" | "1440p" | "1080p" | "720p" | "480p" | "360p" | "240p"
  | "144p" | "96p" | "64p" | "48p" | "32p" | "24p" | "16p" | "8p" | "4p";

export type CameraFps = 5 | 10 | 15 | 24 | 30 | 60;

/** Higher than the camera's, because a screen share of a game wants them. */
export type ScreenShareFps = 30 | 60 | 90 | 120 | 144 | 165 | 240;

/* Passed in, never read from a store. That is what makes it testable without a
   React tree. */
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
    /* Underscores. An embedder typing this as a plain string can pass
       "push-to-talk", compile on both sides, and have push-to-talk silently
       never engage. That shipped once (GRYT-340). */
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
    /* Given, not looked up. The engine is deliberately not told which server
       is on screen, so it cannot do the lookup itself. */
    stunHosts: string[];
    /** Lower latency, fewer niceties. */
    eSportsMode: boolean;
    maxBitrate?: number | null;
  };
}

// ── 2. Transport ─────────────────────────────────────────────────────────────

/* Generic WebRTC: offer, answer, candidate, keep-alive. The package owns the
   messages, the caller owns the socket. */
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
  | { event: "keep_alive"; data: string }
  | { event: "still_here"; data: string };

export type SfuInbound =
  | { event: "room_joined"; data: string }
  | { event: "offer"; data: string }
  | { event: "answer"; data: string }
  | { event: "candidate"; data: string };

/* Gryt's rules rather than WebRTC's: who may enter a channel, and capacity.
   The package asks; something else answers. */
export interface RoomCoordinator {
  requestAccess(channelId: string): Promise<RoomAccess>;
  /** Mirrors `voice:room:leave`, which carries nothing. */
  leave(): void;
  /** Mirrors `voice:channel:joined`. False on the way out. */
  announceJoined(joined: boolean): void;
  /* A stream id, not a description of what is published. The server matches
     the id and does not care whether it is a camera or a screen. Null clears. */
  setLocalStream(streamId: string | null): void;
  /* Mirrors `voice:peer:connected` / `voice:peer:disconnected`. */
  peerChanged(streamId: string, present: boolean): void;

  /* The reconnect policy needs this: retrying the SFU while signalling is down
     burns attempts against something that cannot answer. */
  readonly connected: boolean;

  /* Fires when signalling comes back. A callback rather than a window event,
     which React Native does not have. */
  onReconnected(handler: () => void): () => void;
}

export interface RoomAccess {
  granted: boolean;
  roomId?: string;
  /* Candidates, not an answer. `selectBestSfuUrl` probes and picks; handing
     over one chosen URL would move that into every embedder. */
  sfuUrls?: string[];
  /** Opaque; the engine forwards it to the SFU and does not read it. */
  joinToken?: unknown;
  /* Opaque to the engine. The Gryt client passes the server's host. */
  cacheKey?: string;
  /** Populated when refused, so the caller can say why rather than "failed". */
  reason?: string;
  retryAfterMs?: number;
}

// ── 3. Platform ──────────────────────────────────────────────────────────────

/* Capture, playback and peer construction. Deliberately narrow — everything
   that is not one of those is shared, so additions here want a second look. */
export interface VoicePlatform {
  /** For logs and for the one or two places behaviour genuinely differs. */
  readonly name: string;

  createPeerConnection(config: RTCConfiguration): RTCPeerConnection;

  /* One attempt, deliberately. Falling back to the default when the stored
     device has gone is the engine's decision, made by calling this again with
     no id. */
  getMicrophone(deviceId?: string): Promise<MediaStream>;
  getCamera(constraints: CameraConstraints): Promise<MediaStream>;
  /** Undefined where the platform has no such concept, which is phones. */
  getScreen?(constraints: ScreenConstraints): Promise<MediaStream>;

  /* Undefined on React Native — the phone has already denoised in libwebrtc.
     It is a seam because `RNNoiseProcessor` builds its worker with
     `new Worker(new URL(...))`, which Metro follows into a package this one
     does not ship. It is the only bundler-visible web-only reference here, so
     moving it behind the seam is what lets React Native import the hooks. */
  createNoiseSuppressor?(): NoiseSuppressor;

  /* Undefined means the Web Audio pipeline, which browsers and Electron get.
     The web graph is not standalone — it hands out AudioNodes the client's
     meters, visualiser and gate read directly — so returning an AudioPipeline
     here would drop that surface or duplicate it. Native supplies one. */
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


/* The caller's requirement rather than the class's shape, so a platform can
   satisfy it with something that is not RNNoise. */
export interface NoiseSuppressor {
  initialize(audioContext: AudioContext): Promise<void>;
  setEnabled(enabled: boolean): void;
  /** Null until `initialize` resolves, and after `destroy`. */
  getNode(): AudioWorkletNode | null;
  destroy(): void;
}

export interface AudioPipelineOptions {
  /** The capture stream to process. */
  source: MediaStream;
  noiseSuppression: boolean;
  compressorAmount: number;
  /** Ignored where the platform has no equivalent. */
  gain?: number;
}

export interface AudioPipeline {
  /* A stream, not a track — that is what consumers want. The track is
     `output.getAudioTracks()[0]` for anything that needs it. */
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
