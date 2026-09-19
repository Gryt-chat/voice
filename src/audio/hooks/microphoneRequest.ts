export interface MicrophoneRequest {
  deviceId: string | undefined;
}

export type MicrophoneAcquireResult =
  | {
      status: "ready";
      stream: MediaStream;
      source: "selected" | "fallback";
    }
  | {
      status: "failed";
      primaryError: unknown;
      fallbackError: unknown;
    }
  | {
      status: "stale";
    };

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

/**
 * One selected-device attempt plus its fallback, tied to one request identity.
 * A superseded request may still settle, but it may not publish or start a fallback.
 */
export async function acquireMicrophoneForRequest(
  request: MicrophoneRequest,
  currentRequest: () => MicrophoneRequest | null,
  getMicrophone: (deviceId?: string) => Promise<MediaStream>,
  onPrimaryFailure?: (error: unknown) => void,
): Promise<MicrophoneAcquireResult> {
  let primaryError: unknown;

  try {
    const stream = await getMicrophone(request.deviceId);
    if (currentRequest() !== request) {
      stopStream(stream);
      return { status: "stale" };
    }
    return { status: "ready", stream, source: "selected" };
  } catch (error) {
    primaryError = error;
    if (currentRequest() !== request) {
      return { status: "stale" };
    }
    onPrimaryFailure?.(error);
  }

  try {
    const stream = await getMicrophone();
    if (currentRequest() !== request) {
      stopStream(stream);
      return { status: "stale" };
    }
    return { status: "ready", stream, source: "fallback" };
  } catch (fallbackError) {
    if (currentRequest() !== request) {
      return { status: "stale" };
    }
    return { status: "failed", primaryError, fallbackError };
  }
}
