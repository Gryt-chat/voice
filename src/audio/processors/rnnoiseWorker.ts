import { DenoiseState,Rnnoise } from '@shiguredo/rnnoise-wasm';

let denoiseState: DenoiseState | null = null;
const FRAME_SIZE = 480;
const PCM_SCALE = 32768;

async function init() {
  const rnnoise = await Rnnoise.load();
  denoiseState = rnnoise.createDenoiseState();
  self.postMessage({ type: 'ready' });
}

function processFrame(frame: Float32Array, replyPort: MessagePort) {
  if (frame.length !== FRAME_SIZE || !denoiseState) return;

  for (let i = 0; i < FRAME_SIZE; i++) frame[i] *= PCM_SCALE;
  denoiseState.processFrame(frame);
  for (let i = 0; i < FRAME_SIZE; i++) frame[i] /= PCM_SCALE;

  replyPort.postMessage(
    { type: 'processed', frame: frame.buffer },
    [frame.buffer as ArrayBuffer],
  );
}

self.onmessage = (event: MessageEvent) => {
  const { type } = event.data;

  if (type === 'init') {
    init().catch((err) => {
      self.postMessage({ type: 'error', message: String(err) });
    });
    return;
  }

  if (type === 'worker-port') {
    const port: MessagePort = event.ports[0];
    port.onmessage = (e) => {
      if (e.data.type === 'frame') {
        processFrame(new Float32Array(e.data.frame), port);
      }
    };
    return;
  }

  if (type === 'destroy') {
    denoiseState?.destroy();
    denoiseState = null;
  }
};
