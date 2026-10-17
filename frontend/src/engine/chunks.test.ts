import { describe, expect, it } from "vitest";
import { chunkDesign, MAX_REQUEST_WAVELENGTHS, mergeResults, previewDesign } from "./chunks";
import { TEMPLATES } from "../core/templates";
import { wavelengthRange } from "../core/design";
import type { PublicForwardResult2D } from "./types";

const base = TEMPLATES[0].design;
const withWavelengths = (n: number) => ({
  ...base,
  illumination: { ...base.illumination, wavelengths_nm: wavelengthRange(400, 900, n) },
});

describe("chunkDesign", () => {
  it("splits long spectra into balanced contract-sized requests", () => {
    const chunks = chunkDesign(withWavelengths(101));
    expect(chunks.map((c) => c.illumination.wavelengths_nm.length)).toEqual([26, 26, 26, 23]);
    expect(chunks.flatMap((c) => c.illumination.wavelengths_nm)).toEqual(wavelengthRange(400, 900, 101));
    expect(Math.max(...chunks.map((c) => c.illumination.wavelengths_nm.length))).toBeLessThanOrEqual(MAX_REQUEST_WAVELENGTHS);
  });
  it("keeps short spectra in one request", () => {
    expect(chunkDesign(withWavelengths(21))).toHaveLength(1);
  });
});

describe("previewDesign", () => {
  it("thins the spectrum and caps Fourier orders", () => {
    const preview = previewDesign(withWavelengths(101));
    expect(preview.illumination.wavelengths_nm).toHaveLength(13);
    expect(preview.illumination.wavelengths_nm[0]).toBe(400);
    expect(preview.illumination.wavelengths_nm.at(-1)).toBe(900);
    expect(preview.solver).toEqual({ harmonics_x: 2, harmonics_y: 2 });
  });
});

describe("mergeResults", () => {
  const part = (ws: number[], error: number | null): PublicForwardResult2D =>
    ({
      result_type: "forward",
      schema_version: "1.2",
      wavelengths_nm: ws,
      spectra: {
        s: { R: ws.map(() => 0.1), T: ws.map(() => 0.9), R_specular: ws.map(() => 0.1), T_specular: ws.map(() => 0.9), A_balance: ws.map(() => 0), orders: ws.map(() => []) },
      },
      metadata: { harmonics_x: 2, harmonics_y: 3, input_hash: ws.join(), max_lossless_flux_error: error },
      warnings: ["a", ws.length > 1 ? "b" : "a"],
    }) as unknown as PublicForwardResult2D;
  it("concatenates spectra and combines run facts", () => {
    const merged = mergeResults([part([400, 500], 1e-9), part([600], 3e-9)], "browser", 2);
    expect(merged.wavelengths_nm).toEqual([400, 500, 600]);
    expect(merged.spectra.s!.R).toHaveLength(3);
    expect(merged.spectra.p).toBeUndefined();
    expect(merged.warnings).toEqual(["a", "b"]);
    expect(merged.harmonics).toEqual([2, 3]);
    expect(merged.maxLosslessFluxError).toBe(3e-9);
    expect(mergeResults([part([400], null), part([500], 1e-9)], "server", 1).maxLosslessFluxError).toBeNull();
  });
});
