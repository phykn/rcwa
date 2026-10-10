export type Polarization = "s" | "p" | "both";
export interface Material {
  name: string;
  kind: "constant" | "tabulated";
  n: number;
  k: number;
  wavelengths_nm?: number[] | null;
  n_values?: number[] | null;
  k_values?: number[] | null;
  source?: string;
}
export interface Layer {
  name: string;
  geometry: "rectangle_1d";
  thickness_nm: number;
  cd_nm: number;
  material: Material;
  background: Material;
}
export interface Project {
  schema_version: "1.0";
  name: string;
  period_nm: number;
  ambient: Material;
  substrate: Material;
  layers: Layer[];
  illumination: {
    wavelengths_nm: number[];
    angle_deg: number;
    polarization: Polarization;
  };
  solver: { harmonics: number };
}
export interface Spectrum {
  R: number[];
  T: number[];
  R_specular: number[];
  T_specular: number[];
  A_balance: number[];
  orders?: unknown[];
}
export interface ForwardResult {
  schema_version: "1.0";
  wavelengths_nm: number[];
  spectra: { s?: Spectrum; p?: Spectrum };
  metadata: Record<string, unknown>;
  warnings: string[];
}
export interface Job {
  id: string;
  kind: "forward" | "fit";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created_at: string;
  result: ForwardResult | FitResult | null;
  error: string | null;
  progress?: number;
}
export interface FitResult {
  [key: string]: unknown;
}
export interface SavedProject {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  project: Project;
  result?: ForwardResult | null;
}
export interface ProjectFile {
  format?: string;
  project: Project;
  result?: ForwardResult | null;
  result_project?: Project | null;
}
const material = (name: string, n: number): Material => ({
  name,
  kind: "constant",
  n,
  k: 0,
  wavelengths_nm: null,
  n_values: null,
  k_values: null,
  source: "User-defined synthetic optical constants",
});
export const defaultProject: Project = {
  schema_version: "1.0",
  name: "One-layer grating",
  period_nm: 400,
  ambient: material("Air", 1),
  substrate: material("Synthetic substrate", 1.5),
  layers: [
    {
      name: "Patterned layer",
      geometry: "rectangle_1d",
      thickness_nm: 160,
      cd_nm: 180,
      material: material("Synthetic dielectric", 2.1),
      background: material("Air", 1),
    },
  ],
  illumination: {
    wavelengths_nm: linspace(450, 850, 21),
    angle_deg: 15,
    polarization: "both",
  },
  solver: { harmonics: 7 },
};
export function linspace(start: number, end: number, count: number): number[] {
  const n = Math.max(2, Math.min(81, Math.round(count) || 2));
  return Array.from(
    { length: n },
    (_, i) => +(start + ((end - start) * i) / (n - 1)).toFixed(6),
  );
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
export function validateProject(project: unknown): string[] {
  const errors: string[] = [];
  if (!project || typeof project !== "object")
    return ["Project must be a JSON object."];
  const p = project as Project;
  if (p.schema_version !== "1.0")
    errors.push("Only project schema 1.0 is supported.");
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 100)
    errors.push("Enter a project name with 1–100 characters.");
  if (!finite(p.period_nm) || p.period_nm < 20 || p.period_nm > 5000)
    errors.push("Period must be 20–5000 nm.");
  if (!Array.isArray(p.layers) || p.layers.length !== 1)
    return [...errors, "This version supports exactly one grating layer."];
  const layer = p.layers[0];
  if (
    typeof layer?.name !== "string" ||
    !layer.name.trim() ||
    layer.name.length > 100
  )
    errors.push("Layer name must be 1–100 characters.");
  if (!layer || layer.geometry !== "rectangle_1d")
    return [...errors, "Only rectangle_1d geometry is supported."];
  if (!finite(layer.cd_nm) || layer.cd_nm < 0 || layer.cd_nm > p.period_nm)
    errors.push("CD must be between 0 and the period.");
  if (
    !finite(layer.thickness_nm) ||
    layer.thickness_nm < 0 ||
    layer.thickness_nm > 2000
  )
    errors.push("Thickness must be 0–2000 nm.");
  const wavelengths = p.illumination?.wavelengths_nm;
  if (
    !Array.isArray(wavelengths) ||
    wavelengths.length < 1 ||
    wavelengths.length > 81 ||
    wavelengths.some((w) => !finite(w) || w < 200 || w > 2500)
  )
    errors.push("Use 1–81 wavelengths from 200 to 2500 nm.");
  else if (wavelengths.some((w, i) => i > 0 && w <= wavelengths[i - 1]))
    errors.push("Wavelengths must be strictly increasing.");
  if (
    !finite(p.illumination?.angle_deg) ||
    p.illumination.angle_deg < 0 ||
    p.illumination.angle_deg > 75
  )
    errors.push("Angle must be between 0° and 75°.");
  if (!["s", "p", "both"].includes(p.illumination?.polarization))
    errors.push("Select s, p, or both polarizations.");
  if (
    !Number.isInteger(p.solver?.harmonics) ||
    p.solver.harmonics < 1 ||
    p.solver.harmonics > 20
  )
    errors.push("Harmonic order N must be an integer from 1 to 20.");
  for (const [label, m] of [
    ["Ambient", p.ambient],
    ["Substrate", p.substrate],
    ["Ridge", layer.material],
    ["Groove", layer.background],
  ] as const) {
    if (!m || !["constant", "tabulated"].includes(m.kind)) {
      errors.push(`${label}: invalid material.`);
      continue;
    }
    if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 100)
      errors.push(`${label}: material name must be 1–100 characters.`);
    if (
      m.source !== undefined &&
      (typeof m.source !== "string" || m.source.length > 500)
    )
      errors.push(`${label}: invalid source text.`);
    if (m.kind === "constant") {
      if ([m.wavelengths_nm, m.n_values, m.k_values].some((v) => v != null))
        errors.push(`${label}: constant materials cannot contain tables.`);
      if (
        !finite(m.n) ||
        m.n <= 0 ||
        m.n > 10 ||
        !finite(m.k) ||
        m.k < 0 ||
        m.k > 10
      )
        errors.push(`${label}: use 0 < n ≤ 10 and 0 ≤ k ≤ 10.`);
      if (label === "Ambient" && m.k !== 0)
        errors.push(`${label} must be lossless (k = 0).`);
    } else {
      const w = m.wavelengths_nm,
        n = m.n_values,
        k = m.k_values;
      if (
        !Array.isArray(w) ||
        !Array.isArray(n) ||
        !Array.isArray(k) ||
        w.length < 2 ||
        w.length > 2000 ||
        w.length !== n.length ||
        w.length !== k.length ||
        w.some((v, i) => !finite(v) || v <= 0 || (i > 0 && v <= w[i - 1])) ||
        n.some((v) => !finite(v) || v <= 0 || v > 10) ||
        k.some((v) => !finite(v) || v < 0 || v > 10)
      )
        errors.push(
          `${label}: table needs matching, ordered wavelength/n/k arrays.`,
        );
      else {
        if (wavelengths?.some((v) => v < w[0] || v > w[w.length - 1]))
          errors.push(
            `${label}: n/k table does not cover the wavelength range. No extrapolation.`,
          );
        if (label === "Ambient" && k.some((v) => v !== 0))
          errors.push(`${label} table must have k = 0 throughout.`);
      }
    }
  }
  return errors;
}
export function isForwardResult(value: unknown): value is ForwardResult {
  if (!value || typeof value !== "object") return false;
  const v = value as ForwardResult;
  if (
    v.schema_version !== "1.0" ||
    !v.metadata ||
    typeof v.metadata !== "object" ||
    Array.isArray(v.metadata) ||
    !Array.isArray(v.warnings) ||
    !v.warnings.every((w) => typeof w === "string")
  )
    return false;
  if (
    !Array.isArray(v.wavelengths_nm) ||
    !v.wavelengths_nm.length ||
    !v.wavelengths_nm.every(finite) ||
    !v.spectra
  )
    return false;
  if (Object.keys(v.spectra).some((key) => key !== "s" && key !== "p"))
    return false;
  const channels = [v.spectra.s, v.spectra.p].filter(Boolean) as Spectrum[];
  return (
    channels.length > 0 &&
    channels.every((c) =>
      ["R", "T", "R_specular", "T_specular", "A_balance"].every((key) => {
        const values = c[key as keyof Spectrum];
        return (
          Array.isArray(values) &&
          values.length === v.wavelengths_nm.length &&
          values.every(finite)
        );
      }),
    )
  );
}
export function parseProjectFile(text: string): ProjectFile {
  const data: unknown = JSON.parse(text);
  const wrapped =
    data && typeof data === "object" && "project" in data
      ? (data as ProjectFile)
      : { project: data as Project };
  const errors = validateProject(wrapped.project);
  if (errors.length) throw new Error(errors.join("\n"));
  if (wrapped.result != null && !isForwardResult(wrapped.result))
    throw new Error("Saved result is invalid or uses an unsupported format.");
  if (wrapped.result_project && validateProject(wrapped.result_project).length)
    throw new Error("Saved result inputs are invalid.");
  if (wrapped.result) {
    const inputs = wrapped.result_project || wrapped.project;
    const expected =
      inputs.illumination.polarization === "both"
        ? ["p", "s"]
        : [inputs.illumination.polarization];
    if (
      JSON.stringify(wrapped.result.wavelengths_nm) !==
        JSON.stringify(inputs.illumination.wavelengths_nm) ||
      JSON.stringify(Object.keys(wrapped.result.spectra).sort()) !==
        JSON.stringify(expected)
    )
      throw new Error(
        "Saved result wavelengths/polarizations do not match its input project.",
      );
  }
  return wrapped;
}
export function sameProject(a: Project | null, b: Project): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}
export function downloadProject(
  project: Project,
  result: ForwardResult | null,
  resultProject: Project | null,
) {
  const blob = new Blob(
    [
      JSON.stringify(
        {
          format: "lattice-project/1.0",
          exported_at: new Date().toISOString(),
          project,
          result,
          result_project: resultProject,
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = `${project.name.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 80) || "rcwa-project"}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
