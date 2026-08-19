// The connection half, all of it. The only thing from the client's webRTC tree
// that has not come across is encodedTransformWorker, which is browser-specific
// and belongs with the web adapter, and the four .tsx components, which are UI.
export { performSfuCleanup, performUnmountCleanup } from "./hooks/sfuCleanup";
export type { CleanupRefs } from "./hooks/sfuCleanup";
export { connectToSfuWebSocket } from "./hooks/sfuConnection";
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
export { type Phase, voiceLog } from "./hooks/voiceLogger";
export {
  SFUConnectionState,
  type SFUInterface,
  type Streams,
  type StreamSources,
  type VideoStreams,
} from "./types/SFU";
