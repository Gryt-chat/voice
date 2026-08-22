import { useCallback, useEffect, useRef, useState } from "react";

import { useVoiceCallbacks, useVoiceConfig } from "../../config";
import { singletonHook } from "../../shared/singletonHook";
import type { CameraFps, CaptureQuality } from "../../types";
import { createFlippedStream, type FlippedStream } from "../utils/flipVideoStream";

/** Kept as a name because call sites use it. One list, in types.ts. */
export type CameraQuality = CaptureQuality;

export type { CameraFps };
export const CAMERA_FPS_OPTIONS: CameraFps[] = [5, 10, 15, 24, 30, 60];

export const QUALITY_CONSTRAINTS: Record<CameraQuality, { width?: number; height?: number }> = {
  native: {},
  "4k": { width: 3840, height: 2160 },
  "1440p": { width: 2560, height: 1440 },
  "1080p": { width: 1920, height: 1080 },
  "720p": { width: 1280, height: 720 },
  "480p": { width: 854, height: 480 },
  "360p": { width: 640, height: 360 },
  "240p": { width: 426, height: 240 },
  "144p": { width: 256, height: 144 },
  "96p": { width: 170, height: 96 },
  "64p": { width: 114, height: 64 },
  "48p": { width: 85, height: 48 },
  "32p": { width: 57, height: 32 },
  "24p": { width: 43, height: 24 },
  "16p": { width: 28, height: 16 },
  "8p": { width: 14, height: 8 },
  "4p": { width: 7, height: 4 },
};

export interface CameraInterface {
  cameraStream: MediaStream | null;
  cameraEnabled: boolean;
  cameraError: string | null;
  setCameraEnabled: (enabled: boolean) => void;
  retryCamera: () => void;
  devices: MediaDeviceInfo[];
  getDevices: () => Promise<void>;
}

/**
 * The requests to try, hardest first.
 *
 * `width`, `height` and `frameRate` are asked for with `max` as well as
 * `ideal`, and `max` is a *required* constraint — only `ideal` is advisory. So
 * a camera whose modes cannot land at or below the cap fails the whole request
 * with an OverconstrainedError rather than giving back its nearest mode. On a
 * camera that advertises several resolutions this depends on which mode the
 * driver offers, which is why it fails only sometimes (GRYT-16).
 *
 * Rather than dropping the cap outright — it is what makes the quality setting
 * mean anything — the cap is tried first and given up one piece at a time:
 *
 * 1. everything, which is what this always sent
 * 2. no cap, so the camera may hand back a larger mode. `applyConstraints`
 *    below then tries to bring it down, and the sender's encoding cap is the
 *    backstop if it cannot
 * 3. no size or frame rate at all, just the camera that was asked for
 * 4. no camera either, for a stored device that is not there any more
 *
 * Only OverconstrainedError walks down this. Permission denied, no device and
 * a camera held by another app all fail the same way at every rung, so
 * retrying them would just be four identical failures and a slower error.
 */
function constraintLadder(
  cameraID: string | undefined,
  quality: { width?: number; height?: number },
  fps: number,
): MediaTrackConstraints[] {
  const device = cameraID ? { deviceId: { exact: cameraID } } : {};
  const size = quality.width
    ? {
        width: { ideal: quality.width, max: quality.width },
        height: { ideal: quality.height, max: quality.height },
      }
    : {};
  const sizeNoCap = quality.width
    ? { width: { ideal: quality.width }, height: { ideal: quality.height } }
    : {};

  const rungs: MediaTrackConstraints[] = [
    { ...device, ...size, frameRate: { ideal: fps, max: fps } },
    { ...device, ...sizeNoCap, frameRate: { ideal: fps } },
    { ...device },
  ];

  // Only worth a fourth rung when a specific camera was named; without one the
  // third rung is already "any camera".
  if (cameraID) rungs.push({});

  return rungs;
}

/**
 * By name rather than by `instanceof DOMException`, because
 * `react-native-webrtc` rejects with a plain object carrying the same `name`
 * and there is no DOMException to test against on that runtime.
 */
function isOverconstrained(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "OverconstrainedError";
}

/**
 * Bring a track down to the cap after the fact, where asking for it up front
 * was refused.
 *
 * Best effort on purpose: this runs only on a rung that already gave us a
 * working camera, so a rejection here means keeping a track that is larger
 * than asked for, which is better than no camera at all. The outbound encoding
 * cap still applies to what actually goes out.
 */
async function tryApplyCap(
  track: MediaStreamTrack,
  quality: { width?: number; height?: number },
  fps: number,
): Promise<void> {
  if (!quality.width) return;
  if (typeof track.applyConstraints !== "function") return;

  try {
    await track.applyConstraints({
      width: { max: quality.width },
      height: { max: quality.height },
      frameRate: { max: fps },
    });
  } catch (error) {
    console.warn("[Camera] Could not cap the track after opening it", error);
  }
}

function friendlyCameraError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotReadableError":
    case "AbortError":
      return "Failed to start camera — is it in use by another application?";
    case "NotAllowedError":
      return "Camera access was denied. Check your browser or system permissions.";
    case "NotFoundError":
      return "No camera detected. Make sure one is connected.";
    case "OverconstrainedError":
      return "Camera doesn't support the selected quality. Try a lower setting.";
    default:
      return "Failed to start camera. Please try again.";
  }
}

function useCameraHook(): CameraInterface {
  const {
    deviceId: cameraID,
    quality: cameraQuality,
    mirrored: cameraFlipped,
    fps: cameraFps,
  } = useVoiceConfig().camera;
  const { onCameraDeviceChanged } = useVoiceCallbacks();
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraEnabled, setCameraEnabledState] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const flippedRef = useRef<FlippedStream | null>(null);

  const getDevices = useCallback(async () => {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = allDevices.filter((d) => d.kind === "videoinput");
      setDevices(videoDevices);

      if (videoDevices.length > 0 && !cameraID) {
        onCameraDeviceChanged?.(videoDevices[0].deviceId);
      }
    } catch {
      // Permission denied or no devices
    }
  }, [cameraID, onCameraDeviceChanged]);

  // Listen for hot-plug
  useEffect(() => {
    /* Only where there is something to listen on. `react-native-webrtc`'s
     * `mediaDevices` has no `addEventListener`, and this hook runs at mount as
     * one of the singletons — so an unguarded call took the whole app down on
     * React Native rather than quietly doing nothing (GRYT-439). The same shape
     * as `useMicrophone`'s guard, which has always had one. */
    if (typeof navigator?.mediaDevices?.addEventListener !== "function") return;

    const handler = () => { getDevices(); };
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
  }, [getDevices]);

  const applyFlip = useCallback((rawStream: MediaStream, flip: boolean) => {
    if (flippedRef.current) {
      flippedRef.current.stop();
      flippedRef.current = null;
    }
    if (flip) {
      const flipped = createFlippedStream(rawStream);
      flippedRef.current = flipped;
      setCameraStream(flipped.stream);
    } else {
      setCameraStream(rawStream);
    }
  }, []);

  const startCamera = useCallback(async () => {
    const quality = QUALITY_CONSTRAINTS[cameraQuality as CameraQuality] ?? QUALITY_CONSTRAINTS.native;
    const fps = cameraFps || 30;
    const rungs = constraintLadder(cameraID, quality, fps);

    const oldTrackId = streamRef.current?.getVideoTracks()[0]?.id;
    console.log("[Camera] startCamera called", {
      quality: cameraQuality,
      constraints: rungs[0],
      oldStreamId: streamRef.current?.id,
      oldTrackId,
    });

    let stream: MediaStream | null = null;
    let rungUsed = 0;
    let lastError: unknown = null;

    for (let rung = 0; rung < rungs.length; rung++) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: rungs[rung],
          audio: false,
        });
        rungUsed = rung;
        break;
      } catch (error) {
        lastError = error;
        if (!isOverconstrained(error)) break;
        console.warn(
          `[Camera] Constraints refused at rung ${rung}, trying a looser set`,
          { constraints: rungs[rung], error },
        );
      }
    }

    if (!stream) {
      console.error("[Camera] getUserMedia failed:", lastError);
      setCameraError(friendlyCameraError(lastError));
      setCameraEnabledState(false);
      return;
    }

    const newTrack = stream.getVideoTracks()[0];
    if (newTrack) newTrack.contentHint = "motion";

    // The cap was refused up front, so ask for it now that there is a track to
    // ask on. Failing here leaves a camera that is bigger than requested,
    // which is the trade this whole ladder is making.
    if (rungUsed > 0 && newTrack) {
      await tryApplyCap(newTrack, quality, fps);
    }

    const settings = newTrack?.getSettings();
    console.log("[Camera] getUserMedia succeeded", {
      rung: rungUsed,
      streamId: stream.id,
      trackId: newTrack?.id,
      trackReadyState: newTrack?.readyState,
      actualWidth: settings?.width,
      actualHeight: settings?.height,
      actualFrameRate: settings?.frameRate,
    });

    if (streamRef.current) {
      console.log("[Camera] Stopping old tracks", { oldStreamId: streamRef.current.id });
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = stream;
    applyFlip(stream, cameraFlipped);
    setCameraError(null);

    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = allDevices.filter((d) => d.kind === "videoinput");
    setDevices(videoDevices);

    const actualDevice = settings?.deviceId;
    if (actualDevice && actualDevice !== cameraID) {
      onCameraDeviceChanged?.(actualDevice);
    }
  }, [cameraID, cameraQuality, cameraFlipped, cameraFps, onCameraDeviceChanged, applyFlip]);

  const stopCamera = useCallback(() => {
    if (flippedRef.current) {
      flippedRef.current.stop();
      flippedRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraStream(null);
  }, []);

  const setCameraEnabled = useCallback((enabled: boolean) => {
    setCameraEnabledState(enabled);
    if (enabled) {
      setCameraError(null);
      startCamera();
    } else {
      stopCamera();
    }
  }, [startCamera, stopCamera]);

  const retryCamera = useCallback(() => {
    setCameraError(null);
    setCameraEnabledState(true);
    startCamera();
  }, [startCamera]);

  // Restart when device, quality, or fps changes while camera is on
  useEffect(() => {
    console.log("[Camera] Quality/device/fps change effect", {
      cameraEnabled,
      cameraID,
      cameraQuality,
      cameraFps,
      willRestart: cameraEnabled && !!cameraID,
    });
    if (cameraEnabled && cameraID) {
      startCamera();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraID, cameraQuality, cameraFps]);

  // Rebuild flip pipeline when cameraFlipped changes while camera is on
  useEffect(() => {
    if (cameraEnabled && streamRef.current) {
      applyFlip(streamRef.current, cameraFlipped);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraFlipped]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (flippedRef.current) {
        flippedRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return {
    cameraStream,
    cameraEnabled,
    cameraError,
    setCameraEnabled,
    retryCamera,
    devices,
    getDevices,
  };
}

const cameraInit: CameraInterface = {
  cameraStream: null,
  cameraEnabled: false,
  cameraError: null,
  setCameraEnabled: () => {},
  retryCamera: () => {},
  devices: [],
  getDevices: async () => {},
};

export const useCamera = singletonHook(cameraInit, useCameraHook);
