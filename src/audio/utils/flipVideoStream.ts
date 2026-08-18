/**
 * Creates a horizontally-flipped copy of a video MediaStream using a hidden
 * canvas. The returned stream can be sent via WebRTC so peers see the flipped
 * image. Call `stop()` to tear down the pipeline and release resources.
 */
export interface FlippedStream {
  stream: MediaStream;
  stop: () => void;
}

export function createFlippedStream(source: MediaStream): FlippedStream {
  const sourceTrack = source.getVideoTracks()[0];
  if (!sourceTrack) {
    return { stream: source, stop: () => {} };
  }

  const settings = sourceTrack.getSettings();
  const width = settings.width || 640;
  const height = settings.height || 480;
  const fps = settings.frameRate || 30;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  const video = document.createElement("video");
  video.srcObject = source;
  video.muted = true;
  video.playsInline = true;
  video.play().catch(() => {});

  let stopped = false;
  let animId = 0;

  const draw = () => {
    if (stopped) return;
    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
    animId = requestAnimationFrame(draw);
  };

  const flippedStream = canvas.captureStream(fps);

  video.addEventListener("loadedmetadata", () => {
    draw();
  });

  if (video.readyState >= 2) {
    draw();
  }

  const stop = () => {
    stopped = true;
    cancelAnimationFrame(animId);
    video.pause();
    video.srcObject = null;
    flippedStream.getTracks().forEach((t) => t.stop());
  };

  return { stream: flippedStream, stop };
}
