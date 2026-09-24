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
  addScreenVideoTrack: (track: MediaStreamTrack, stream: MediaStream, preferredCodec?: string) => void;
  removeScreenVideoTrack: () => void;
  addScreenAudioTrack: (track: MediaStreamTrack, stream: MediaStream) => void;
  removeScreenAudioTrack: () => void;
  currentServerConnected: string;
  currentChannelConnected: string;
  isConnected: boolean;
  connectionState: SFUConnectionState;
  /**
   * Why the connection ended, when the engine has something to say. "reconnect-failed" means
   * it gave up; null covers an ordinary hang-up, which DISCONNECTED alone cannot separate.
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
}
