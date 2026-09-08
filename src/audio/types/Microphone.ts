import type { MutableRefObject } from "react";

export type MicrophoneBufferType = {
  input?: GainNode;
  output?: MediaStreamAudioSourceNode;
  rawOutput?: GainNode; // Raw audio output for monitoring (before noise gate)
  analyser?: AnalyserNode; // Raw audio analyser (for noise gate threshold detection)
  finalAnalyser?: AnalyserNode; // Final processed audio analyser (for UI and loopback)
  mediaStream?: MediaStream; // Raw microphone stream
  processedStream?: MediaStream; // Processed stream (after noise suppression, mute, etc.)
  monitorTap?: GainNode; // Fully processed audio, tapped before muteGain, for the microphone test
  monitorAnalyser?: AnalyserNode; // Level of that same tap, for the settings meter
  muteGain?: GainNode; // Dedicated gain node for muting
  volumeGain?: GainNode; // Dedicated gain node for volume control
  noiseGate?: GainNode; // Fallback gain node, used only when the gate worklet is unavailable
  noiseGateWorklet?: AudioWorkletNode; // Noise gate running on the audio thread
  rnnoiseNode?: AudioWorkletNode; // RNNoise noise reduction (AudioWorklet)
  agcAnalyser?: AnalyserNode; // AGC input level measurement
  agcGain?: GainNode; // AGC dynamic gain adjustment
  compressor?: DynamicsCompressorNode; // Separate compressor for peak taming
  /** Makeup gain after the compressor, so taming peaks does not just get
   *  quieter. Absent when the compressor is off (GRYT-511). */
  compressorMakeup?: GainNode;
};

/**
 * Why the microphone could not be acquired, kept apart because the advice differs: "denied"
 * is fixed in the OS, "no-device" means nothing is plugged in, "failed" is everything else.
 */
export type MicrophoneUnavailableReason = "denied" | "no-device" | "failed";

export interface MicrophoneInterface {
  addHandle: (id: string) => void;
  removeHandle: (id: string) => void;
  /**
   * Set while there is no usable microphone, null once one is live. Joining still works —
   * listening without a microphone is useful — so this is what lets the UI say so.
   */
  micUnavailable: MicrophoneUnavailableReason | null;
  /**
   * True while a `getUserMedia` is out and has not come back. A request in flight deserves
   * patience; no request at all deserves none, and one timeout for both is wrong either way.
   */
  isAcquiring: boolean;
  microphoneBuffer: MicrophoneBufferType;
  isBrowserSupported: boolean | undefined;
  devices: InputDeviceInfo[];
  audioContext?: AudioContext;
  isLoaded: boolean;
  getDevices: () => Promise<void>;
  getVisualizerData: () => Uint8Array | null;
  /** Level the noise gate is deciding on, 0-100. Null if the gate worklet is unavailable. */
  getGateLevel: () => number | null;
  /** True while audio is actually leaving this client. Null if the gate worklet is unavailable. */
  isTransmitting: boolean | null;
  isPttActive: MutableRefObject<boolean>;
  /**
   * Opens and closes the transmit gate in push-to-talk mode. The embedder owns the trigger
   * and calls this; a no-op in voice-activity mode.
   */
  setPushToTalkActive: (active: boolean) => void;
}
