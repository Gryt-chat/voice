/**
 * Native capture, where the platform has it.
 *
 * Narrow on purpose: the methods this package actually calls, and a way to ask
 * whether they exist at all. Taking a whole Electron bridge instead would tie
 * the package to Electron and make a React Native adapter implement a desktop
 * API it has no use for.
 *
 * The Gryt desktop client satisfies this with its Electron bridge, React Native
 * with its own native modules, and a browser by returning null and letting the
 * getUserMedia path run.
 */

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

/**
 * What the embedder provides.
 *
 * Both capture surfaces are optional and independent: a platform may have one
 * and not the other, and returning null is a normal answer rather than a
 * failure. Callers fall back to the standard web capture path.
 */
export interface VoiceHost {
  /** Whether native capture is available at all. */
  hasNativeCapture(): boolean;
  getNativeAudio(): NativeAudioCapture | null;
  getNativeScreen(): NativeScreenCapture | null;

  /**
   * Whether a plain ws:// or http:// connection is allowed to a private
   * address.
   *
   * A separate question from native capture, and conflating the two is a real
   * mistake rather than a tidy shortcut. The client asked `isElectron()` for
   * both, which happens to give the right answer on the desktop because one
   * runtime supplies both properties — but they are unrelated, and React Native
   * is the counterexample: it has native capture *and* no mixed-content rule,
   * while a browser has neither, and a hypothetical native module in a web page
   * would have the first and not the second.
   *
   * What is really being asked is "am I inside a browser's mixed-content
   * sandbox", which is why LAN servers on plain ws:// are reachable from the
   * desktop app and invisible from app.gryt.chat.
   */
  allowsInsecureTransport(): boolean;
}

/**
 * The default: no native capture, everything goes through getUserMedia.
 *
 * This is what a browser gets, and what anything that has not supplied a host
 * gets, so forgetting to pass one degrades to the web path rather than
 * throwing.
 */
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
