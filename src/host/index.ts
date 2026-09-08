
export interface NativeScreenFrame {
  width: number;
  height: number;
  timestampUs: number;
  data: ArrayBuffer;
}

export interface NativeAudioCapture {
  isNativeAudioCaptureAvailable(): Promise<boolean>;
  startNativeAudioCapture(sourceId?: string): Promise<boolean>;
  stopNativeAudioCapture(): void;
  onNativeAudioData(callback: (pcm: ArrayBuffer) => void): () => void;
  onNativeAudioStopped(callback: () => void): () => void;
  onNativeAudioDiagnostic(callback: (msg: string) => void): () => void;
}

export interface NativeScreenCapture {
  isNativeScreenCaptureAvailable(): Promise<boolean>;
  startNativeScreenCapture(
    monitorIndex: number,
    fps: number,
    maxWidth?: number,
    maxHeight?: number,
    bitrate?: number,
    codec?: string,
  ): Promise<{ success: boolean; wsPort?: number }>;
  stopNativeScreenCapture(): void;
  onNativeScreenFrame(callback: (frame: NativeScreenFrame) => void): () => void;
  onNativeScreenCaptureStopped(callback: () => void): () => void;
}

export interface VoiceHost {
  /** Whether native capture is available at all. */
  hasNativeCapture(): boolean;
  getNativeAudio(): NativeAudioCapture | null;
  getNativeScreen(): NativeScreenCapture | null;

  /* Not the same question as native capture, and `isElectron()` answering both is a
     coincidence: this asks whether we are inside a browser's mixed-content sandbox. */
  allowsInsecureTransport(): boolean;
}

export const webHost: VoiceHost = {
  hasNativeCapture: () => false,
  getNativeAudio: () => null,
  getNativeScreen: () => null,
  // A browser is exactly the thing the mixed-content rule applies to.
  allowsInsecureTransport: () => false,
};

let current: VoiceHost = webHost;

/** Called once by the embedder, before any voice code runs. */
export function setVoiceHost(host: VoiceHost): void {
  current = host;
}

export function getVoiceHost(): VoiceHost {
  return current;
}
