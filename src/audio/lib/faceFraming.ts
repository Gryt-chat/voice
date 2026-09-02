/**
 * Where a face sits in the frame, as a fraction of width and height.
 *
 * 0.5, 0.5 is dead centre and is what everything falls back to. These map
 * straight onto CSS object-position on the receiving side, which is the whole
 * reason the value is normalised rather than in pixels: the receiver's tile is
 * a different size and shape from the sender's camera.
 */
export type Framing = { x: number; y: number };

export const CENTRED: Framing = { x: 0.5, y: 0.5 };

/**
 * Inference happens on a frame this wide.
 *
 * Was 192, which is thin for somebody at a desk: at 16:9 that is 192x108, so a
 * face at normal sitting distance is about 30 pixels across, and BlazeFace
 * short range is built for selfie distance where the face fills the frame.
 * 320 costs a little more per sample and gives the model something to work
 * with at the distance people actually sit.
 */
const SAMPLE_WIDTH = 320;

/** Below this, the detection is not trusted enough to move anyone's crop. */
export const MIN_CONFIDENCE = 0.5;

/**
 * How long to keep looking, and how often.
 *
 * One frame was the old behaviour and the reason this feature picked the wrong
 * spot: it sampled immediately after play(), before auto exposure and focus had
 * settled, and nothing existed to disagree with a bad result. See GRYT-852.
 *
 * Two seconds is long enough to ride out a blink, a turn of the head or a
 * camera still adjusting, and short enough that the button does not feel
 * broken. The button disables itself while this runs.
 */
const SAMPLE_COUNT = 10;
const SAMPLE_INTERVAL_MS = 180;

/**
 * Frames thrown away before sampling starts.
 *
 * Cameras open dark and adjust over the first few hundred milliseconds. The old
 * code looked at exactly the frame this skips.
 */
const WARMUP_MS = 300;

/**
 * How many samples have to find a face before the crop is allowed to move.
 *
 * The point is that one detection scraping past MIN_CONFIDENCE is not enough.
 * Three agreeing is not a strong claim, but it is a claim rather than a guess,
 * and the cost of being wrong is everybody watching a badly cropped tile.
 */
export const MIN_SAMPLES = 3;

type Detector = {
  detect: (source: HTMLCanvasElement) => {
    detections: Array<{
      categories?: Array<{ score: number }>;
      boundingBox?: {
        originX: number;
        originY: number;
        width: number;
        height: number;
      };
    }>;
  };
  close: () => void;
};

let detectorPromise: Promise<Detector | null> | null = null;

/**
 * Loads the model once per session, and only when something asks for it.
 *
 * The import is dynamic so the 12 MB of WASM stays out of the main bundle for
 * everyone who never turns this on.
 */
async function getDetector(): Promise<Detector | null> {
  if (detectorPromise) return detectorPromise;

  detectorPromise = (async () => {
    try {
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks("/mediapipe");
      const detector = await vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: "/models/blaze_face_short_range.tflite",
          delegate: "GPU",
        },
        // IMAGE rather than VIDEO: this runs once when asked, not per frame,
        // so there is no timestamped stream for the model to track across.
        runningMode: "IMAGE",
        minDetectionConfidence: MIN_CONFIDENCE,
      });
      return detector as unknown as Detector;
    } catch (err) {
      console.warn("[FaceFraming] detector unavailable:", err);
      return null;
    }
  })();

  return detectorPromise;
}

/** One frame's answer: where the largest face was, and how sure the model was. */
export type FramingSample = Framing & { score: number };

/**
 * Turns a run of samples into one framing, or refuses to answer.
 *
 * Split out from the camera work on purpose. This is the part most likely to be
 * wrong and the only part that can be checked without a webcam and a 12 MB
 * model, so `check-face-framing.mjs` drives it directly.
 *
 * The median rather than the mean, per axis. A mean lets one frame that found a
 * face in a bookshelf drag the result halfway across the picture; a median
 * ignores it entirely as long as most frames agree. That is the whole reason
 * this samples more than once.
 *
 * Axes are taken independently. They could disagree in principle, but a
 * detection wrong enough for that is already excluded by the count below.
 */
export function combineSamples(samples: readonly FramingSample[]): Framing | null {
  const usable = samples.filter(
    (s) =>
      s.score >= MIN_CONFIDENCE &&
      Number.isFinite(s.x) &&
      Number.isFinite(s.y) &&
      s.x >= 0 &&
      s.x <= 1 &&
      s.y >= 0 &&
      s.y <= 1,
  );

  // Not enough to be a claim. The caller leaves the framing where it was
  // rather than snapping to centre, so a failed detection costs nothing.
  if (usable.length < MIN_SAMPLES) return null;

  return { x: median(usable.map((s) => s.x)), y: median(usable.map((s) => s.y)) };
}

/** Even counts average the middle pair, which is the ordinary definition. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Waits, without holding a timer anybody has to clean up. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * One frame, and the largest face in it.
 *
 * The largest face wins. With two people at one camera, following the nearer
 * one is at least a rule rather than a coin toss.
 */
function sampleOnce(
  detector: Detector,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): FramingSample | null {
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  let best: FramingSample | null = null;
  let bestArea = 0;

  for (const d of detector.detect(canvas).detections) {
    const box = d.boundingBox;
    const score = d.categories?.[0]?.score ?? 1;
    if (!box || score < MIN_CONFIDENCE) continue;

    const area = box.width * box.height;
    if (!best || area > bestArea) {
      bestArea = area;
      best = {
        score,
        x: (box.originX + box.width / 2) / canvas.width,
        y: (box.originY + box.height / 2) / canvas.height,
      };
    }
  }

  return best;
}

/**
 * Finds where the face is, by watching for a couple of seconds.
 *
 * Runs on the sender, when asked, and then stops. Continuous tracking was the
 * obvious design and the wrong one: a tile that follows your head in real time
 * is distracting to watch, and it spends CPU on a machine already encoding
 * video to correct something that only really changes when you move your chair.
 *
 * It used to look at exactly one frame, taken the instant the element started
 * playing. That is the frame a camera is least able to give you — still
 * adjusting exposure, often still focusing — and there was nothing to disagree
 * with whatever it found. A single detection scraping past MIN_CONFIDENCE moved
 * the crop for everybody watching. That is GRYT-852, and this is the fix:
 * discard the warm-up, take SAMPLE_COUNT looks across about two seconds, and
 * let `combineSamples` decide whether they agree.
 *
 * Returns null when there is no camera, no model, or not enough agreement —
 * every caller treats that as "leave the framing alone", which is why a failed
 * detection costs nothing rather than snapping back to centre.
 */
export async function detectFraming(
  stream: MediaStream | null | undefined,
): Promise<Framing | null> {
  const track = stream?.getVideoTracks()[0];
  if (!track) return null;

  const detector = await getDetector();
  if (!detector) return null;

  // A detached element, so this works whether or not the camera is on screen
  // and without disturbing playback of the one that is.
  const video = document.createElement("video");
  video.srcObject = new MediaStream([track]);
  video.muted = true;
  video.playsInline = true;

  try {
    await video.play();
    // One frame has to have arrived before there is anything to look at.
    if (!video.videoWidth) {
      await new Promise<void>((resolve) => {
        video.onloadeddata = () => resolve();
        window.setTimeout(resolve, 1000);
      });
    }
    if (!video.videoWidth) return null;

    const canvas = document.createElement("canvas");
    const scale = SAMPLE_WIDTH / video.videoWidth;
    canvas.width = SAMPLE_WIDTH;
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Let the camera settle before believing anything it shows.
    await delay(WARMUP_MS);

    const samples: FramingSample[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      if (i > 0) await delay(SAMPLE_INTERVAL_MS);
      // The camera can be turned off while this is running, and drawing from a
      // dead track produces a frame of nothing that the model is happy to find
      // faces in.
      if (track.readyState === "ended" || !video.videoWidth) break;

      const sample = sampleOnce(detector, video, canvas, ctx);
      if (sample) samples.push(sample);
    }

    return combineSamples(samples);
  } catch {
    return null;
  } finally {
    video.srcObject = null;
  }
}
