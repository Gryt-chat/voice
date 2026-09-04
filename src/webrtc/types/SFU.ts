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
   * Why the connection ended, when the engine has something to say.
   *
   * "reconnect-failed" means it retried and gave up. Null covers everything
   * else, including an ordinary hang-up — DISCONNECTED alone cannot tell those
   * apart, which left an embedder unable to say "the call dropped" without
   * guessing.
   */
  connectionError: string | null;
  isConnecting: boolean;
  getPeerConnection?: () => RTCPeerConnection | null;
  getScreenSenderTrackId?: () => string | null;
  getCameraSenderTrackId?: () => string | null;
  getScreenVideoSender?: () => RTCRtpSender | null;
  activeSfuUrl?: string | null;
  /* Zero means never (SFU_CALL_ALONE_TIMEOUT=0). Null means not in a call, or
     an SFU older than GRYT-715 that did not say. Reported, not acted on — the
     engine never leaves a call on its own. */
  callAloneTimeoutSeconds?: number | null;
  /**
   * Tell the SFU somebody is still in this call, restarting its clock.
   *
   * Does nothing when there is no open connection, and nothing an SFU older
   * than GRYT-715 will act on.
   */
  stillHere?: () => void;
}
