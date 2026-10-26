import type { SpectrumResult } from "../engine/types";

const row = (values: (string | number)[]) => values.join(",");

export function spectrumCsv(result: SpectrumResult): string {
  const pols = (["s", "p"] as const).filter((p) => result.spectra[p]);
  const fields = ["R", "T", "A_balance", "R_specular", "T_specular"] as const;
  const header = ["wavelength_nm", ...pols.flatMap((p) => fields.map((f) => `${f}_${p}`))];
  const lines = result.wavelengths_nm.map((w, i) =>
    row([w, ...pols.flatMap((p) => fields.map((f) => result.spectra[p]![f][i]))]),
  );
  return [row(header), ...lines].join("\n") + "\n";
}
