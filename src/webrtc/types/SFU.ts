import type { VideoDemand, VideoRole, VideoSendSettings } from "../hooks/videoDemand";

export interface Streams {
  [id: string]: StreamData;
}

export interface StreamData {
  stream: MediaStream;
  isLocal: boolean;
  kind?: "audio" | "video";
}

export type VideoStreams = Record<string, MediaStream>;

export type StreamSources = {
  [id: string]: {
    gain: GainNode;
    analyser: AnalyserNode;
    stream: MediaStreamAudioSourceNode | MediaElementAudioSourceNode;
    audioElement?: HTMLAudioElement;
  };
};

// Connection states for SFU
export enum SFUConnectionState {
  DISCONNECTED = 'disconnected',
  REQUESTING_ACCESS = 'requesting_access',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  FAILED = 'failed',
}

export interface SFUInterface {
  streams: Streams;
  error: string | null;
  streamSources: StreamSources;
  videoStreams: VideoStreams;
  connect: (channelID: string, channelEsportsMode?: boolean, channelMaxBitrate?: number | null) => Promise<void>;
  disconnect: (onDisconnect?: () => void) => Promise<void>;
  /* One sender per role and connection: remove pauses it and add resumes it. It keeps sending under
     the first stream it was given, so that stream's id is the one to announce. */
  addVideoTrack: (track: MediaStreamTrack, stream: MediaStream, preferredCodec?: string) => void;
  removeVideoTrack: () => void;
  /** `index` is which shared window: 0, the default, is the first; later ones ask the SFU for a slot (GRYT-1905). */
  addScreenVideoTrack: (track: MediaStreamTrack, stream: MediaStream, preferredCodec?: string, index?: number) => void;
  removeScreenVideoTrack: (index?: number) => void;
  addScreenAudioTrack: (track: MediaStreamTrack, stream: MediaStream, index?: number) => void;
  removeScreenAudioTrack: (index?: number) => void;
  currentServerConnected: string;
  currentChannelConnected: string;
  isConnected: boolean;
  connectionState: SFUConnectionState;
  /**
   * Why it ended: "reconnect-failed" when it gave up, a refused room's `reason`, or null for a
   * hang-up, which DISCONNECTED alone cannot separate.
   */
  connectionError: string | null;
  isConnecting: boolean;
  getPeerConnection?: () => RTCPeerConnection | null;
  getScreenSenderTrackId?: () => string | null;
  getCameraSenderTrackId?: () => string | null;
  getScreenVideoSender?: () => RTCRtpSender | null;
  activeSfuUrl?: string | null;
  /* Zero means never (SFU_CALL_ALONE_TIMEOUT=0). Null means not in a call, or an SFU older
     than GRYT-715. Reported, not acted on — the engine never leaves a call on its own. */
  callAloneTimeoutSeconds?: number | null;
  /**
   * Tell the SFU somebody is still in this call, restarting its clock. Does nothing with no
   * open connection, and nothing an SFU older than GRYT-715 will act on.
   */
  stillHere?: () => void;
  /** Leave and rejoin the current call, for a change such as the voice connection that only applies at join. */
  rejoin?: () => Promise<void>;
  /**
   * The embedder's settings for the camera's or the share's encoding. The engine owns the
   * encoding and may send less than these when viewers draw it smaller; null once it stops.
   */
  setVideoSendSettings?: (role: VideoRole, settings: VideoSendSettings | null) => void;
  /**
   * How big this viewer draws a remote stream's video, in device pixels, 0×0 when nobody can
   * see it, or null once it's gone. Keyed by stream id: a receiver's track id can differ from the sender's.
   */
  reportVideoDemand?: (streamId: string, size: VideoDemand | null) => void;
  /** User ids heard speaking over the own voice transport, which has no WebRTC track to watch (GRYT-1830). */
  transportSpeaking?: ReadonlySet<string>;
  /** User ids heard over the own transport while this client is on it too: their WebRTC copy is a duplicate to silence (GRYT-1831). */
  transportUsers?: ReadonlySet<string>;
  /** Per-user volume over the own transport, 1 = as sent, by user id; anyone not named plays at 1 (GRYT-1831). */
  setTransportUserGains?: (gains: ReadonlyMap<string, number>) => void;
  /** Each user's level heard over the own transport, in dBFS (-120 silent), for a halo; the mic's only on the native engine. Null when off the transport. */
  getTransportLevels?: () => { users: ReadonlyMap<string, number>; mic: number; micSpeaking: boolean } | null;
  /** The parts of an own-transport latency estimate this device knows, in ms. Null when off the transport. */
  getTransportLatency?: () => TransportLatency | null;
}

export interface TransportLatency {
  /** One Opus frame, which the sender waits for before it can send. */
  frameMs: number;
  /** This device's capture and playback delays; null where the platform doesn't say. */
  inputMs: number | null;
  outputMs: number | null;
  /** Each user's audio waiting to play here: jitter buffer plus decoded samples. */
  bufferedByUser: ReadonlyMap<string, number>;
  /** The phone's audio session rate, null in a browser. Below 48000 the voice is band-limited. */
  sampleRate: number | null;
  /** Measured round trip to each user through the SFU: a ping out, their pong back, minus how long they held it (GRYT-1836). */
  rttByUser: ReadonlyMap<string, number>;
}
