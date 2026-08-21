import { Dispatch, MutableRefObject, SetStateAction, useEffect, useRef } from "react";

import { sliderToOutputGain } from "../../shared/audioVolume";

import { Streams, StreamSources, VideoStreams } from "../types/SFU";
import type { RoomCoordinator } from "../../types";
import { voiceLog } from "./voiceLogger";

interface UseSFUStreamsParams {
  streams: Streams;
  setStreams: Dispatch<SetStateAction<Streams>>;
  streamSources: StreamSources;
  setStreamSources: Dispatch<SetStateAction<StreamSources>>;
  setVideoStreams: Dispatch<SetStateAction<VideoStreams>>;
  audioContext: AudioContext | null | undefined;
  remoteBusNode: GainNode | undefined;
  outputVolume: number;
  isDeafened: boolean;
  isConnected: boolean;
  room: RoomCoordinator | null;
  previousRemoteStreamsRef: MutableRefObject<Set<string>>;
}

export function useSFUStreams({
  streams,
  setStreams,
  streamSources,
  setStreamSources,
  setVideoStreams,
  audioContext,
  remoteBusNode,
  outputVolume,
  isDeafened,
  isConnected,
  room,
  previousRemoteStreamsRef,
}: UseSFUStreamsParams): void {
  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  const streamSourcesRef = useRef(streamSources);
  streamSourcesRef.current = streamSources;
  // Track peer connections and emit events when peers join/leave
  useEffect(() => {
    if (!isConnected) {
      previousRemoteStreamsRef.current.clear();
      return;
    }

    const currentRemoteStreams = new Set<string>();
    Object.entries(streams).forEach(([streamId, streamData]) => {
      if (!streamData.isLocal) {
        currentRemoteStreams.add(streamId);
      }
    });

    const previousRemoteStreams = previousRemoteStreamsRef.current;

    const newPeers = [...currentRemoteStreams].filter(streamId => !previousRemoteStreams.has(streamId));
    const disconnectedPeers = [...previousRemoteStreams].filter(streamId => !currentRemoteStreams.has(streamId));

    if (room) {
      newPeers.forEach(streamId => room.peerChanged(streamId, true));
      disconnectedPeers.forEach(streamId => room.peerChanged(streamId, false));
    }

    previousRemoteStreamsRef.current = currentRemoteStreams;
  }, [streams, isConnected, room, previousRemoteStreamsRef]);

  // Cleanup stale streamSources when streams are removed or their underlying
  // MediaStream is replaced (e.g. alias swap after SFU renegotiation).
  useEffect(() => {
    const removedIds = Object.keys(streamSources).filter((id) => streams[id] === undefined);

    // Detect pipelines whose source MediaStream no longer matches the current
    // stream entry — this happens when an alias updates streams[id] to a new
    // MediaStream while the old pipeline still references the previous one.
    const mismatchedIds = Object.keys(streamSources).filter((id) => {
      const streamData = streams[id];
      if (!streamData) return false;
      const sourceNode = streamSources[id].stream;
      if ("mediaStream" in sourceNode) {
        return (sourceNode as MediaStreamAudioSourceNode).mediaStream !== streamData.stream;
      }
      return false;
    });

    const allStaleIds = [...removedIds, ...mismatchedIds];
    if (allStaleIds.length === 0) return;

    if (mismatchedIds.length > 0) {
      voiceLog.info("WEBRTC", `Stale pipeline cleanup: ${mismatchedIds.length} mismatched source(s): [${mismatchedIds.join(", ")}]`);
    }

    // Only disconnect audio nodes if no other (non-stale) entry shares them.
    // Aliases reuse the same object reference, so check identity.
    const staleSet = new Set(allStaleIds);
    const survivingEntries = new Set(
      Object.entries(streamSources)
        .filter(([id]) => !staleSet.has(id))
        .map(([, entry]) => entry),
    );

    allStaleIds.forEach((id) => {
      const source = streamSources[id];
      if (survivingEntries.has(source)) return;
      try {
        source.gain.disconnect();
        source.analyser.disconnect();
        source.stream.disconnect();
        if (source.audioElement) {
          source.audioElement.pause();
          source.audioElement.srcObject = null;
          source.audioElement.remove();
        }
      } catch { /* already disconnected */ }
    });

    setStreamSources((prev) => {
      const next = { ...prev };
      allStaleIds.forEach((id) => delete next[id]);
      return next;
    });
  }, [streams, streamSources, setStreamSources]);

  // Setup audio processing (sourceNode/analyser/gainNode) per remote stream
  useEffect(() => {
    if (!audioContext) {
      voiceLog.warn("WEBRTC", "useSFUStreams: no audioContext — skipping playback setup");
      return;
    }

    const newStreamSources: StreamSources = { ...streamSources };
    let hasChanges = false;

    // Build a map from MediaStream.id → streamSources key so we can detect
    // aliases (multiple stream keys pointing at the same underlying MediaStream)
    // and reuse a single playback pipeline instead of creating duplicates.
    const mediaStreamToSourceKey = new Map<string, string>();
    // Track-level dedup: catches the case where the same audio track is
    // re-wrapped in a new MediaStream after SFU renegotiation.
    const audioTrackToSourceKey = new Map<string, string>();
    for (const [key] of Object.entries(newStreamSources)) {
      const streamData = streams[key];
      if (streamData) {
        mediaStreamToSourceKey.set(streamData.stream.id, key);
        for (const t of streamData.stream.getAudioTracks()) {
          audioTrackToSourceKey.set(t.id, key);
        }
      }
    }

    Object.keys(streams).forEach((streamID) => {
      const stream = streams[streamID];

      if (stream.isLocal) return;
      if (newStreamSources[streamID]) return;

      const audioTracks = stream.stream.getAudioTracks();
      if (!audioTracks.length) {
        voiceLog.warn("WEBRTC", `Remote stream ${streamID} has 0 audio tracks — skipping`);
        return;
      }

      // If another stream key already created playback for this exact
      // MediaStream, reuse that pipeline instead of creating a duplicate.
      const existingKey = mediaStreamToSourceKey.get(stream.stream.id);
      if (existingKey && newStreamSources[existingKey]) {
        voiceLog.info("WEBRTC", `Stream ${streamID} shares MediaStream ${stream.stream.id} with ${existingKey} — reusing playback pipeline`);
        newStreamSources[streamID] = newStreamSources[existingKey];
        hasChanges = true;
        return;
      }

      // Same audio track served via a new MediaStream (renegotiation alias)
      const existingByTrack = audioTracks
        .map(t => audioTrackToSourceKey.get(t.id))
        .find(key => key !== undefined && newStreamSources[key]);
      if (existingByTrack) {
        voiceLog.info("WEBRTC", `Stream ${streamID} shares audio track(s) with ${existingByTrack} — reusing playback pipeline`);
        newStreamSources[streamID] = newStreamSources[existingByTrack];
        hasChanges = true;
        return;
      }

      voiceLog.step("WEBRTC", "PLAY", `Setting up playback for remote stream ${streamID}`, {
        trackCount: audioTracks.length,
        tracks: audioTracks.map(t => ({ id: t.id, readyState: t.readyState, enabled: t.enabled, muted: t.muted })),
        audioContextState: audioContext.state,
        outputVolume,
        isDeafened,
      });

      try {
        // Use an HTMLAudioElement to ensure Chrome decodes the WebRTC stream.
        // createMediaStreamSource() alone doesn't always trigger the decoder.
        const audioEl = new Audio();
        audioEl.srcObject = stream.stream;
        audioEl.autoplay = true;
        // Mute the element itself — all volume goes through the Web Audio gain node
        audioEl.volume = 0;
        audioEl.play().catch(e => voiceLog.warn("WEBRTC", `Audio element play() rejected: ${e.message}`));

        const sourceNode = audioContext.createMediaStreamSource(stream.stream);
        const analyserNode = audioContext.createAnalyser();
        const gainNode = audioContext.createGain();

        const outputGain = isDeafened ? 0 : sliderToOutputGain(outputVolume);
        gainNode.gain.value = outputGain;

        sourceNode.connect(analyserNode);
        analyserNode.connect(gainNode);
        const destination = remoteBusNode ?? audioContext.destination;
        gainNode.connect(destination);

        voiceLog.ok("WEBRTC", "PLAY", `Playback connected: stream ${streamID} → analyser → gain(${outputGain.toFixed(2)}) → speakers`, {
          audioContextState: audioContext.state,
          destinationChannels: audioContext.destination.maxChannelCount,
        });

        const entry = {
          gain: gainNode,
          analyser: analyserNode,
          stream: sourceNode,
          audioElement: audioEl,
        };

        newStreamSources[streamID] = entry;
        mediaStreamToSourceKey.set(stream.stream.id, streamID);

        hasChanges = true;
      } catch (error) {
        voiceLog.fail("WEBRTC", "PLAY", `Failed to setup playback for stream ${streamID}`, error);
      }
    });

    if (hasChanges) {
      voiceLog.info("WEBRTC", `streamSources updated – keys: [${Object.keys(newStreamSources).join(", ")}]`);
      setStreamSources(newStreamSources);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams, audioContext, streamSources, setStreamSources]);

  // Update output volume for all streams when the global setting changes.
  // Uses a ref for streamSources so this effect only fires on volume/deafen
  // changes — not when a new peer joins — avoiding a reset of per-user gains.
  useEffect(() => {
    const outputGain = isDeafened ? 0 : sliderToOutputGain(outputVolume);

    Object.values(streamSourcesRef.current).forEach(({ gain }) => {
      if (gain) {
        gain.gain.setValueAtTime(outputGain, audioContext?.currentTime || 0);
      }
    });
  }, [outputVolume, isDeafened, audioContext]);

  /**
   * Deafen where there is no audio graph to turn down.
   *
   * Everything above routes remote audio through a gain node, and the effect
   * that reacts to `isDeafened` sets that gain to zero. On a phone there is no
   * `AudioContext` to build one in — the setup effect logs "no audioContext"
   * and returns — so `streamSources` stays empty, that effect iterates nothing,
   * and `react-native-webrtc` goes on playing the received track itself. The
   * button lights up and you still hear everybody.
   *
   * `enabled` is the lever both platforms have. On a *remote* track it is
   * receiver-side: libwebrtc drops the decoded audio rather than asking the
   * sender to stop, so nobody else's call changes, which is what deafen means.
   *
   * **Volume is not the same case.** A number between zero and one needs a
   * graph and there is none, so `outputVolume` stays a web-only control rather
   * than being approximated with on and off. An embedder that offers a slider
   * on a phone is offering something nothing reads.
   *
   * Only where there is no context: with one, the gain node already owns this,
   * and disabling the track as well would take a stream out of the analyser
   * that draws who is speaking.
   */
  useEffect(() => {
    if (audioContext) return;

    // Depends on `streams` rather than reading the ref, so a peer who joins
    // while you are deafened arrives silent instead of being the one person
    // you can hear.
    for (const streamData of Object.values(streams)) {
      if (streamData.isLocal) continue;
      for (const track of streamData.stream.getAudioTracks()) {
        track.enabled = !isDeafened;
      }
    }
  }, [streams, isDeafened, audioContext]);

  // Safety net: periodically remove streams whose tracks have all ended.
  // Handles edge cases where track.onended doesn't fire (ICE failure, etc).
  useEffect(() => {
    if (!isConnected) return;

    const interval = setInterval(() => {
      const current = streamsRef.current;
      const deadIds: string[] = [];
      Object.entries(current).forEach(([id, data]) => {
        if (data.isLocal) return;
        const tracks = data.stream.getTracks();
        if (tracks.length === 0 || tracks.every(t => t.readyState === "ended")) {
          deadIds.push(id);
        }
      });
      if (deadIds.length > 0) {
        voiceLog.info("WEBRTC", `Orphan cleanup: removing ${deadIds.length} dead stream(s): ${deadIds.join(", ")}`);
        setStreams(prev => {
          const next = { ...prev };
          deadIds.forEach(id => delete next[id]);
          return next;
        });
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [isConnected, setStreams]);

  // Track the first stream ID seen for each track so we can alias after
  // SFU renegotiations that assign new stream IDs to the same tracks.
  const trackToOriginalStreamRef = useRef<Map<string, string>>(new Map());

  // Extract video MediaStreams from remote streams for rendering in VoiceView
  useEffect(() => {
    const nextVideo: VideoStreams = {};
    const trackMap = trackToOriginalStreamRef.current;

    Object.entries(streams).forEach(([streamId, data]) => {
      if (data.isLocal) return;
      const videoTracks = data.stream.getVideoTracks();
      if (videoTracks.length > 0 && videoTracks.some(t => t.readyState === "live")) {
        nextVideo[streamId] = data.stream;

        for (const track of videoTracks) {
          const originalId = trackMap.get(track.id);
          if (!originalId) {
            trackMap.set(track.id, streamId);
          } else if (originalId !== streamId) {
            nextVideo[originalId] = data.stream;
          }
        }
      }
    });

    setVideoStreams(prev => {
      const prevKeys = Object.keys(prev).sort().join(",");
      const nextKeys = Object.keys(nextVideo).sort().join(",");
      if (prevKeys !== nextKeys) {
        console.log(`[ScreenShare] videoStreams keys changed: [${prevKeys}] -> [${nextKeys}]`);
        return nextVideo;
      }
      const streamsChanged = Object.keys(nextVideo).some(k => prev[k] !== nextVideo[k]);
      if (streamsChanged) {
        console.log(`[ScreenShare] videoStreams objects changed (same keys): [${nextKeys}]`);
        return nextVideo;
      }
      return prev;
    });
  }, [streams, setVideoStreams]);
}
