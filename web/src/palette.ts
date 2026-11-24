type Stop = [number, number, number, number];

const STOPS: Stop[] = [
  [-8000, 8, 24, 64],
  [-2000, 20, 60, 130],
  [-1, 46, 110, 180],
  [0, 86, 140, 76],
  [400, 140, 172, 88],
  [1200, 200, 180, 108],
  [2200, 160, 124, 86],
  [3200, 130, 118, 112],
  [4500, 245, 245, 250],
];

/** Hypsometric tint for a real (unexaggerated) height in metres, as 0-255 RGB. */
export function hypsometric(h: number): [number, number, number] {
  if (h <= STOPS[0][0]) return [STOPS[0][1], STOPS[0][2], STOPS[0][3]];
  for (let k = 1; k < STOPS.length; k++) {
    const [h1, r1, g1, b1] = STOPS[k];
    if (h <= h1) {
      const [h0, r0, g0, b0] = STOPS[k - 1];
      const t = (h - h0) / (h1 - h0);
      return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t];
    }
  }
  const last = STOPS[STOPS.length - 1];
  return [last[1], last[2], last[3]];
}

const LAND_BAND_M = 200;
const SEA_BAND_M = 1000;

/** Discrete tint band: sea (h <= 0) and land never share one. */
export function tintBand(h: number): number {
  return h > 0 ? Math.floor(h / LAND_BAND_M) : -1 - Math.floor(-h / SEA_BAND_M);
}

/** Representative height of a tint band. */
export function bandHeight(b: number): number {
  return b >= 0 ? (b + 0.5) * LAND_BAND_M : -(-b - 0.5) * SEA_BAND_M;
}
