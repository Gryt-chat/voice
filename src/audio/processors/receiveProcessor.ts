import { RECEIVE_DSP_CODE } from "./receiveDspCode";

export const RECEIVE_PROCESSOR_NAME = "gryt-receive-dsp-v1";
export const RECEIVE_WORKLET_CODE = RECEIVE_DSP_CODE + `
const EMPTY_CHANNELS = [];
class ReceiveProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {name:"enabled", defaultValue:0, minValue:0, maxValue:1, automationRate:"k-rate"},
      {name:"muted", defaultValue:0, minValue:0, maxValue:1, automationRate:"k-rate"}
    ];
  }
  constructor(options) {
    super();
    this.core = options.processorOptions.kind === "leveler"
      ? new ReceiveLeveler(sampleRate) : new ReceiveLimiter(sampleRate);
    this.port.onmessage = event => {
      if (event.data === "dispose") { this.disposed = true; this.port.close(); }
    };
    this.disposed = false;
    this.kind = options.processorOptions.kind;
    this.wasMuted = false;
  }
  process(inputs, outputs, parameters) {
    if (this.disposed) return false;
    const muted = parameters.muted[0] >= 0.5;
    if (muted) {
      if (!this.wasMuted) this.core.reset();
      this.wasMuted = true;
      for (const channel of outputs[0]) channel.fill(0);
      return true;
    }
    this.wasMuted = false;
    this.core.process(inputs[0] || EMPTY_CHANNELS, outputs[0], parameters.enabled[0] >= 0.5);
    return true;
  }
}
registerProcessor("${RECEIVE_PROCESSOR_NAME}", ReceiveProcessor);
`;

const loads = new WeakMap<BaseAudioContext, Promise<void>>();
export function loadReceiveProcessor(context: BaseAudioContext): Promise<void> {
  const pending = loads.get(context);
  if (pending) return pending;
  const url = URL.createObjectURL(new Blob([RECEIVE_WORKLET_CODE], { type: "application/javascript" }));
  const result = Promise.resolve().then(() => context.audioWorklet.addModule(url))
    .finally(() => URL.revokeObjectURL(url));
  loads.set(context, result);
  void result.catch(() => loads.delete(context));
  return result;
}
