import type { CaptureQuality } from "../../types";

const BASE_BITRATES_30FPS: Record<CaptureQuality, number | null> = {
  native: null,
  "4k": 20_000_000,
  "1440p": 12_000_000,
  "1080p": 6_000_000,
  "720p": 3_000_000,
  "480p": 1_500_000,
  "360p": 800_000,
  "240p": 400_000,
  "144p": 150_000,
  "96p": 80_000,
  "64p": 40_000,
  "48p": 25_000,
  "32p": 15_000,
  "24p": 10_000,
  "16p": 5_000,
  "8p": 2_000,
  "4p": 1_000,
};

const MAX_BITRATE = 50_000_000;

export function estimateBitrate(quality: CaptureQuality, fps: number): number | null {
  const base = BASE_BITRATES_30FPS[quality];
  if (base === null) return null;
  return Math.min(Math.round(base * Math.pow(fps / 30, 0.7)), MAX_BITRATE);
}
