import { chunkDesign } from "../engine/chunks";
import type { Design, SpectrumResult } from "../engine/types";

const row = (values: (string | number)[]) => values.join(",");

/** Every polarization's totals and specular powers, one row per wavelength. */
export function spectrumCsv(result: SpectrumResult): string {
  const pols = (["s", "p"] as const).filter((p) => result.spectra[p]);
  const fields = ["R", "T", "A_balance", "R_specular", "T_specular"] as const;
  const header = ["wavelength_nm", ...pols.flatMap((p) => fields.map((f) => `${f}_${p}`))];
  const lines = result.wavelengths_nm.map((w, i) =>
    row([w, ...pols.flatMap((p) => fields.map((f) => result.spectra[p]![f][i]))]),
  );
  return [row(header), ...lines].join("\n") + "\n";
}

export function ordersCsv(result: SpectrumResult): string {
  const header = ["wavelength_nm", "polarization", "m", "n", "R", "T", "R_s", "R_p", "T_s", "T_p", "kx_over_k0", "ky_over_k0"];
  const lines: string[] = [];
  for (const pol of ["s", "p"] as const) {
    const spectrum = result.spectra[pol];
    if (!spectrum) continue;
    spectrum.orders.forEach((rows, i) =>
      rows.forEach((o) =>
        lines.push(row([result.wavelengths_nm[i], pol, o.m, o.n, o.R, o.T, o.R_s, o.R_p, o.T_s, o.T_p, o.kx_over_k0, o.ky_over_k0])),
      ),
    );
  }
  return [row(header), ...lines].join("\n") + "\n";
}

/** Schema-1.2 projects ready for POST /api/jobs or the MCP adapter. */
export function apiProjects(design: Design): string {
  const chunks = chunkDesign(design);
  return JSON.stringify(chunks.length === 1 ? chunks[0] : { projects: chunks }, null, 2);
}
