import {
  normalizeProject2D,
  parseJSONWith2DNumberGate,
  sameProject2D,
  stringify2DEnvelope,
  validateProject2D,
} from "./project2d";
import type {
  Project2D,
  Rectangle2DLayer,
  CircularHole2DLayer,
} from "./project2d";
import { bindResult2D, isForwardResult2D } from "./result2d";
import type { PublicForwardResult2D } from "./result2d";
export type {
  Project2D,
  Rectangle2DLayer,
  CircularHole2DLayer,
} from "./project2d";
export type { PublicForwardResult2D } from "./result2d";

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
export interface RectangleLayer {
  name: string;
  geometry: "rectangle_1d";
  thickness_nm: number;
  cd_nm: number;
  material: Material;
  background: Material;
}
export interface HomogeneousLayer {
  name: string;
  geometry: "homogeneous";
  thickness_nm: number;
  material: Material;
}
export type Layer1D = RectangleLayer | HomogeneousLayer;
export type Layer = Layer1D | Rectangle2DLayer | CircularHole2DLayer;
export interface Project1D {
  schema_version: "1.0" | "1.1";
  name: string;
  period_nm: number;
  ambient: Material;
  substrate: Material;
  layers: Layer1D[];
  illumination: {
    wavelengths_nm: number[];
    angle_deg: number;
    polarization: Polarization;
  };
  solver: { harmonics: number };
}
export type Project = Project1D | Project2D;
export interface LegacyProject extends Project1D {
  schema_version: "1.0";
  layers: RectangleLayer[];
}
export interface Spectrum {
  R: number[];
  T: number[];
  R_specular: number[];
  T_specular: number[];
  A_balance: number[];
  orders?: unknown[];
}
export interface ForwardResult1D {
  result_type?: "forward";
  schema_version: "1.0" | "1.1";
  wavelengths_nm: number[];
  spectra: { s?: Spectrum; p?: Spectrum };
  metadata: Record<string, unknown>;
  warnings: string[];
}
export type ForwardResult = ForwardResult1D | PublicForwardResult2D;
export interface Job {
  id: string;
  kind: "forward" | "fit";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created_at: string;
  result: ForwardResult | FitResult | null;
  error: string | null;
  progress?: number;
  input_hash: string;
  completed_at?: string | null;
  error_code?: string | null;
}
export interface FitResult {
  [key: string]: unknown;
}
export interface SavedSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  // This classification is meaningful only on a response from the local API.
  // A downloaded or imported copy cannot establish its own provenance.
  provenance?: {
    source: "server_computed" | "unverified_import";
    job_id?: string | null;
    input_hash?: string | null;
    engine?: string | null;
    engine_version?: string | null;
    project_schema_version?: string | null;
    result_schema_version?: string | null;
    adapter_version?: string | null;
  };
}
export interface SavedProject extends SavedSummary {
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
export const defaultProject: LegacyProject = {
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
  if ((project as { schema_version?: unknown }).schema_version === "1.2")
    return validateProject2D(project);
  const p = project as Project1D;
  if (!["1.0", "1.1"].includes(p.schema_version))
    errors.push("Only project schemas 1.0 and 1.1 are supported.");
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 100)
    errors.push("Enter a project name with 1–100 characters.");
  if (!finite(p.period_nm) || p.period_nm < 20 || p.period_nm > 5000)
    errors.push("Period must be 20–5000 nm.");
  if (!Array.isArray(p.layers) || p.layers.length < 1 || p.layers.length > 8)
    return [...errors, "Use 1–8 finite layers in top-to-bottom order."];
  if (
    p.schema_version === "1.0" &&
    (p.layers.length !== 1 || p.layers[0]?.geometry !== "rectangle_1d")
  )
    errors.push("Schema 1.0 supports exactly one rectangular grating layer.");
  for (const [index, layer] of p.layers.entries()) {
    const label = `Layer ${index + 1}`;
    if (!layer || typeof layer !== "object") {
      errors.push(`${label}: invalid layer.`);
      continue;
    }
    if (
      typeof layer.name !== "string" ||
      !layer.name.trim() ||
      layer.name.length > 100
    )
      errors.push(`${label}: layer name must be 1–100 characters.`);
    if (!["rectangle_1d", "homogeneous"].includes(layer.geometry))
      errors.push(
        `${label}: only rectangle_1d or homogeneous geometry is supported.`,
      );
    if (
      layer.geometry === "homogeneous" &&
      ("cd_nm" in layer || "background" in layer)
    )
      errors.push(
        `${label}: homogeneous layers cannot contain CD or background.`,
      );
    const allowed =
      layer.geometry === "rectangle_1d"
        ? [
            "name",
            "geometry",
            "thickness_nm",
            "cd_nm",
            "material",
            "background",
          ]
        : ["name", "geometry", "thickness_nm", "material"];
    if (Object.keys(layer).some((key) => !allowed.includes(key)))
      errors.push(`${label}: unknown layer field.`);
    if (
      layer.geometry === "rectangle_1d" &&
      (!finite(layer.cd_nm) || layer.cd_nm < 0 || layer.cd_nm > p.period_nm)
    )
      errors.push(`${label}: CD must be between 0 and the period.`);
    if (
      !finite(layer.thickness_nm) ||
      layer.thickness_nm < 0 ||
      layer.thickness_nm > 2000
    )
      errors.push(`${label}: thickness must be 0–2000 nm.`);
  }
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
  const materials: [string, Material][] = [
    ["Ambient", p.ambient],
    ["Substrate", p.substrate],
    ...p.layers.flatMap((layer, index): [string, Material][] =>
      !layer
        ? []
        : [
            [`Layer ${index + 1} material`, layer.material],
            ...(layer.geometry === "rectangle_1d"
              ? [
                  [`Layer ${index + 1} background`, layer.background] as [
                    string,
                    Material,
                  ],
                ]
              : []),
          ],
    ),
  ];
  for (const [label, m] of materials) {
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
    if (
      !finite(m.n) ||
      m.n <= 0 ||
      m.n > 10 ||
      !finite(m.k) ||
      m.k < 0 ||
      m.k > 10
    )
      errors.push(
        `${label}: use numeric 0 < n ≤ 10 and 0 ≤ k ≤ 10, including table placeholders.`,
      );
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
  if ((value as { schema_version?: unknown }).schema_version === "1.2")
    return isForwardResult2D(value);
  const v = value as ForwardResult1D;
  if (
    !["1.0", "1.1"].includes(v.schema_version) ||
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
function importedProject(value: unknown): Project {
  // A missing discriminator is the legacy profile, never inferred from y fields.
  const legacy =
    value && typeof value === "object" && !("schema_version" in value)
      ? { ...value, schema_version: "1.0" }
      : value;
  if (
    legacy &&
    typeof legacy === "object" &&
    "schema_version" in legacy &&
    legacy.schema_version === "1.2"
  )
    return normalizeProject2D(legacy);
  const errors = validateProject(legacy);
  if (errors.length) throw new Error(errors.join("\n"));
  return legacy as Project1D;
}

function readProjectFile(text: string): ProjectFile {
  const data = parseJSONWith2DNumberGate(text);
  const wrapped =
    data && typeof data === "object" && "project" in data
      ? (data as ProjectFile)
      : { project: data as Project };
  const project = importedProject(wrapped.project);
  const resultProject =
    wrapped.result_project == null
      ? wrapped.result_project
      : importedProject(wrapped.result_project);
  if (wrapped.result != null && !isForwardResult(wrapped.result))
    throw new Error("Saved result is invalid or uses an unsupported format.");
  if (wrapped.result) {
    const inputs = resultProject || project;
    if (
      (inputs.schema_version === "1.2") !==
      (wrapped.result.schema_version === "1.2")
    )
      throw new Error("Saved result schema does not match its input project.");
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
  // Imported files never establish provenance, even after exact local binding.
  return {
    format: wrapped.format,
    project,
    result: wrapped.result,
    result_project: resultProject,
  };
}

/** Synchronous legacy/project-only import. 1.2 results require verified async ingress. */
export function parseProjectFile(text: string): ProjectFile {
  const parsed = readProjectFile(text);
  if (parsed.result?.schema_version === "1.2")
    throw new Error(
      "Schema 1.2 results require asynchronous binding verification. Use the verified import flow, or import the project only.",
    );
  return parsed;
}

/** Parse original raw tokens, then bind a complete 1.2 result before returning it. */
export async function parseProjectFileAsync(
  text: string,
): Promise<ProjectFile> {
  const parsed = readProjectFile(text);
  if (parsed.result?.schema_version === "1.2") {
    const inputs = parsed.result_project || parsed.project;
    if (inputs.schema_version !== "1.2")
      throw new Error("Saved result schema does not match its input project.");
    try {
      parsed.result = await bindResult2D(inputs, parsed.result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Binding verification failed.";
      throw new Error(
        `${message} Import the project only to recover its inputs.`,
        { cause: error },
      );
    }
  }
  return parsed;
}

export function sameProject(a: Project | null, b: Project): boolean {
  if (a === null) return false;
  if (a.schema_version === "1.2" || b.schema_version === "1.2")
    return (
      a.schema_version === "1.2" &&
      b.schema_version === "1.2" &&
      sameProject2D(a, b)
    );
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Full export preserves every result order and all schema-1.2 signed zeros. */
export function serializeProjectFile(
  project: Project,
  result: ForwardResult | null,
  resultProject: Project | null,
  exportedAt = new Date().toISOString(),
): string {
  const envelope = {
    format: "lattice-project/1.0",
    exported_at: exportedAt,
    project,
    result,
    result_project: resultProject,
  };
  return project.schema_version === "1.2" ||
    result?.schema_version === "1.2" ||
    resultProject?.schema_version === "1.2"
    ? stringify2DEnvelope(envelope)
    : JSON.stringify(envelope, null, 2);
}

export function downloadProject(
  project: Project,
  result: ForwardResult | null,
  resultProject: Project | null,
) {
  const blob = new Blob(
    [serializeProjectFile(project, result, resultProject)],
    { type: "application/json" },
  );
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = `${project.name.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 80) || "rcwa-project"}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function isRectangleLayer(layer: Layer): layer is RectangleLayer {
  return layer.geometry === "rectangle_1d";
}
export function isRectangle2DLayer(layer: Layer): layer is Rectangle2DLayer {
  return layer.geometry === "rectangle_2d";
}
export function maximumPatternedCDX(project: Project): number {
  return Math.max(
    0,
    ...project.layers.map((layer) =>
      layer.geometry === "rectangle_1d"
        ? layer.cd_nm
        : layer.geometry === "circular_hole_2d"
          ? layer.diameter_nm
          : layer.geometry === "rectangle_2d"
            ? layer.cd_x_nm
            : 0,
    ),
  );
}
export function maximumPatternedCDY(project: Project): number {
  // 1D ridges are invariant in y and impose no finite-width y constraint.
  return Math.max(
    0,
    ...project.layers.map((layer) =>
      layer.geometry === "rectangle_2d"
        ? layer.cd_y_nm
        : layer.geometry === "circular_hole_2d"
          ? layer.diameter_nm
          : 0,
    ),
  );
}
export const maximumPatternedCD = maximumPatternedCDX;
export function totalThickness(project: Project): number {
  return project.layers.reduce((total, layer) => total + layer.thickness_nm, 0);
}
export function supportsSyntheticFit(project: Project): boolean {
  return (
    project.schema_version !== "1.2" &&
    project.layers.length === 1 &&
    project.layers[0].geometry === "rectangle_1d"
  );
}
export function stackSummary(project: Project): string {
  return project.layers
    .map(
      (layer, index) =>
        `${index + 1}. ${layer.name}: ${layer.geometry === "rectangle_1d" ? `CD ${layer.cd_nm} nm · ` : layer.geometry === "rectangle_2d" ? `Width X ${layer.cd_x_nm} nm · Y ${layer.cd_y_nm} nm · ` : layer.geometry === "circular_hole_2d" ? `Diameter ${layer.diameter_nm} nm · ` : "Uniform · "}${layer.thickness_nm} nm`,
    )
    .join("; ");
}
export function validLayerIndex(project: Project, index = 0): number {
  return Math.max(
    0,
    Math.min(project.layers.length - 1, Math.trunc(index) || 0),
  );
}
export type StackOperation =
  | { type: "add"; geometry: Layer["geometry"] }
  | { type: "duplicate" }
  | { type: "remove" }
  | { type: "move"; direction: -1 | 1 }
  | { type: "geometry"; geometry: Layer["geometry"] };
/** Explicit legacy structural edits promote to 1.1; 1.2 never demotes. */
export function editStack(
  project: Project,
  selected: number,
  operation: StackOperation,
): { project: Project; selectedLayer: number } {
  const index = validLayerIndex(project, selected);
  if (
    (operation.type === "add" || operation.type === "geometry") &&
    (operation.geometry === "rectangle_2d" ||
      operation.geometry === "circular_hole_2d") &&
    project.schema_version !== "1.2"
  )
    throw new Error(
      "A 2D pattern requires a schema 1.2 project. Legacy projects are not silently converted.",
    );
  const next = structuredClone(project);
  // Mutate a common layer view only after checking the project's family above.
  const layers: Layer[] = next.layers;
  const layer = layers[index];
  let selectedLayer = index;
  if (
    (operation.type === "add" || operation.type === "duplicate") &&
    layers.length >= 8
  )
    throw new Error("A stack can contain at most eight finite layers.");
  if (operation.type === "add") {
    const base = structuredClone(defaultProject.layers[0]);
    const added: Layer =
      operation.geometry === "homogeneous"
        ? {
            name: "Uniform layer",
            geometry: "homogeneous",
            thickness_nm: base.thickness_nm,
            material: base.material,
          }
        : operation.geometry === "circular_hole_2d" &&
            next.schema_version === "1.2"
          ? {
              name: "Circular-hole layer",
              geometry: "circular_hole_2d",
              thickness_nm: base.thickness_nm,
              diameter_nm: Math.min(next.period_nm, next.period_y_nm) / 2,
              material: base.background,
              background: base.material,
            }
          : operation.geometry === "rectangle_2d" &&
              next.schema_version === "1.2"
            ? {
                name: "Patterned layer",
                geometry: "rectangle_2d",
                thickness_nm: base.thickness_nm,
                cd_x_nm: Math.min(base.cd_nm, next.period_nm),
                cd_y_nm: Math.min(base.cd_nm, next.period_y_nm),
                material: base.material,
                background: base.background,
              }
            : { ...base, cd_nm: Math.min(base.cd_nm, next.period_nm) };
    layers.splice(index + 1, 0, added);
    selectedLayer = index + 1;
  } else if (operation.type === "duplicate") {
    layers.splice(index + 1, 0, structuredClone(layer));
    selectedLayer = index + 1;
  } else if (operation.type === "remove") {
    if (layers.length === 1) throw new Error("Keep at least one finite layer.");
    layers.splice(index, 1);
    selectedLayer = Math.min(index, layers.length - 1);
  } else if (operation.type === "move") {
    const destination = index + operation.direction;
    if (destination < 0 || destination >= layers.length)
      return { project, selectedLayer: index };
    [layers[index], layers[destination]] = [layers[destination], layers[index]];
    selectedLayer = destination;
  } else {
    if (layer.geometry === operation.geometry)
      return { project, selectedLayer: index };
    const base = {
      name: layer.name,
      thickness_nm: layer.thickness_nm,
      material: layer.material,
    };
    const widthX =
      layer.geometry === "circular_hole_2d"
        ? layer.diameter_nm
        : layer.geometry === "rectangle_2d"
          ? layer.cd_x_nm
          : layer.geometry === "rectangle_1d"
            ? layer.cd_nm
            : next.period_nm / 2;
    const background =
      layer.geometry === "homogeneous"
        ? structuredClone(next.ambient)
        : layer.background;
    layers[index] =
      operation.geometry === "homogeneous"
        ? {
            ...base,
            geometry: "homogeneous",
            material:
              layer.geometry === "circular_hole_2d"
                ? layer.background
                : layer.material,
          }
        : operation.geometry === "circular_hole_2d" &&
            next.schema_version === "1.2"
          ? {
              ...base,
              geometry: "circular_hole_2d",
              diameter_nm: Math.min(widthX, next.period_y_nm),
              // A film becomes the host; patterned conversions preserve both material identities.
              material:
                layer.geometry === "homogeneous" ? background : layer.material,
              background:
                layer.geometry === "homogeneous" ? layer.material : background,
            }
          : operation.geometry === "rectangle_2d" &&
              next.schema_version === "1.2"
            ? {
                ...base,
                geometry: "rectangle_2d",
                cd_x_nm: widthX,
                cd_y_nm: next.period_y_nm / 2,
                background,
              }
            : { ...base, geometry: "rectangle_1d", cd_nm: widthX, background };
  }
  if (next.schema_version !== "1.2") next.schema_version = "1.1";
  return { project: next, selectedLayer };
}
