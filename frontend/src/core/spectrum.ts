import type { SpectrumResult } from "../engine/types";

export type PolView = "s" | "p" | "avg";
export interface Series {
  wavelengths: number[];
  R: number[];
  T: number[];
  A: number[];
  Rspec: number[];
  Tspec: number[];
}

/** One curve set for the chosen polarization; "avg" is unpolarized light. */
export function series(result: SpectrumResult, pol: PolView): Series {
  const s = result.spectra.s;
  const p = result.spectra.p;
  const pick = (key: "R" | "T" | "A_balance" | "R_specular" | "T_specular") => {
    if (pol === "s" && s) return s[key];
    if (pol === "p" && p) return p[key];
    if (s && p) return s[key].map((v, i) => (v + p[key][i]) / 2);
    return (s ?? p)![key];
  };
  return {
    wavelengths: result.wavelengths_nm,
    R: pick("R"),
    T: pick("T"),
    A: pick("A_balance"),
    Rspec: pick("R_specular"),
    Tspec: pick("T_specular"),
  };
}

export function polLabel(result: SpectrumResult, pol: PolView) {
  if (pol === "s" && result.spectra.s) return "s";
  if (pol === "p" && result.spectra.p) return "p";
  if (result.spectra.s && result.spectra.p) return "unpolarized";
  return result.spectra.s ? "s" : "p";
}

export function nearestIndex(ws: number[], nm: number) {
  let best = 0;
  for (let i = 1; i < ws.length; i++) if (Math.abs(ws[i] - nm) < Math.abs(ws[best] - nm)) best = i;
  return best;
}
