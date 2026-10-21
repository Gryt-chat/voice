import { useCallback, useEffect, useRef, useState } from "react";

import { useVoiceConfig } from "../../config";
import { useSFU } from "../../webrtc/hooks/useSFU";

import { type ReceiveCounters, type ReceiveStream, readReceiveStreams, total, worst } from "../receiveStats";

import { useMicrophone } from "./useMicrophone";

export interface LatencyBreakdown {
  // Local audio pipeline
  contextBaseLatencyMs: number | null;
  contextOutputLatencyMs: number | null;
  rnnoiseBufferMs: number | null;

  // WebRTC transport
  networkRttMs: number | null;
  oneWayNetworkMs: number | null;
  jitterMs: number | null;
  jitterBufferMs: number | null;
  packetsLost: number | null;
  packetsSent: number | null;
  packetsReceived: number | null;
  /** Each incoming audio stream on its own (gh-53). The fields above are the worst, or the sum. */
  receiveStreams: ReceiveStream[];

  // Codec info
  codec: string | null;
  bitrateKbps: number | null;
  availableOutKbps: number | null;

  // Connection info
  sfuEndpoint: string | null;
  remoteAddress: string | null;
  localAddress: string | null;
  candidateType: string | null;

  // Estimated totals
  localPipelineMs: number | null;
  estimatedOneWayMs: number | null;
  estimatedRoundTripMs: number | null;
  /** One-way plus the worst receive jitter buffer and this device's output latency (gh-53). */
  estimatedMouthToEarMs: number | null;
  /** How long this connection has been up, so long-call growth can be read against it. */
  callAgeMs: number | null;
  /** On the own transport: one frame, and the most anyone's audio waits here before it plays. Null off it. */
  transportFrameMs: number | null;
  transportBufferedMs: number | null;
}

const EMPTY: LatencyBreakdown = {
  contextBaseLatencyMs: null,
  contextOutputLatencyMs: null,
  rnnoiseBufferMs: null,
  networkRttMs: null,
  oneWayNetworkMs: null,
  jitterMs: null,
  jitterBufferMs: null,
  packetsLost: null,
  packetsSent: null,
  packetsReceived: null,
  receiveStreams: [],
  codec: null,
  bitrateKbps: null,
  availableOutKbps: null,
  sfuEndpoint: null,
  remoteAddress: null,
  localAddress: null,
  candidateType: null,
  localPipelineMs: null,
  estimatedOneWayMs: null,
  estimatedRoundTripMs: null,
  estimatedMouthToEarMs: null,
  callAgeMs: null,
  transportFrameMs: null,
  transportBufferedMs: null,
};

export function useVoiceLatency(enabled: boolean) {
  const config = useVoiceConfig();
  const { noiseSuppression: rnnoiseEnabled, inputMode } = config.audio;
  const { eSportsMode: eSportsModeEnabled } = config.connection;
  const sfu = useSFU();
  const { isConnected } = sfu;
  const { audioContext, microphoneBuffer } = useMicrophone(false);

  const [latency, setLatency] = useState<LatencyBreakdown>(EMPTY);
  const prevBytesRef = useRef<{ bytes: number; ts: number } | null>(null);
  // Per stream: one shared accumulator mixed participants' counters in a group call (gh-53).
  const prevReceiveRef = useRef(new Map<string, ReceiveCounters>());

  const computeLocalPipeline = useCallback(() => {
    if (!audioContext) return { baseMs: null, outputMs: null, rnnoiseMs: null, totalMs: null };

    const baseMs = typeof audioContext.baseLatency === "number"
      ? audioContext.baseLatency * 1000
      : null;
    const ctx = audioContext as AudioContext & { outputLatency?: number };
    const outputMs = typeof ctx.outputLatency === "number"
      ? ctx.outputLatency * 1000
      : null;

    // AudioWorklet RNNoise latency: one 480-sample frame for accumulation + one for output
    let rnnoiseMs: number | null = null;
    if (rnnoiseEnabled && microphoneBuffer.rnnoiseNode) {
      const sampleRate = audioContext.sampleRate || 48000;
      rnnoiseMs = (480 / sampleRate) * 1000 * 2;
    }

    let totalMs = 0;
    if (baseMs !== null) totalMs += baseMs;
    if (rnnoiseMs !== null) totalMs += rnnoiseMs;

    return { baseMs, outputMs, rnnoiseMs, totalMs: totalMs > 0 ? totalMs : null };
  }, [audioContext, rnnoiseEnabled, microphoneBuffer.rnnoiseNode]);

  // Read through refs, so a render doesn't restart the poll and read the stats again.
  const sfuRef = useRef(sfu);
  sfuRef.current = sfu;
  const computeLocalPipelineRef = useRef(computeLocalPipeline);
  computeLocalPipelineRef.current = computeLocalPipeline;

  useEffect(() => {
    if (!enabled) {
      setLatency(EMPTY);
      prevBytesRef.current = null;
      prevReceiveRef.current.clear();
      return;
    }

    let cancelled = false;
    const connectedAt = isConnected ? performance.now() : null;
    const counters = prevReceiveRef.current;

    const poll = async () => {
      if (cancelled) return;

      const local = computeLocalPipelineRef.current();
      const { getPeerConnection, activeSfuUrl } = sfuRef.current;

      let networkRttMs: number | null = null;
      let jitterMs: number | null = null;
      let jitterBufferMs: number | null = null;
      let packetsLost: number | null = null;
      let packetsSent: number | null = null;
      let packetsReceived: number | null = null;
      let receiveStreams: ReceiveStream[] = [];
      let codec: string | null = null;
      let bitrateKbps: number | null = null;
      let availableOutKbps: number | null = null;
      let remoteAddress: string | null = null;
      let localAddress: string | null = null;
      let candidateType: string | null = null;

      const pc = getPeerConnection?.();
      if (pc && isConnected) {
        try {
          const report = await pc.getStats();
          const codecMap = new Map<string, string>();
          const candidateMap = new Map<string, { address: string; port: number; candidateType: string; protocol: string }>();

          report.forEach((stat) => {
            if (stat.type === "codec") {
              codecMap.set(stat.id, (stat as { mimeType?: string }).mimeType || "unknown");
            }
            if (stat.type === "remote-candidate" || stat.type === "local-candidate") {
              candidateMap.set(stat.id, {
                address: stat.address ?? stat.ip ?? "?",
                port: stat.port ?? 0,
                candidateType: stat.candidateType ?? "?",
                protocol: stat.protocol ?? "?",
              });
            }
          });

          report.forEach((stat) => {
            if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated) {
              if (typeof stat.currentRoundTripTime === "number") {
                networkRttMs = stat.currentRoundTripTime * 1000;
              }
              if (typeof stat.availableOutgoingBitrate === "number") {
                availableOutKbps = stat.availableOutgoingBitrate / 1000;
              }
              const remote = candidateMap.get(stat.remoteCandidateId);
              if (remote) {
                remoteAddress = `${remote.address}:${remote.port}`;
                candidateType = `${remote.candidateType} (${remote.protocol})`;
              }
              const local = candidateMap.get(stat.localCandidateId);
              if (local) {
                localAddress = `${local.address}:${local.port}`;
              }
            }

            if (stat.type === "inbound-rtp" && stat.kind === "audio") {
              if (stat.codecId && codecMap.has(stat.codecId)) {
                codec = codecMap.get(stat.codecId) || null;
              }
            }

            if (stat.type === "outbound-rtp" && stat.kind === "audio") {
              if (typeof stat.packetsSent === "number") {
                packetsSent = stat.packetsSent;
              }
              if (typeof stat.bytesSent === "number") {
                const now = performance.now();
                const prev = prevBytesRef.current;
                if (prev) {
                  const dtSec = (now - prev.ts) / 1000;
                  if (dtSec > 0) {
                    bitrateKbps = ((stat.bytesSent - prev.bytes) * 8) / dtSec / 1000;
                  }
                }
                prevBytesRef.current = { bytes: stat.bytesSent, ts: now };
              }
              if (!codec && stat.codecId && codecMap.has(stat.codecId)) {
                codec = codecMap.get(stat.codecId) || null;
              }
            }
          });

          receiveStreams = readReceiveStreams(report.values(), counters);
          jitterMs = worst(receiveStreams.map((r) => r.jitterMs));
          jitterBufferMs = worst(receiveStreams.map((r) => r.jitterBufferMs));
          packetsLost = total(receiveStreams.map((r) => r.packetsLost));
          packetsReceived = total(receiveStreams.map((r) => r.packetsReceived));
        } catch {
          // getStats can throw if pc is closing
        }
      }

      const oneWayNetworkMs = networkRttMs !== null ? networkRttMs / 2 : null;

      let estimatedOneWayMs: number | null = null;
      {
        let sum = 0;
        let hasData = false;
        if (local.totalMs !== null) { sum += local.totalMs; hasData = true; }
        if (oneWayNetworkMs !== null) { sum += oneWayNetworkMs; hasData = true; }
        estimatedOneWayMs = hasData ? Math.max(0, sum) : null;
      }

      const estimatedRoundTripMs = estimatedOneWayMs !== null ? estimatedOneWayMs * 2 : null;
      // On the own transport, voice goes sender to SFU to here: about one whole round trip, plus a frame.
      const transport = sfuRef.current.getTransportLatency?.() ?? null;
      const transportBufferedMs = transport ? worst([...transport.bufferedByUser.values()]) : null;
      let estimatedMouthToEarMs = estimatedOneWayMs === null ? null : estimatedOneWayMs + (jitterBufferMs ?? 0) + (local.outputMs ?? 0);
      if (transport) {
        estimatedMouthToEarMs = (local.totalMs ?? 0) + transport.frameMs + (networkRttMs ?? 0) + (transportBufferedMs ?? 0) + (transport.outputMs ?? local.outputMs ?? 0);
      }

      if (!cancelled) {
        setLatency({
          contextBaseLatencyMs: local.baseMs,
          contextOutputLatencyMs: local.outputMs,
          rnnoiseBufferMs: local.rnnoiseMs,
          networkRttMs,
          oneWayNetworkMs,
          jitterMs,
          jitterBufferMs,
          packetsLost,
          packetsSent,
          packetsReceived,
          receiveStreams,
          codec,
          bitrateKbps,
          availableOutKbps,
          sfuEndpoint: activeSfuUrl ?? null,
          remoteAddress,
          localAddress,
          candidateType,
          localPipelineMs: local.totalMs,
          estimatedOneWayMs,
          estimatedRoundTripMs,
          estimatedMouthToEarMs,
          callAgeMs: connectedAt === null ? null : performance.now() - connectedAt,
          transportFrameMs: transport?.frameMs ?? null,
          transportBufferedMs,
        });
      }
    };

    poll();
    const interval = setInterval(poll, 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      prevBytesRef.current = null;
      counters.clear();
    };
  }, [enabled, isConnected]);

  const inputLabel = inputMode === "push_to_talk" ? "Push to Talk" : "Voice Activity";
  const modeLabel = eSportsModeEnabled ? "eSports" : inputLabel;

  return { latency, modeLabel };
}
