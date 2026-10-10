import { loadReceiveProcessor, RECEIVE_PROCESSOR_NAME } from "../processors/receiveProcessor";

export interface ReceiveLevelingState {
  status: "disabled" | "loading" | "active" | "degraded" | "suspended";
  reason?: string;
  /** Maximum added DSP delay among the currently attached routes, excluding device/WebRTC delay. */
  latencyMs: number;
}
export type ReceiveAudioRole = "microphone" | "screen" | "unknown";
export interface ReceiveStreamControl {
  setRole(role: ReceiveAudioRole): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

const controllers = new WeakMap<AudioContext, ReceiveController>();
const CEILING = Math.pow(10, -3 / 20);
const curve = new Float32Array(4097);
const silentCurve = new Float32Array(2);
for (let i = 0; i < curve.length; ++i) {
  const x = 2 * i / (curve.length - 1) - 1;
  curve[i] = Math.max(-CEILING, Math.min(CEILING, x));
}

function disposeNode(node?: AudioWorkletNode) {
  if (!node) return;
  node.onprocessorerror = null;
  node.port.postMessage("dispose");
  node.port.close();
  node.disconnect();
}

function worklet(context: AudioContext, kind: "leveler" | "limiter", enabled: boolean) {
  return new AudioWorkletNode(context, RECEIVE_PROCESSOR_NAME, {
    numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit",
    outputChannelCount: [2], parameterData: { enabled: enabled ? 1 : 0 },
    processorOptions: { kind },
  });
}

export class ReceiveController {
  readonly bus: GainNode;
  private guard: WaveShaperNode;
  private busLimiter?: AudioWorkletNode;
  private chains = new Set<ReceiveRoute>();
  private listeners = new Set<(state: ReceiveLevelingState) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private loading = false;
  private disposed = false;
  private retryMs = 1000;
  private failure?: string;
  private generation = 0;
  private muted = false;
  enabled: boolean;
  state: ReceiveLevelingState;

  constructor(readonly context: AudioContext, enabled: boolean) {
    this.enabled = enabled;
    this.state = { status: enabled ? "loading" : "disabled", latencyMs: 0 };
    this.bus = context.createGain();
    this.guard = context.createWaveShaper();
    this.guard.curve = this.muted ? silentCurve : enabled ? curve : null;
    this.bus.connect(this.guard);
    this.guard.connect(context.destination);
    context.addEventListener("statechange", this.contextChanged);
    if (enabled) void this.recover();
  }

  private contextChanged = () => {
    this.publish();
    if (this.context.state === "running" && this.enabled) void this.recover();
  };

  subscribe(listener: (state: ReceiveLevelingState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  private publish() {
    const streamDelay = [...this.chains].some(route => route.healthy) ? 3 : 0;
    const delay = Math.ceil(this.context.sampleRate * 0.003) / this.context.sampleRate * 1000;
    const healthy = Boolean(this.busLimiter) && [...this.chains].every(route => route.healthy);
    const state: ReceiveLevelingState = {
      status: !this.enabled ? "disabled" : this.context.state !== "running" ? "suspended"
        : this.failure ? "degraded" : this.loading ? "loading" : healthy ? "active" : "loading",
      latencyMs: (this.busLimiter ? delay : 0) + (streamDelay ? delay : 0),
      reason: this.enabled && this.context.state !== "running" ? "audio-context-" + this.context.state
        : this.enabled ? this.failure : undefined,
    };
    if (state.status === this.state.status && state.reason === this.state.reason && state.latencyMs === this.state.latencyMs) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  setEnabled(enabled: boolean) {
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled;
    this.guard.curve = this.muted ? silentCurve : enabled ? curve : null;
    this.busLimiter?.parameters.get("enabled")?.setValueAtTime(enabled ? 1 : 0, this.context.currentTime);
    for (const route of this.chains) route.setEnabled(enabled);
    this.publish();
    if (enabled) void this.recover();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.guard.curve = muted ? silentCurve : this.enabled ? curve : null;
    this.busLimiter?.parameters.get("muted")?.setValueAtTime(muted ? 1 : 0, this.context.currentTime);
  }

  attach(input: AudioNode, manual: GainNode): ReceiveRoute {
    const route = new ReceiveRoute(this, input, manual);
    this.chains.add(route);
    this.publish();
    if (this.enabled || this.busLimiter) void this.recover();
    return route;
  }

  remove(route: ReceiveRoute) {
    this.chains.delete(route);
    this.publish();
  }

  fail(reason: string) {
    if (this.disposed) return;
    ++this.generation;
    this.failure = reason;
    // Drop all adaptive gain when any worklet dies; the surviving clamp limits the summed bus.
    for (const route of this.chains) route.fallback();
    this.bus.disconnect();
    disposeNode(this.busLimiter);
    this.busLimiter = undefined;
    this.bus.connect(this.guard);
    this.publish();
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.timer || this.disposed || !this.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.recover();
    }, this.retryMs);
    this.retryMs = Math.min(30000, this.retryMs * 2);
  }

  async recover() {
    if (this.disposed || this.loading || this.context.state === "closed") return;
    if (this.busLimiter && [...this.chains].every(route => route.healthy)) return;
    const generation = this.generation;
    this.loading = true;
    this.publish();
    try {
      await loadReceiveProcessor(this.context);
      if (this.disposed || generation !== this.generation) return;
      if (!this.busLimiter) {
        const limiter = worklet(this.context, "limiter", this.enabled);
        limiter.onprocessorerror = () => this.fail("bus-processor-error");
        this.bus.disconnect();
        this.bus.connect(limiter);
        limiter.connect(this.guard);
        this.busLimiter = limiter;
        this.setMuted(this.muted);
      }
      for (const route of this.chains) if (!route.healthy) route.activate();
      this.failure = undefined;
      this.retryMs = 1000;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    } catch {
      this.fail("worklet-unavailable");
    } finally {
      this.loading = false;
      this.publish();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.context.removeEventListener("statechange", this.contextChanged);
    for (const route of [...this.chains]) route.dispose();
    this.bus.disconnect();
    disposeNode(this.busLimiter);
    this.guard.disconnect();
    this.listeners.clear();
    controllers.delete(this.context);
  }
}

export class ReceiveRoute implements ReceiveStreamControl {
  private leveler?: AudioWorkletNode;
  private limiter?: AudioWorkletNode;
  private guard: WaveShaperNode;
  private fallbackGain: GainNode;
  private disposed = false;
  private role: ReceiveAudioRole = "unknown";
  private muted = false;
  get healthy() { return Boolean(this.leveler && this.limiter); }

  constructor(private owner: ReceiveController, private input: AudioNode, private manual: GainNode) {
    this.guard = owner.context.createWaveShaper();
    this.fallbackGain = owner.context.createGain();
    this.guard.connect(owner.bus);
    this.fallback();
  }
  setEnabled(enabled: boolean) {
    this.guard.curve = this.muted ? silentCurve : enabled ? curve : null;
    this.fallbackGain.gain.setTargetAtTime(enabled ? 0.5 : 1, this.owner.context.currentTime, 0.005);
    this.leveler?.parameters.get("enabled")?.setValueAtTime(enabled && this.role === "microphone" ? 1 : 0, this.owner.context.currentTime);
    this.limiter?.parameters.get("enabled")?.setValueAtTime(enabled ? 1 : 0, this.owner.context.currentTime);
  }
  setRole(role: ReceiveAudioRole) {
    this.role = role;
    this.setEnabled(this.owner.enabled);
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    this.setEnabled(this.owner.enabled);
    for (const node of [this.leveler, this.limiter]) {
      node?.parameters.get("muted")?.setValueAtTime(muted ? 1 : 0, this.owner.context.currentTime);
    }
  }
  fallback() {
    if (this.disposed) return;
    this.input.disconnect();
    this.manual.disconnect();
    this.fallbackGain.disconnect();
    disposeNode(this.leveler);
    disposeNode(this.limiter);
    this.leveler = this.limiter = undefined;
    this.fallbackGain.gain.value = this.owner.enabled ? 0.5 : 1;
    this.input.connect(this.fallbackGain);
    this.fallbackGain.connect(this.manual);
    this.manual.connect(this.guard);
    this.setEnabled(this.owner.enabled);
  }
  activate() {
    if (this.disposed || this.healthy) return;
    const context = this.owner.context;
    let leveler: AudioWorkletNode | undefined;
    let limiter: AudioWorkletNode | undefined;
    try {
      leveler = worklet(context, "leveler", this.owner.enabled && this.role === "microphone");
      limiter = worklet(context, "limiter", this.owner.enabled);
      leveler.onprocessorerror = limiter.onprocessorerror = () => this.owner.fail("stream-processor-error");
      this.input.disconnect();
      this.fallbackGain.disconnect();
      this.manual.disconnect();
      this.input.connect(leveler);
      leveler.connect(this.manual);
      this.manual.connect(limiter);
      limiter.connect(this.guard);
      this.leveler = leveler;
      this.limiter = limiter;
      this.setMuted(this.muted);
    } catch (error) {
      disposeNode(leveler);
      disposeNode(limiter);
      this.fallback();
      throw error;
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.input.disconnect();
    this.manual.disconnect();
    this.fallbackGain.disconnect();
    this.guard.disconnect();
    disposeNode(this.leveler);
    disposeNode(this.limiter);
    this.owner.remove(this);
  }
}

export function getReceiveController(context: AudioContext, enabled = false) {
  let controller = controllers.get(context);
  if (!controller) {
    controller = new ReceiveController(context, enabled);
    controllers.set(context, controller);
  }
  return controller;
}
