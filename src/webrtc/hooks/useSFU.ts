import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useMicrophone } from "../../audio/hooks/useMicrophone";
import { useSpeakers } from "../../audio/hooks/useSpeakers";
import { useVoiceConfig, useVoiceTarget } from "../../config";
import { singletonHook } from "../../shared/singletonHook";

import { SFUConnectionState, SFUInterface, Streams, StreamSources, VideoStreams } from "../types/SFU";
import { CleanupRefs,performSfuCleanup, performUnmountCleanup } from "./sfuCleanup";
import { sfuConnect } from "./sfuConnectFlow";
import { SFUConnectionStateInternal } from "./sfuTypes";
import { useSFUStreams } from "./useSFUStreams";
import { type Phase, voiceLog } from "./voiceLogger";

function useSfuHook(): SFUInterface {
  // Core WebRTC references
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const sfuWebSocketRef = useRef<WebSocket | null>(null);
  const registeredTracksRef = useRef<RTCRtpSender[]>([]);
  const reconnectAttemptRef = useRef<NodeJS.Timeout | null>(null);
  const previousRemoteStreamsRef = useRef<Set<string>>(new Set());
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isDisconnectingRef = useRef<boolean>(false);
  const isConnectingRef = useRef<boolean>(false);
  const connectSeqRef = useRef<number>(0);

  // State management
  const [connectionState, setConnectionState] = useState<SFUConnectionStateInternal>({
    state: SFUConnectionState.DISCONNECTED,
    roomId: null,
    serverId: null,
    error: null,
  });
  const activeSfuUrlRef = useRef<string | null>(null);

  const [streams, setStreams] = useState<Streams>({});
  const [streamSources, setStreamSources] = useState<StreamSources>({});
  const [videoStreams, setVideoStreams] = useState<VideoStreams>({});
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const screenVideoSenderRef = useRef<RTCRtpSender | null>(null);
  const screenAudioSenderRef = useRef<RTCRtpSender | null>(null);
  const lastCameraCodecRef = useRef<string | undefined>(undefined);
  const lastScreenCodecRef = useRef<string | undefined>(undefined);

  // Dependencies
  const config = useVoiceConfig();
  const { outputVolume, deafened, serverDeafened } = config.audio;
  const { eSportsMode: eSportsModeEnabled, stunHosts } = config.connection;
  const effectiveDeafened = deafened || serverDeafened;

  const target = useVoiceTarget();
  const room = target?.room ?? null;

  const isConnected = useMemo(() => {
    return connectionState.state === SFUConnectionState.CONNECTED &&
           !!sfuWebSocketRef.current &&
           !!peerConnectionRef.current;
  }, [connectionState.state]);

  const isConnecting = useMemo(() => {
    return connectionState.state === SFUConnectionState.CONNECTING ||
           connectionState.state === SFUConnectionState.REQUESTING_ACCESS ||
           connectionState.state === SFUConnectionState.RECONNECTING;
  }, [connectionState.state]);

  // Access shared microphone buffer
  const { microphoneBuffer } = useMicrophone(isConnecting || isConnected);
  const microphoneBufferRef = useRef(microphoneBuffer);
  useEffect(() => { microphoneBufferRef.current = microphoneBuffer; }, [microphoneBuffer]);
  const { audioContext, remoteBusNode } = useSpeakers();

  // Stable refs bundle for cleanup helpers
  const cleanupRefs: CleanupRefs = useMemo(() => ({
    peerConnectionRef, sfuWebSocketRef, registeredTracksRef,
    reconnectAttemptRef, connectionTimeoutRef,
    isDisconnectingRef, isConnectingRef, previousRemoteStreamsRef,
  }), []);

  const performCleanup = useCallback(async (skipServerUpdate = false) => {
    await performSfuCleanup(cleanupRefs, {
      room,
      setStreamSources,
      setStreams,
    }, skipServerUpdate);
  }, [room, cleanupRefs]);

  useSFUStreams({
    streams,
    setStreams,
    streamSources,
    setStreamSources,
    setVideoStreams,
    audioContext,
    remoteBusNode,
    outputVolume,
    isDeafened: effectiveDeafened,
    isConnected,
    room,
    previousRemoteStreamsRef,
  });

  // The auto-disconnect-when-the-server-is-removed effect lived here and has
  // stayed in the client. It read the whole server map to notice that the one
  // we are connected to had gone, and knowing which servers exist is the thing
  // the engine is deliberately kept out of. The client watches its own list and
  // calls disconnect().

  // Cleanup on unmount
  useEffect(() => {
    return () => performUnmountCleanup(cleanupRefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close SFU WebSocket and peer connection before page unload (Ctrl+R / tab close)
  // so the SFU receives the close frame and tears down the old session promptly.
  useEffect(() => {
    const handleBeforeUnload = () => {
      const ws = sfuWebSocketRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close(1000, "Page unloading");
      }
      const pc = peerConnectionRef.current;
      if (pc && pc.connectionState !== "closed") {
        pc.close();
      }
    };
    // Browser-only: there is no page to unload on React Native, and this
    // belongs with the web adapter once there is one. Guarded rather than
    // removed, because on the desktop it is what stops a closing tab leaving a
    // half-open peer connection behind.
    if (typeof window === "undefined") return;
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const sfuConnectionRefs = useMemo(() => ({
    isDisconnectingRef,
    sfuWebSocketRef,
    peerConnectionRef,
  }), []);

  // Track the last channel ID so we can reconnect after server restart
  const lastChannelIdRef = useRef<string>("");
  // Tracks whether the last disconnect was user/server-initiated (true) vs
  // a network/SFU failure (false).  Starts true so we don't auto-reconnect
  // on initial page load.
  const intentionalDisconnectRef = useRef(true);

  // Enhanced connect function — delegates to sfuConnectFlow
  const connect = useCallback(async (channelID: string, channelEsportsMode?: boolean, channelMaxBitrate?: number | null): Promise<void> => {
    if (!target) {
      throw new Error("No voice target: nothing to connect to");
    }
    if (!stunHosts?.length) {
      throw new Error("SFU configuration not available");
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (channelID !== lastChannelIdRef.current) {
      reconnectAttemptsRef.current = 0;
    }

    intentionalDisconnectRef.current = false;
    lastChannelIdRef.current = channelID;
    const seq = ++connectSeqRef.current;

    await sfuConnect({
      channelID,
      eSportsModeEnabled: eSportsModeEnabled || channelEsportsMode === true,
      channelMaxBitrateBps: channelMaxBitrate ?? null,
      connectSeq: seq,
      connectSeqRef,
      refs: {
        isConnectingRef, isDisconnectingRef, peerConnectionRef,
        sfuWebSocketRef, registeredTracksRef, connectionTimeoutRef,
        microphoneBufferRef, activeSfuUrlRef,
      },
      connectionState,
      isConnected,
      targetId: target.id,
      stunHosts,
      room: target.room,
      sfuConnectionRefs,
      setConnectionState,
      setStreams,
      performCleanup,
    });
  }, [
    target,
    stunHosts,
    connectionState,
    isConnected,
    sfuConnectionRefs,
    performCleanup,
    eSportsModeEnabled,
  ]);

  // Enhanced disconnect — optimistic with background cleanup
  // The old signature was disconnect(playSound?, onDisconnect?). The engine no
  // longer plays anything, so the first argument is gone — a caller that wants a
  // sound plays one, and a caller that does not, does not.
  const disconnect = useCallback(async (onDisconnect?: () => void): Promise<void> => {
    intentionalDisconnectRef.current = true;
    reconnectAttemptsRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    setConnectionState({
      state: SFUConnectionState.DISCONNECTED,
      roomId: null,
      serverId: null,
      error: null,
    });

    if (onDisconnect) {
      onDisconnect();
    }

    performCleanup(false).catch((error) => {
      console.error("Background cleanup error:", error);
      setStreamSources({});
    });
  }, [performCleanup]);

  const sendRenegotiate = useCallback(() => {
    const ws = sfuWebSocketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ event: "renegotiate", data: "" }));
    } catch { /* ws may have closed between check and send */ }
  }, []);

  const applyVideoCodecPreferences = useCallback((pc: RTCPeerConnection, sender: RTCRtpSender, preferredCodec: string | undefined, label: Phase): boolean => {
    const transceiver = pc.getTransceivers().find(t => t.sender === sender);
    if (!transceiver?.setCodecPreferences) return false;
    const caps = RTCRtpSender.getCapabilities("video");
    if (!caps) return false;

    const mimeMap: Record<string, string> = {
      h264: "video/h264",
      vp9: "video/vp9",
      av1: "video/av1",
    };
    const targetMimeLower = preferredCodec && preferredCodec !== "auto"
      ? mimeMap[preferredCodec]
      : "video/h264";

    if (!targetMimeLower) return false;

    const preferred = caps.codecs.filter(c => c.mimeType.toLowerCase() === targetMimeLower);
    const rest = caps.codecs.filter(c => c.mimeType.toLowerCase() !== targetMimeLower);

    if (preferred.length === 0) {
      const availableMimes = [...new Set(caps.codecs.map(c => c.mimeType))];
      voiceLog.warn(label, `Codec "${preferredCodec}" (${targetMimeLower}) NOT found in browser capabilities. Available: [${availableMimes.join(", ")}]. Falling back to browser default order.`);
      return false;
    }

    transceiver.setCodecPreferences([...preferred, ...rest]);
    voiceLog.info(label, `setCodecPreferences: ${preferredCodec ?? "auto"} preferred (${preferred.length} matched, ${rest.length} other)`);
    return true;
  }, []);

  const addVideoTrack = useCallback((track: MediaStreamTrack, stream: MediaStream, preferredCodec?: string) => {
    const pc = peerConnectionRef.current;
    if (!pc || pc.connectionState === "closed") {
      voiceLog.warn("CAMERA", `addVideoTrack skipped — pc ${pc ? pc.connectionState : "null"}`);
      return;
    }
    if (videoSenderRef.current) {
      const oldTrackId = videoSenderRef.current.track?.id;
      voiceLog.step("CAMERA", "replace", "replaceTrack on existing sender", {
        oldTrackId,
        newTrackId: track.id,
        newTrackReadyState: track.readyState,
        pcState: pc.connectionState,
        senderTransport: videoSenderRef.current.transport?.state,
      });
      videoSenderRef.current.replaceTrack(track)
        .then(() => {
          voiceLog.ok("CAMERA", "replace", "replaceTrack succeeded", {
            senderTrackId: videoSenderRef.current?.track?.id,
            newTrackId: track.id,
            trackReadyState: track.readyState,
          });
        })
        .catch((err: unknown) => {
          voiceLog.fail("CAMERA", "replace", "replaceTrack FAILED", {
            error: err,
            pcState: pc.connectionState,
            senderTrackId: videoSenderRef.current?.track?.id,
          });
        });

      if (preferredCodec !== lastCameraCodecRef.current) {
        voiceLog.info("CAMERA", `Codec changed (${lastCameraCodecRef.current} → ${preferredCodec}), re-applying preferences`);
        applyVideoCodecPreferences(pc, videoSenderRef.current, preferredCodec, "CAMERA");
        lastCameraCodecRef.current = preferredCodec;
        sendRenegotiate();
      }
      return;
    }
    voiceLog.step("CAMERA", "add", "addTrack + renegotiate (first camera track)", {
      trackId: track.id,
      streamId: stream.id,
      pcState: pc.connectionState,
    });
    const sender = pc.addTrack(track, stream);
    videoSenderRef.current = sender;
    applyVideoCodecPreferences(pc, sender, preferredCodec, "CAMERA");
    lastCameraCodecRef.current = preferredCodec;
    sendRenegotiate();
  }, [sendRenegotiate, applyVideoCodecPreferences]);

  const removeVideoTrack = useCallback(() => {
    const pc = peerConnectionRef.current;
    const sender = videoSenderRef.current;
    if (!pc || !sender || pc.connectionState === "closed") return;
    voiceLog.step("CAMERA", "remove", "Removing video track", {
      trackId: sender.track?.id,
      pcState: pc.connectionState,
    });
    try {
      pc.removeTrack(sender);
    } catch { /* already removed */ }
    videoSenderRef.current = null;
    sendRenegotiate();
  }, [sendRenegotiate]);

  const addScreenVideoTrack = useCallback((track: MediaStreamTrack, stream: MediaStream, preferredCodec?: string) => {
    const pc = peerConnectionRef.current;
    if (!pc || pc.connectionState === "closed") return;
    if (screenVideoSenderRef.current) {
      voiceLog.info("SCREEN", `REPLACE path – track=${track.id} stream=${stream.id} senderTrack=${screenVideoSenderRef.current.track?.id ?? "null"}`);
      screenVideoSenderRef.current.replaceTrack(track)
        .then(() => voiceLog.ok("SCREEN", "replace", `replaceTrack succeeded – track=${track.id}`))
        .catch((err: unknown) => voiceLog.fail("SCREEN", "replace", `replaceTrack FAILED – track=${track.id}`, err));

      if (preferredCodec !== lastScreenCodecRef.current) {
        voiceLog.info("SCREEN", `Codec changed (${lastScreenCodecRef.current} → ${preferredCodec}), re-applying preferences`);
        applyVideoCodecPreferences(pc, screenVideoSenderRef.current, preferredCodec, "SCREEN");
        lastScreenCodecRef.current = preferredCodec;
        sendRenegotiate();
      }
      return;
    }
    voiceLog.info("SCREEN", `ADD path – track=${track.id} stream=${stream.id} pcState=${pc.signalingState}`);
    const sender = pc.addTrack(track, stream);
    screenVideoSenderRef.current = sender;
    applyVideoCodecPreferences(pc, sender, preferredCodec, "SCREEN");
    lastScreenCodecRef.current = preferredCodec;

    voiceLog.info("SCREEN", `addTrack done, calling sendRenegotiate`);
    sendRenegotiate();
  }, [sendRenegotiate, applyVideoCodecPreferences]);

  const removeScreenVideoTrack = useCallback(() => {
    const sender = screenVideoSenderRef.current;
    if (!sender) return;
    voiceLog.info("SCREEN", `removeScreenVideoTrack – pausing via replaceTrack(null), senderTrack=${sender.track?.id ?? "null"}`);
    sender.replaceTrack(null)
      .then(() => voiceLog.ok("SCREEN", "pause", "video replaceTrack(null) succeeded"))
      .catch((err: unknown) => voiceLog.fail("SCREEN", "pause", "video replaceTrack(null) FAILED", err));
  }, []);

  const addScreenAudioTrack = useCallback((track: MediaStreamTrack, stream: MediaStream) => {
    const pc = peerConnectionRef.current;
    if (!pc || pc.connectionState === "closed") return;
    if (screenAudioSenderRef.current) {
      voiceLog.info("SCREEN", `Audio REPLACE path – track=${track.id} stream=${stream.id}`);
      screenAudioSenderRef.current.replaceTrack(track)
        .then(() => voiceLog.ok("SCREEN", "audioReplace", `replaceTrack succeeded – track=${track.id}`))
        .catch((err: unknown) => voiceLog.fail("SCREEN", "audioReplace", `replaceTrack FAILED – track=${track.id}`, err));
      return;
    }
    voiceLog.info("SCREEN", `Audio ADD path – track=${track.id} stream=${stream.id} pcState=${pc.signalingState}`);
    const sender = pc.addTrack(track, stream);
    screenAudioSenderRef.current = sender;
    voiceLog.info("SCREEN", `audio addTrack done, calling sendRenegotiate`);
    sendRenegotiate();
  }, [sendRenegotiate]);

  const removeScreenAudioTrack = useCallback(() => {
    const sender = screenAudioSenderRef.current;
    if (!sender) return;
    voiceLog.info("SCREEN", `removeScreenAudioTrack – pausing via replaceTrack(null), senderTrack=${sender.track?.id ?? "null"}`);
    sender.replaceTrack(null)
      .then(() => voiceLog.ok("SCREEN", "pause", "audio replaceTrack(null) succeeded"))
      .catch((err: unknown) => voiceLog.fail("SCREEN", "pause", "audio replaceTrack(null) FAILED", err));
  }, []);

  // Clear stale sender refs when the peer connection is closed so a fresh
  // connection gets fresh senders via the ADD path.
  useEffect(() => {
    if (!isConnected) {
      screenVideoSenderRef.current = null;
      screenAudioSenderRef.current = null;
      videoSenderRef.current = null;
      lastCameraCodecRef.current = undefined;
      lastScreenCodecRef.current = undefined;
    }
  }, [isConnected]);

  const connectionStateRef = useRef(connectionState);
  useEffect(() => { connectionStateRef.current = connectionState; }, [connectionState]);

  // A `server_voice_disconnect` window event used to be handled here: it
  // checked the host matched, called disconnect(), and re-dispatched
  // `voice_disconnect_text_switch` for the UI. All three are the client's. It
  // owns the event, it knows which server raised it, and it can call
  // disconnect() itself — which is also the only way this works on a platform
  // without a DOM.

  // Reconnect voice after the signaling server reconnects. When only the
  // Socket.IO transport dropped (e.g. Cloudflare Tunnel reset) but the SFU
  // WebSocket + WebRTC peer connection are still alive, we skip the full SFU
  // teardown and let the server's grace-period restore voice state. If the SFU
  // connection also died, we fall back to a full reconnect with a short delay.
  const connectRef = useRef(connect);
  useEffect(() => { connectRef.current = connect; }, [connect]);
  const disconnectRef = useRef(disconnect);
  useEffect(() => { disconnectRef.current = disconnect; }, [disconnect]);

  useEffect(() => {
    const handleServerReconnected = () => {
      // The coordinator is the one we are connected through, so the host it is
      // telling us about is the target's. The old window event had to carry it
      // because any server's socket could raise it.
      const host = target?.id;

      const channelId = lastChannelIdRef.current;
      if (!channelId || intentionalDisconnectRef.current) return;

      const cs = connectionStateRef.current;

      if (
        (cs.state === SFUConnectionState.CONNECTED || cs.state === SFUConnectionState.CONNECTING) &&
        cs.serverId !== host
      ) {
        return;
      }

      reconnectAttemptsRef.current = 0;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      const sfuWs = sfuWebSocketRef.current;
      const pc = peerConnectionRef.current;
      const sfuAlive =
        sfuWs?.readyState === WebSocket.OPEN &&
        pc?.connectionState === "connected";

      if (
        sfuAlive &&
        cs.state === SFUConnectionState.CONNECTED &&
        cs.serverId === host
      ) {
        // SFU is still connected — the server's grace-period will restore
        // voice state during session restoration, so no teardown needed.
        console.info(
          "[Voice Recovery] Server reconnected — SFU still alive, skipping teardown (channel:",
          channelId, ")",
        );
        return;
      }

      // SFU died or was not connected — full reconnect with short delay
      console.info("[Voice Recovery] Server reconnected — SFU not alive, full reconnect for channel:", channelId);

      const doReconnect = () => {
        intentionalDisconnectRef.current = false;
        console.info("[Voice Recovery] Attempting voice reconnect to channel:", channelId);
        connectRef.current(channelId).catch((error) => {
          console.error("[Voice Recovery] Failed to reconnect voice:", error);
        });
      };

      const voiceStillActive =
        (cs.state === SFUConnectionState.CONNECTED || cs.state === SFUConnectionState.CONNECTING) &&
        cs.serverId === host;

      if (voiceStillActive) {
        disconnectRef.current().then(() => {
          intentionalDisconnectRef.current = false;
          setTimeout(doReconnect, 500);
        }).catch((error) => {
          console.error("[Voice Recovery] Error during disconnect:", error);
        });
      } else {
        setTimeout(doReconnect, 500);
      }
    };

    // Was a `server_socket_reconnected` window event carrying a host. The
    // coordinator owns the signalling connection, so it is the thing that knows,
    // and a DOM event is not something React Native can raise.
    if (!room) return;
    return room.onReconnected(handleServerReconnected);
  }, [room]);

  const MAX_RECONNECT_ATTEMPTS = 5;
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (connectionState.state === SFUConnectionState.CONNECTED) {
      reconnectAttemptsRef.current = 0;
    }
  }, [connectionState.state]);


  useEffect(() => {
    if (connectionState.state !== SFUConnectionState.FAILED) return;

    const channelId = lastChannelIdRef.current;
    if (!channelId || intentionalDisconnectRef.current) return;

    // Retrying the SFU while signalling is down burns attempts against
    // something that cannot answer. onReconnected above restarts this.
    if (!room?.connected) {
      console.info("[Voice Recovery] Signalling not connected — waiting for it before retrying voice");
      setConnectionState(prev => ({
        ...prev,
        state: SFUConnectionState.RECONNECTING,
      }));
      return;
    }

    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      // Giving up is reported through the state, not announced. The client
      // decides whether that is worth a toast.
      console.warn("[Voice Recovery] Max reconnect attempts reached — giving up");
      setConnectionState({
        state: SFUConnectionState.DISCONNECTED,
        roomId: null,
        serverId: null,
        error: null,
      });
      reconnectAttemptsRef.current = 0;
      return;
    }

    reconnectAttemptsRef.current++;
    const attempt = reconnectAttemptsRef.current;
    const delayMs = Math.min(1500 * Math.pow(2, attempt - 1), 10_000);

    console.info(`[Voice Recovery] Connection lost — auto-reconnecting (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}) in ${delayMs}ms`);

    setConnectionState(prev => ({
      ...prev,
      state: SFUConnectionState.RECONNECTING,
    }));

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current(channelId).catch((error) => {
        console.error(`[Voice Recovery] Reconnect attempt ${attempt} failed:`, error);
      });
    }, delayMs);

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [connectionState.state, connectionState.serverId]);

  // Monitor processedStream changes and update WebRTC tracks
  useEffect(() => {
    if (!isConnected || !peerConnectionRef.current || !registeredTracksRef.current) {
      return;
    }

    const newStream = microphoneBuffer.processedStream || microphoneBuffer.mediaStream;
    if (!newStream) return;

    const currentLocalStreamEntry = Object.entries(streams).find(([, stream]) => stream.isLocal);
    const currentStreamId = currentLocalStreamEntry?.[1].stream.id;
    if (currentStreamId === newStream.id) return;

    const currentTracks = currentLocalStreamEntry?.[1].stream.getAudioTracks() || [];
    const newTracks = newStream.getAudioTracks();

    const tracksChanged = currentTracks.length !== newTracks.length ||
                          currentTracks.some((track, index) => track.id !== newTracks[index]?.id);
    if (!tracksChanged || newTracks.length === 0) return;

    const registeredTracks = registeredTracksRef.current;

    try {
      const updatePromises = registeredTracks.map(async (sender, index) => {
        const newTrack = newTracks[index];
        if (newTrack && sender.track) {
          await sender.replaceTrack(newTrack);
        }
      });

      Promise.all(updatePromises).then(() => {
        setStreams(prev => {
          const nonLocalEntries = Object.entries(prev).filter(([, s]) => !s.isLocal);
          const nonLocal = Object.fromEntries(nonLocalEntries);
          return {
            ...nonLocal,
            [newStream.id]: { stream: newStream, isLocal: true },
          };
        });
      }).catch(error => {
        console.error("Error updating WebRTC tracks:", error);
      });
    } catch (error) {
      console.error("Error replacing WebRTC tracks:", error);
    }
  }, [microphoneBuffer.processedStream, microphoneBuffer.mediaStream, isConnected, streams]);

  return {
    streams,
    error: connectionState.error,
    streamSources,
    videoStreams,
    connect,
    disconnect,
    addVideoTrack,
    removeVideoTrack,
    addScreenVideoTrack,
    removeScreenVideoTrack,
    addScreenAudioTrack,
    removeScreenAudioTrack,
    currentServerConnected: connectionState.serverId || "",
    isConnected,
    currentChannelConnected: connectionState.roomId || "",
    connectionState: connectionState.state,
    isConnecting,
    getPeerConnection: () => peerConnectionRef.current,
    getScreenSenderTrackId: () => screenVideoSenderRef.current?.track?.id ?? null,
    getScreenVideoSender: () => screenVideoSenderRef.current,
    getCameraSenderTrackId: () => videoSenderRef.current?.track?.id ?? null,
    activeSfuUrl: activeSfuUrlRef.current,
  };
}

const init: SFUInterface = {
  error: null,
  streams: {},
  streamSources: {},
  videoStreams: {},
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  addVideoTrack: () => {},
  removeVideoTrack: () => {},
  addScreenVideoTrack: () => {},
  removeScreenVideoTrack: () => {},
  addScreenAudioTrack: () => {},
  removeScreenAudioTrack: () => {},
  currentChannelConnected: "",
  currentServerConnected: "",
  isConnected: false,
  connectionState: SFUConnectionState.DISCONNECTED,
  isConnecting: false,
  activeSfuUrl: null,
  getScreenVideoSender: () => null,
};

const SFUHook = singletonHook(init, useSfuHook);

export const useSFU = () => {
  return SFUHook();
};
