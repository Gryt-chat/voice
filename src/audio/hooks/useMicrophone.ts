import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useVoiceCallbacks, useVoiceConfig } from "../../config";
import { getVoicePlatform } from "../../platform";
import { singletonHook } from "../../shared/singletonHook";
import type { AudioPipeline, NoiseSuppressor } from "../../types";
import { voiceLog } from "../../webrtc/hooks/voiceLogger";
import {
  createNoiseGateNode,
  ensureNoiseGateWorklet,
} from "../processors/noiseGateProcessor";
import { getIsBrowserSupported } from "../utils/mediaDevices";
import {
  MicrophoneBufferType,
  MicrophoneInterface,
  MicrophoneUnavailableReason,
} from "../types/Microphone";
import {
  createMicrophoneBuffer,
  usePipelineControls,
} from "./microphonePipeline";
import { useSharedAudioContext } from "./useAudioContext";
import { useHandles } from "./useHandles";
import { usePushToTalkGate } from "./usePushToTalkGate";

/* Held open briefly after the last consumer, so a remount does not drop and
   re-acquire the device — which some drivers take a visible moment over. */
const MIC_RELEASE_GRACE_MS = 2_000;

/**
 * getUserMedia rejects with a DOMException whose `name` says what went wrong.
 * Only the two cases worth giving different advice for are singled out;
 * everything else is "failed", because guessing further would put words in the
 * browser's mouth.
 */
function classifyMicFailure(error: unknown): MicrophoneUnavailableReason {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "no-device";
  }
  return "failed";
}

/* Virtual and loopback inputs by name, because nothing in the API marks them.
   Picking one as the default captures silence or the user's own output. */
const VIRTUAL_INPUT_PATTERNS = [
  "blackhole",
  "soundflower",
  "loopback",
  "vb-audio",
  "vb-cable",
  "cable output",
  "virtual audio",
  "voicemeeter",
  "ishowu",
];

function isVirtualInput(device: MediaDeviceInfo): boolean {
  const label = device.label.toLowerCase();
  return VIRTUAL_INPUT_PATTERNS.some((pattern) => label.includes(pattern));
}

/**
 * The device to fall back on when nothing is stored, or when the stored one has
 * gone away.
 *
 * Prefers the first real input over the first device. If every input is
 * virtual, the first one is still returned — someone whose only input is
 * BlackHole is presumably using it on purpose, and refusing to pick anything
 * would be worse than picking the thing they have.
 */
function pickDefaultDevice(
  devices: InputDeviceInfo[],
): InputDeviceInfo | undefined {
  return devices.find((d) => !isVirtualInput(d)) ?? devices[0];
}

/* Only ever compared for distinctness within one page. */
let nextHandleId = 0;

function createHandleId(): string {
  nextHandleId += 1;
  return `mic-handle-${nextHandleId}`;
}

function useCreateMicrophoneHook() {
  const { handles, addHandle, removeHandle, isLoaded } = useHandles();

  const config = useVoiceConfig();
  const { onAudioDeviceChanged } = useVoiceCallbacks();

  // Fixed for the lifetime of the process, so it is read once rather than on
  // every render. `createAudioPipeline` being present is what says "this
  // platform builds its own audio graph, do not build the Web Audio one" —
  // see the comment on VoicePlatform in types.ts.
  const platform = useMemo(() => getVoicePlatform(), []);
  const platformPipeline = platform.createAudioPipeline;
  const {
    deviceId: micID,
    loopback: loopbackEnabled,
    volume: micVolume,
    muted: isMuted,
    serverMuted: isServerMuted,
    noiseGate,
    noiseGateRelease,
    noiseSuppression: rnnoiseEnabled,
    inputMode,
    autoGain: { enabled: autoGainEnabled, targetDb: autoGainTargetDb },
    compressorEnabled,
    compressorAmount,
  } = config.audio;
  const { eSportsMode: eSportsModeEnabled } = config.connection;

  const effectiveMuted = isMuted || isServerMuted;
  const { audioContext, activate: activateAudioContext } =
    useSharedAudioContext();

  const [devices, setDevices] = useState<InputDeviceInfo[]>([]);
  const [micStream, setMicStream] = useState<MediaStream | undefined>(
    undefined,
  );
  const [currentDeviceId, setCurrentDeviceId] = useState<string | undefined>(
    micID,
  );
  const [micRecoveryTick, setMicRecoveryTick] = useState(0);

  const rnnoiseProcessorRef = useRef<NoiseSuppressor | null>(null);
  const [rnnoiseNode, setRnnoiseNode] = useState<AudioWorkletNode | null>(null);
  const [noiseGateNode, setNoiseGateNode] = useState<AudioWorkletNode | null>(
    null,
  );
  const [isGateOpen, setIsGateOpen] = useState(false);
  const [micUnavailable, setMicUnavailable] =
    useState<MicrophoneUnavailableReason | null>(null);
  const gateOpenRef = useRef(false);
  const gateLevelRef = useRef(0);

  const releaseMicTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micStreamRef = useRef<MediaStream | undefined>(undefined);
  /**
   * The `getMicrophone` call that has not settled yet, if there is one.
   *
   * Opening a microphone is slow — slow enough that a caller can give up and
   * ask again while the first request is still in the operating system. On
   * 2026-09-07 three ran at once and all three succeeded, each with its own
   * track; one was used and the other two stayed live with nothing holding
   * them. A stream nobody owns is also a stream the voice view cannot match to
   * a person, which is what draws as a ghost participant (GRYT-964).
   *
   * So a second request while one is in flight waits on the first instead of
   * starting another.
   */
  const micRequestRef = useRef<{
    deviceId: string | undefined;
    stream: Promise<MediaStream>;
  } | null>(null);

  micStreamRef.current = micStream;

  // "Can this client do voice at all", which is what every caller uses it
  // for. A platform that supplies its own pipeline can, by definition, and
  // asking it about `navigator.mediaDevices` would be asking a phone a
  // question about a browser.
  const isBrowserSupported = useMemo(
    () => !!platformPipeline || getIsBrowserSupported(),
    [platformPipeline],
  );

  const clearPendingMicRelease = useCallback(() => {
    if (releaseMicTimerRef.current) {
      clearTimeout(releaseMicTimerRef.current);
      releaseMicTimerRef.current = null;
    }
  }, []);

  const stopMicStream = useCallback((reason: string) => {
    const stream = micStreamRef.current;
    if (!stream) return;

    voiceLog.info("MIC", reason);
    stream.getTracks().forEach((track) => track.stop());
    micStreamRef.current = undefined;
    setMicStream(undefined);
  }, []);

  useEffect(() => {
    return () => {
      clearPendingMicRelease();
    };
  }, [clearPendingMicRelease]);

  // Initialize / tear down RNNoise AudioWorklet + Worker.
  useEffect(() => {
    if (!rnnoiseEnabled || !audioContext) {
      if (rnnoiseProcessorRef.current) {
        voiceLog.info("MIC", "Destroying RNNoise processor");
        rnnoiseProcessorRef.current.destroy();
        rnnoiseProcessorRef.current = null;
      }

      setRnnoiseNode(null);
      return;
    }

    // Undefined where the platform denoises before the engine sees the
    // stream, which is every native platform. Not a failure — the same shape
    // as rnnoiseEnabled being off.
    const processor = platform.createNoiseSuppressor?.();
    if (!processor) {
      setRnnoiseNode(null);
      return;
    }

    let cancelled = false;

    rnnoiseProcessorRef.current = processor;

    voiceLog.step("MIC", 1, "Initializing RNNoise AudioWorklet + Worker", {
      sampleRate: audioContext.sampleRate,
    });

    processor
      .initialize(audioContext)
      .then(() => {
        if (cancelled) {
          processor.destroy();
          return;
        }

        processor.setEnabled(true);
        setRnnoiseNode(processor.getNode());
        voiceLog.ok("MIC", 1, "RNNoise AudioWorklet + Worker ready");
      })
      .catch((error) => {
        voiceLog.fail(
          "MIC",
          1,
          "Failed to initialize RNNoise processor",
          error,
        );
      });

    return () => {
      cancelled = true;
      processor.destroy();
      rnnoiseProcessorRef.current = null;
      setRnnoiseNode(null);
    };
  }, [rnnoiseEnabled, audioContext, platform]);

  // Register the noise gate worklet. The gate has to run on the audio thread,
  // otherwise it stops applying whenever the window is hidden (GRYT-18).
  useEffect(() => {
    if (!audioContext) {
      setNoiseGateNode(null);
      return;
    }

    let cancelled = false;

    ensureNoiseGateWorklet(audioContext)
      .then(() => {
        if (cancelled) return;

        const node = createNoiseGateNode(audioContext);

        // The gate is the only thing that actually knows whether audio is
        // leaving this client, so the UI reads its state rather than
        // re-deriving "speaking" from an analyser with its own threshold.
        node.port.onmessage = (event) => {
          const data = event.data;
          if (!data) return;

          if (typeof data.level === "number") {
            gateLevelRef.current = data.level;
          }
          if (typeof data.open === "boolean") {
            gateOpenRef.current = data.open;
            // Only a state update on transitions — level arrives ~47x/sec and
            // must not re-render anything.
            setIsGateOpen((prev) => (prev === data.open ? prev : data.open));
          }
        };

        setNoiseGateNode(node);
        voiceLog.ok("MIC", 1, "Noise gate AudioWorklet ready");
      })
      .catch((error) => {
        // Falls back to the main-thread gate, which can't gate while hidden.
        voiceLog.fail(
          "MIC",
          1,
          "Failed to register noise gate worklet — falling back to main thread",
          error,
        );
      });

    return () => {
      cancelled = true;
      setNoiseGateNode(null);
      setIsGateOpen(false);
      gateOpenRef.current = false;
      gateLevelRef.current = 0;
    };
  }, [audioContext]);

  /**
   * Level the gate is actually deciding on, 0-100. Returns null when the
   * worklet is unavailable so callers can fall back to their own measurement.
   */
  const getGateLevel = useCallback(
    () => (noiseGateNode ? gateLevelRef.current : null),
    [noiseGateNode],
  );

  /**
   * Whether audio is leaving this client right now: the gate is open and the
   * user is not muted. Null when the worklet is unavailable.
   */
  const isTransmitting = noiseGateNode ? isGateOpen && !effectiveMuted : null;

  /**
   * The platform's own pipeline, on platforms that have one.
   *
   * Null on the web, where `platformPipeline` is undefined and the Web Audio
   * graph below is what runs instead. The two paths never both exist.
   */
  const [ownPipeline, setOwnPipeline] = useState<AudioPipeline | null>(null);

  useEffect(() => {
    if (!platformPipeline || !micStream) {
      setOwnPipeline(null);
      return;
    }

    const pipeline = platformPipeline({
      source: micStream,
      noiseSuppression: rnnoiseEnabled,
      compressorAmount,
    });

    setOwnPipeline(pipeline);

    return () => {
      pipeline.destroy();
      setOwnPipeline(null);
    };
  }, [platformPipeline, micStream, rnnoiseEnabled, compressorAmount]);

  // Mute and gain are pushed rather than rebuilt into, because rebuilding the
  // pipeline on every slider drag would restart capture. The web path does the
  // same thing through usePipelineControls.
  useEffect(() => {
    ownPipeline?.setMuted(effectiveMuted);
  }, [ownPipeline, effectiveMuted]);

  useEffect(() => {
    ownPipeline?.setGain(micVolume);
  }, [ownPipeline, micVolume]);

  const microphoneBuffer = useMemo<MicrophoneBufferType>(() => {
    if (platformPipeline) {
      // Two fields out of eighteen, and the rest stay undefined because they
      // are AudioNodes and there is no audio graph. `MicrophoneBufferType` has
      // every field optional already, so the client's meters and microphone
      // test read undefined and draw nothing rather than throwing — which is
      // the correct behaviour for a platform that cannot measure a level.
      return ownPipeline
        ? { mediaStream: micStream, processedStream: ownPipeline.output }
        : {};
    }

    if (!audioContext) {
      voiceLog.info("MIC", "No AudioContext yet — pipeline deferred");
      return {};
    }

    voiceLog.step("PIPELINE", 1, "Creating audio processing pipeline", {
      hasMicStream: !!micStream,
      micStreamTracks: micStream?.getAudioTracks().length ?? 0,
      rnnoiseActive: !!rnnoiseNode,
    });

    const buf = createMicrophoneBuffer({
      audioContext,
      micStream,
      rnnoiseNode,
      noiseGateNode,
      eSportsModeEnabled,
      autoGainEnabled,
      compressorEnabled,
    });

    voiceLog.ok("PIPELINE", 1, "Audio pipeline created", {
      hasProcessedStream: !!buf.processedStream,
      processedStreamTracks: buf.processedStream?.getAudioTracks().length ?? 0,
    });

    return buf;
  }, [
    platformPipeline,
    ownPipeline,
    audioContext,
    micStream,
    rnnoiseNode,
    noiseGateNode,
    eSportsModeEnabled,
    autoGainEnabled,
    compressorEnabled,
  ]);

  const { getVisualizerData } = usePipelineControls({
    microphoneBuffer,
    audioContext,
    micStream,
    micVolume,
    isMuted: effectiveMuted,
    noiseGate,
    noiseGateRelease,
    loopbackEnabled,
    inputMode,
    eSportsModeEnabled,
    autoGainEnabled,
    autoGainTargetDb,
    compressorAmount,
  });

  const { isPttActive, setActive: setPushToTalkActive } = usePushToTalkGate(
    microphoneBuffer,
    audioContext,
  );

  const getDevices = useCallback(async () => {
    if (platformPipeline) {
      // Nothing to enumerate. On a phone the input is an audio *route* — the
      // earpiece, the speaker, a connected headset — picked by the OS and
      // changed from Control Centre, not a device chosen from a list. Running
      // the enumeration path anyway would produce either an empty list or one
      // meaningless entry, and an empty list is read below as "no microphone".
      return;
    }

    if (!isBrowserSupported) return;

    try {
      const permissionStream = await platform.getMicrophone();

      try {
        permissionStream.getTracks().forEach((track) => track.stop());
      } catch {
        // ignore
      }

      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = allDevices.filter(
        (d) => d.kind === "audioinput",
      ) as InputDeviceInfo[];

      setDevices(audioDevices);

      // Permission can be granted with nothing plugged in, so an empty list is
      // its own failure rather than a variant of "denied".
      setMicUnavailable(audioDevices.length > 0 ? null : "no-device");

      if (audioDevices.length > 0) {
        let selectedDeviceId = micID;

        const fallbackDeviceId = pickDefaultDevice(audioDevices)?.deviceId;

        if (
          selectedDeviceId &&
          !audioDevices.find((d) => d.deviceId === selectedDeviceId)
        ) {
          selectedDeviceId = fallbackDeviceId;
        } else if (!selectedDeviceId) {
          selectedDeviceId = fallbackDeviceId;
        }

        if (selectedDeviceId !== currentDeviceId) {
          setCurrentDeviceId(selectedDeviceId);
        }
      }
    } catch (error) {
      console.error("Error enumerating devices:", error);
      // This is the earliest and most reliable place to learn there is no
      // usable microphone. The acquisition path below never even runs in that
      // case — with no device to select, nothing registers a microphone handle
      // — which is why a client with permission denied used to join voice
      // looking perfectly healthy.
      setMicUnavailable(classifyMicFailure(error));
    }
  }, [isBrowserSupported, currentDeviceId, micID]);

  useEffect(() => {
    if (micID && micID !== currentDeviceId) {
      setCurrentDeviceId(micID);
    }
  }, [micID, currentDeviceId]);

  // Re-enumerate when devices come and go, so plugging in headphones shows
  // them without reopening the app. useCamera does the same for video.
  useEffect(() => {
    if (!isBrowserSupported) return;
    if (!navigator.mediaDevices?.addEventListener) return;

    const handleDeviceChange = () => {
      voiceLog.info("MIC", "Input devices changed — re-enumerating");
      getDevices();
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange,
      );
    };
  }, [isBrowserSupported, getDevices]);

  useEffect(() => {
    if (handles.length > 0 && !currentDeviceId) {
      getDevices();
    }
  }, [handles.length, currentDeviceId, getDevices]);

  useEffect(() => {
    async function initializeDevice(deviceId: string | undefined) {
      // A platform with its own pipeline has no device list to have picked
      // from, so "no device id" is its normal state rather than a race with
      // enumeration. It means the platform default, which is exactly what
      // getMicrophone() with no argument asks for.
      if (!deviceId && !platformPipeline) {
        voiceLog.info("MIC", "No device ID — skipping initialization");
        // Not "no microphone". This runs during normal startup, before enumeration
        // has named a device, on machines that have one — reporting failure here
        // warned about a microphone that was about to work. getDevices and the
        // acquisition failure below are the signals that actually know.
        return;
      }

      voiceLog.step("MIC", 2, "Requesting getUserMedia", { deviceId });

      try {
        /* Shared rather than started again — but only for the same device.
           Sharing across a device change would hand back the microphone the
           caller has just stopped asking for. See `micRequestRef`. */
        const inFlight = micRequestRef.current;
        if (inFlight && inFlight.deviceId === deviceId) {
          voiceLog.info(
            "MIC",
            "A getUserMedia for this device is already in flight — waiting on it",
          );
        } else {
          micRequestRef.current = {
            deviceId,
            stream: platform.getMicrophone(deviceId),
          };
        }

        const request = micRequestRef.current!;
        let stream: MediaStream;
        try {
          stream = await request.stream;
        } finally {
          /* Only if it is still ours. A device change during the await has
             already replaced it, and clearing that would let the next caller
             start a third. */
          if (micRequestRef.current === request) micRequestRef.current = null;
        }

        const tracks = stream.getAudioTracks();

        voiceLog.ok("MIC", 2, "getUserMedia succeeded", {
          trackCount: tracks.length,
          tracks: tracks.map((t) => ({
            id: t.id,
            label: t.label,
            readyState: t.readyState,
          })),
        });

        const previous = micStreamRef.current;
        if (previous && previous !== stream) {
          previous.getTracks().forEach((track) => track.stop());
        }

        micStreamRef.current = stream;
        setMicStream(stream);
        setMicUnavailable(null);

        // Reports rather than writes: the engine does not own the setting. Nothing
        // to report when no device was named — that is the default path.
        if (deviceId && deviceId !== micID) {
          onAudioDeviceChanged?.(deviceId);
        }
      } catch (error) {
        voiceLog.fail(
          "MIC",
          2,
          `getUserMedia failed for device ${deviceId}`,
          error,
        );
        voiceLog.step("MIC", "2b", "Trying fallback (default device)");

        try {
          const fallbackStream = await platform.getMicrophone();

          voiceLog.ok("MIC", "2b", "Fallback getUserMedia succeeded", {
            tracks: fallbackStream.getAudioTracks().map((t) => ({
              id: t.id,
              label: t.label,
            })),
          });

          const previous = micStreamRef.current;
          if (previous && previous !== fallbackStream) {
            previous.getTracks().forEach((track) => track.stop());
          }

          micStreamRef.current = fallbackStream;
          setMicStream(fallbackStream);
          setMicUnavailable(null);
        } catch (fallbackError) {
          voiceLog.fail(
            "MIC",
            "2b",
            "Fallback getUserMedia also failed — no microphone!",
            fallbackError,
          );
          // This used to end here, so a client with no working microphone
          // joined voice looking entirely healthy while nobody could hear it.
          setMicUnavailable(classifyMicFailure(fallbackError));
        }
      }
    }

    if (handles.length > 0) {
      clearPendingMicRelease();

      // Not on a platform that builds its own graph. `activate` constructs an
      // `AudioContext`, and on React Native that is a ReferenceError rather
      // than a degraded pipeline — which would take the microphone down at the
      // moment somebody joins a channel.
      if (!platformPipeline) activateAudioContext();

      if (audioContext?.state === "suspended") {
        audioContext.resume().catch(() => {});
      }

      const existing = micStreamRef.current;
      const liveTrack = existing
        ?.getAudioTracks()
        .find((track) => track.readyState === "live");

      if (liveTrack) {
        // A live track isn't enough — it has to be the device the user picked,
        // otherwise selecting a new microphone silently keeps the old one.
        const activeDeviceId = liveTrack.getSettings().deviceId;

        // "default" is a moving target: it resolves to whatever the OS
        // currently considers default, so it can't be compared by id. Only
        // re-acquire when both ids are known and actually differ.
        const deviceMatches =
          !currentDeviceId ||
          currentDeviceId === "default" ||
          !activeDeviceId ||
          activeDeviceId === currentDeviceId;

        if (deviceMatches) {
          voiceLog.info(
            "MIC",
            `Active handles: ${handles.length} — keeping existing live microphone`,
          );
          return;
        }

        voiceLog.info(
          "MIC",
          `Selected device changed (${activeDeviceId} → ${currentDeviceId}) — re-acquiring`,
        );
        stopMicStream("Switching to the newly selected input device");
      }

      voiceLog.info(
        "MIC",
        `Active handles: ${handles.length} — initializing device`,
      );
      initializeDevice(currentDeviceId);
      return;
    }

    if (!micStreamRef.current) return;

    // No handles means no call, including while hidden — a call still holds one.
    // Special-casing hidden kept the microphone open on an idle minimised app
    // with the indicator lit. The grace period below covers the render churn.
    clearPendingMicRelease();

    releaseMicTimerRef.current = setTimeout(() => {
      if (handles.length === 0) {
        stopMicStream("No active handles — releasing microphone");
      }
    }, MIC_RELEASE_GRACE_MS);

    return () => {
      clearPendingMicRelease();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    handles.length,
    currentDeviceId,
    micRecoveryTick,
    activateAudioContext,
    audioContext,
    clearPendingMicRelease,
    stopMicStream,
    platformPipeline,
  ]);

  useEffect(() => {
    if (!micStream || handles.length === 0) return;

    const tracks = micStream.getAudioTracks();
    if (tracks.length === 0) return;

    const checkInterval = setInterval(() => {
      const currentTracks = micStream.getAudioTracks();
      const hasLiveTracks =
        currentTracks.length > 0 &&
        currentTracks.some((track) => track.readyState === "live");

      if (!hasLiveTracks && handles.length > 0) {
        voiceLog.warn(
          "MIC",
          "Microphone tracks are no longer live — reinitializing",
        );
        setMicStream(undefined);
        micStreamRef.current = undefined;
        setMicRecoveryTick((value) => value + 1);
      }

      if (audioContext?.state === "suspended" && handles.length > 0) {
        audioContext.resume().catch(() => {});
      }
    }, 1000);

    return () => {
      clearInterval(checkInterval);
    };
  }, [micStream, handles.length, audioContext]);

  return {
    addHandle,
    removeHandle,
    microphoneBuffer,
    isBrowserSupported,
    devices,
    audioContext,
    isLoaded,
    getDevices,
    getVisualizerData,
    getGateLevel,
    isTransmitting,
    isPttActive,
    setPushToTalkActive,
    micUnavailable,
  };
}

const init: MicrophoneInterface = {
  devices: [],
  isBrowserSupported: undefined,
  microphoneBuffer: {
    input: undefined,
    output: undefined,
    rawOutput: undefined,
    analyser: undefined,
    finalAnalyser: undefined,
    mediaStream: undefined,
    processedStream: undefined,
    muteGain: undefined,
    volumeGain: undefined,
    noiseGate: undefined,
    noiseGateWorklet: undefined,
    rnnoiseNode: undefined,
  },
  audioContext: undefined,
  addHandle: () => {},
  removeHandle: () => {},
  isLoaded: false,
  getDevices: async () => {},
  getVisualizerData: () => null,
  // Null until the gate worklet exists, so callers fall back to their own
  // measurement rather than treating "not transmitting" as fact.
  getGateLevel: () => null,
  isTransmitting: null,
  isPttActive: { current: false },
  setPushToTalkActive: () => {},
  micUnavailable: null,
};

const singletonMicrophone = singletonHook(init, useCreateMicrophoneHook);

export const useMicrophone = (shouldAccess: boolean = false) => {
  const mic = singletonMicrophone();
  const handleIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!shouldAccess) {
      if (handleIdRef.current) {
        mic.removeHandle(handleIdRef.current);
        handleIdRef.current = null;
      }

      return;
    }

    if (!handleIdRef.current) {
      const id = createHandleId();
      handleIdRef.current = id;
      mic.addHandle(id);
    }

    return () => {
      if (handleIdRef.current) {
        mic.removeHandle(handleIdRef.current);
        handleIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAccess]);

  return mic;
};
