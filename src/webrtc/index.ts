// The connection half. Encoded transforms are browser-specific and belong with
// the web adapter; the call UI belongs to the embedder.
export { performSfuCleanup, performUnmountCleanup } from "./hooks/sfuCleanup";
export type { CleanupRefs } from "./hooks/sfuCleanup";
export { connectToSfuWebSocket, parseRoomJoined } from "./hooks/sfuConnection";
export type { RoomJoinedInfo } from "./hooks/sfuConnection";
export { sfuConnect } from "./hooks/sfuConnectFlow";
export {
  getCachedSfuUrl,
  selectBestSfuUrl,
  warmSfuSelection,
} from "./hooks/selectBestSfuUrl";
export type { SFUConnectionStateInternal } from "./hooks/sfuTypes";
export { useSFU } from "./hooks/useSFU";
export { useSFUStreams } from "./hooks/useSFUStreams";
export {
  type InboundVideoStats,
  type OutboundVideoStats,
  useVideoStats,
} from "./hooks/useVideoStats";
export {
  cameraBitrate,
  parseVideoWanted,
  planVideoEncoding,
  screenBitrate,
  type VideoDemand,
  type VideoEncodingPlan,
  type VideoPlanState,
  type VideoRole,
  type VideoSendSettings,
  type VideoWanted,
} from "./hooks/videoDemand";
export { type Phase, voiceLog } from "./hooks/voiceLogger";
export {
  SFUConnectionState,
  type SFUInterface,
  type Streams,
  type StreamSources,
  type VideoStreams,
} from "./types/SFU";
