/* Cubic, because a linear slider packs most of the perceived change into the
   bottom fifth. 0 -> 0, 100 -> 1.0, and above 100 it scales (200 -> 2.0). */

/** Convert a linear slider percentage to a perceptual gain multiplier. */
export function sliderToGain(sliderPercent: number, max = 100): number {
  const t = Math.max(0, Math.min(1, sliderPercent / max));
  return t * t * t * (max / 100);
}

/** Inverse of sliderToGain – recover the slider position from a gain value. */
export function gainToSlider(gain: number, max = 100): number {
  const scale = max / 100;
  if (scale === 0) return 0;
  const t = Math.cbrt(gain / scale);
  return Math.max(0, Math.min(max, Math.round(t * max)));
}

/** Highest boost the volume sliders allow: 200 % → 2× amplitude. */
export const MAX_VOLUME_PERCENT = 200;

/**
 * Slider percentage to gain, deliberately linear: 100% is unity and 200% is twice the
 * amplitude. The old cubic put unity at 79% and made 50% mean 0.25x.
 */
export function sliderToOutputGain(sliderPercent: number): number {
  const clamped = Math.max(0, Math.min(MAX_VOLUME_PERCENT, sliderPercent));
  return clamped / 100;
}
