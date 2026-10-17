import { indexAt } from "./materials";
import { setValue, type Parameter } from "./parameters";
import type { Design } from "../engine/types";

/**
 * Wood–Rayleigh anomaly curves: where a diffraction order (m, n) becomes grazing in
 * the incident medium or the substrate. Returned as polylines in (wavelength, parameter).
 */
export function rayleighLines(design: Design, parameter: Parameter, values: number[], span: [number, number], maxOrder = 2) {
  const lines = new Map<string, { x: number; y: number }[]>();
  const samples = 240;
  for (const value of values) {
    const d = setValue(design, parameter, value);
    const theta = (d.illumination.angle_deg * Math.PI) / 180;
    const phi = (d.illumination.azimuth_deg * Math.PI) / 180;
    for (const medium of ["ambient", "substrate"] as const) {
      const f = (wl: number, m: number, n: number) => {
        const n0 = indexAt(d.ambient, wl)?.n ?? d.ambient.n;
        const N = indexAt(d[medium], wl)?.n ?? d[medium].n;
        const kx = n0 * Math.sin(theta) * Math.cos(phi) + (m * wl) / d.period_nm;
        const ky = n0 * Math.sin(theta) * Math.sin(phi) + (n * wl) / d.period_y_nm;
        return kx * kx + ky * ky - N * N;
      };
      for (let m = -maxOrder; m <= maxOrder; m++)
        for (let n = -maxOrder; n <= maxOrder; n++) {
          if (!m && !n) continue;
          let prev = f(span[0], m, n);
          for (let i = 1; i <= samples; i++) {
            const wl = span[0] + ((span[1] - span[0]) * i) / samples;
            const cur = f(wl, m, n);
            if (Math.sign(cur) !== Math.sign(prev)) {
              const w0 = wl - (span[1] - span[0]) / samples;
              const x = w0 + ((wl - w0) * prev) / (prev - cur);
              const key = `${medium}:${m},${n}`;
              if (!lines.has(key)) lines.set(key, []);
              lines.get(key)!.push({ x, y: value });
              break;
            }
            prev = cur;
          }
        }
    }
  }
  return [...lines.values()].filter((line) => line.length > 1);
}
