import type { Design, PublicForwardResult2D, SpectrumResult } from "./types";

/** One request accepts at most this many wavelengths (schema 1.2 contract). */
export const MAX_REQUEST_WAVELENGTHS = 31;
export const PREVIEW_WAVELENGTHS = 13;
export const PREVIEW_HARMONICS = 2;

export function chunkDesign(design: Design): Design[] {
  const all = design.illumination.wavelengths_nm;
  const count = Math.ceil(all.length / MAX_REQUEST_WAVELENGTHS);
  const size = Math.ceil(all.length / count);
  const chunks: Design[] = [];
  for (let i = 0; i < all.length; i += size)
    chunks.push({ ...design, illumination: { ...design.illumination, wavelengths_nm: all.slice(i, i + size) } });
  return chunks;
}

/** A cheap stand-in: fewer Fourier orders and an evenly thinned spectrum. */
export function previewDesign(design: Design): Design {
  const all = design.illumination.wavelengths_nm;
  const step = (all.length - 1) / (PREVIEW_WAVELENGTHS - 1);
  const wavelengths =
    all.length <= PREVIEW_WAVELENGTHS
      ? all
      : [...new Set(Array.from({ length: PREVIEW_WAVELENGTHS }, (_, i) => all[Math.round(i * step)]))];
  return {
    ...design,
    illumination: { ...design.illumination, wavelengths_nm: wavelengths },
    solver: {
      harmonics_x: Math.min(design.solver.harmonics_x, PREVIEW_HARMONICS),
      harmonics_y: Math.min(design.solver.harmonics_y, PREVIEW_HARMONICS),
    },
  };
}

export function mergeResults(
  results: PublicForwardResult2D[],
  engine: SpectrumResult["engine"],
  elapsedSeconds: number,
): SpectrumResult {
  const first = results[0];
  const spectra: SpectrumResult["spectra"] = {};
  for (const pol of ["s", "p"] as const) {
    if (!first.spectra[pol]) continue;
    spectra[pol] = {
      R: results.flatMap((r) => r.spectra[pol]!.R),
      T: results.flatMap((r) => r.spectra[pol]!.T),
      R_specular: results.flatMap((r) => r.spectra[pol]!.R_specular),
      T_specular: results.flatMap((r) => r.spectra[pol]!.T_specular),
      A_balance: results.flatMap((r) => r.spectra[pol]!.A_balance),
      orders: results.flatMap((r) => r.spectra[pol]!.orders),
    };
  }
  const errors = results.map((r) => r.metadata.max_lossless_flux_error);
  return {
    wavelengths_nm: results.flatMap((r) => r.wavelengths_nm),
    spectra,
    warnings: [...new Set(results.flatMap((r) => r.warnings))],
    harmonics: [first.metadata.harmonics_x, first.metadata.harmonics_y],
    inputHashes: results.map((r) => r.metadata.input_hash),
    elapsedSeconds,
    engine,
    maxLosslessFluxError: errors.some((e) => e === null) ? null : Math.max(...(errors as number[])),
  };
}
