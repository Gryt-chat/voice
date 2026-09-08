// Whether a run of face detections is allowed to move everybody's crop — the half of
// "Center my face" that can be checked without a webcam. Against dist, not src.
import assert from "node:assert/strict";

const { combineSamples, MIN_CONFIDENCE, MIN_SAMPLES } = await import(
  "../dist/audio/lib/faceFraming.js"
);

const at = (x, y, score = 0.9) => ({ x, y, score });

// --- not enough to be a claim ---

// Nothing at all. The caller leaves the framing where it was.
assert.equal(combineSamples([]), null);

// One good look is exactly what the old code trusted, and is no longer enough.
assert.equal(combineSamples([at(0.2, 0.3)]), null);

// One short of the threshold, whatever the threshold happens to be.
assert.equal(combineSamples(Array.from({ length: MIN_SAMPLES - 1 }, () => at(0.2, 0.3))), null);

// And exactly the threshold is enough.
assert.deepEqual(
  combineSamples(Array.from({ length: MIN_SAMPLES }, () => at(0.2, 0.3))),
  { x: 0.2, y: 0.3 },
);

// --- the point of sampling more than once ---

// Four frames agree, one found something else entirely. The median ignores it; a mean
// would put x at 0.42, which is halfway to the wrong answer.
{
  const samples = [at(0.3, 0.4), at(0.3, 0.4), at(0.32, 0.42), at(0.3, 0.4), at(0.95, 0.1)];
  const mean = samples.reduce((a, s) => a + s.x, 0) / samples.length;
  assert.ok(mean > 0.4, "the mean really is dragged by the outlier");

  const framing = combineSamples(samples);
  assert.ok(framing.x >= 0.3 && framing.x <= 0.32, `median stayed with the agreement: ${framing.x}`);
  assert.ok(framing.y >= 0.4 && framing.y <= 0.42);
}

// Two outliers in opposite directions still lose to three that agree.
assert.deepEqual(
  combineSamples([at(0.05, 0.05), at(0.5, 0.5), at(0.5, 0.5), at(0.5, 0.5), at(0.95, 0.95)]),
  { x: 0.5, y: 0.5 },
);

// --- what does not count ---

// Below the confidence floor. Three low-confidence looks are not three looks,
// so this is refused rather than answered.
assert.equal(
  combineSamples(Array.from({ length: 5 }, () => at(0.3, 0.4, MIN_CONFIDENCE - 0.01))),
  null,
);

// Exactly at the floor is trusted; the floor is a minimum, not a threshold to beat.
assert.deepEqual(
  combineSamples(Array.from({ length: MIN_SAMPLES }, () => at(0.3, 0.4, MIN_CONFIDENCE))),
  { x: 0.3, y: 0.4 },
);

// Confident samples still count when weak ones are mixed in, and the weak ones
// do not move the answer.
assert.deepEqual(
  combineSamples([at(0.7, 0.7), at(0.7, 0.7), at(0.7, 0.7), at(0.1, 0.1, 0.1)]),
  { x: 0.7, y: 0.7 },
);

// Nonsense coordinates are dropped rather than clamped. A framing outside the
// frame is not a worse guess, it is a broken one.
for (const bad of [
  { x: NaN, y: 0.5, score: 0.9 },
  { x: 0.5, y: Infinity, score: 0.9 },
  { x: -0.1, y: 0.5, score: 0.9 },
  { x: 1.5, y: 0.5, score: 0.9 },
]) {
  assert.equal(combineSamples([bad, bad, bad, bad]), null, `should reject ${JSON.stringify(bad)}`);
}

// --- the median itself ---

// An even count averages the middle pair. Compared with a tolerance because (0.2 + 0.4) / 2
// is 0.30000000000000004, and the value ends up as a CSS percentage.
{
  const framing = combineSamples([at(0.1, 0.1), at(0.2, 0.2), at(0.4, 0.4), at(0.5, 0.5)]);
  assert.ok(Math.abs(framing.x - 0.3) < 1e-9, `x was ${framing.x}`);
  assert.ok(Math.abs(framing.y - 0.3) < 1e-9, `y was ${framing.y}`);
}

// Order in does not change the answer out.
{
  const a = [at(0.9, 0.1), at(0.1, 0.9), at(0.5, 0.5)];
  const b = [a[2], a[0], a[1]];
  assert.deepEqual(combineSamples(a), combineSamples(b));
}

console.log("face-framing: ok");
