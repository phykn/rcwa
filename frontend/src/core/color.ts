const lobe = (x: number, mu: number, s1: number, s2: number) => Math.exp(-0.5 * ((x - mu) / (x < mu ? s1 : s2)) ** 2);

// CIE 1931 2° observer, Wyman–Sloan–Shirley (2013) multi-lobe fit.
export function cmf(nm: number): [number, number, number] {
  return [
    1.056 * lobe(nm, 599.8, 37.9, 31.0) + 0.362 * lobe(nm, 442.0, 16.0, 26.7) - 0.065 * lobe(nm, 501.1, 20.4, 26.2),
    0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1),
    1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8),
  ];
}

// A 6500 K blackbody stands in for daylight.
function daylight(nm: number) {
  const m = nm * 1e-9;
  return 1 / (m ** 5 * (Math.exp(1.4387769e-2 / (m * 6500)) - 1));
}

/** Spectrum must cover the eye's most sensitive band to be meaningful. */
export const COLOR_BAND: [number, number] = [400, 700];
/** With 450–650 nm only, edge values stand in for the rest: an approximate color. */
export const APPROX_BAND: [number, number] = [450, 650];

function sample(ws: number[], values: number[], nm: number) {
  if (nm <= ws[0]) return values[0];
  if (nm >= ws[ws.length - 1]) return values[values.length - 1];
  let i = 1;
  while (ws[i] < nm) i++;
  const t = (nm - ws[i - 1]) / (ws[i] - ws[i - 1]);
  return values[i - 1] + t * (values[i] - values[i - 1]);
}

export function spectrumColor(ws: number[], values: number[]): { css: string; hex: string; approximate: boolean } | null {
  if (!ws.length || ws[0] > APPROX_BAND[0] || ws[ws.length - 1] < APPROX_BAND[1]) return null;
  const approximate = ws[0] > COLOR_BAND[0] || ws[ws.length - 1] < COLOR_BAND[1];
  let X = 0;
  let Y = 0;
  let Z = 0;
  let white = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const [x, y, z] = cmf(nm);
    const e = daylight(nm);
    const r = Math.min(1, Math.max(0, sample(ws, values, nm)));
    X += x * e * r;
    Y += y * e * r;
    Z += z * e * r;
    white += y * e;
  }
  [X, Y, Z] = [X / white, Y / white, Z / white];
  const linear = [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.204 * Y + 1.057 * Z,
  ];
  const rgb = linear.map((c) => {
    const v = Math.min(1, Math.max(0, c));
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  });
  const hex = `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  return { css: `rgb(${rgb.join(" ")})`, hex, approximate };
}
