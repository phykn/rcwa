/** Perceptually ordered ramp (approximating viridis), sampled at 9 stops. */
const STOPS: [number, number, number][] = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
  [31, 158, 137], [53, 183, 121], [109, 205, 89], [253, 231, 37],
];
/** Dark-to-bright ramp for field intensity (approximating inferno). */
const HOT: [number, number, number][] = [
  [0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85],
  [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164],
];

export type Ramp = "viridis" | "inferno";

export function colorAt(t: number, ramp: Ramp = "viridis"): [number, number, number] {
  const stops = ramp === "viridis" ? STOPS : HOT;
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return [0, 1, 2].map((c) => Math.round(stops[i][c] + f * (stops[i + 1][c] - stops[i][c]))) as [number, number, number];
}

export function rampCss(ramp: Ramp = "viridis") {
  const stops = ramp === "viridis" ? STOPS : HOT;
  return `linear-gradient(90deg, ${stops.map((s) => `rgb(${s.join(" ")})`).join(", ")})`;
}
