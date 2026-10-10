import { isForwardResult, validateProject } from "./model";
import type { ForwardResult, Material, Project } from "./model";

export type RunOrigin = "computed" | "server" | "imported" | "reference";
export interface RunRecord {
  inputProject: Project;
  result: ForwardResult;
  origin: RunOrigin;
  sourceJobId?: string;
  inputHash?: string;
  snapshotId?: string;
}
export interface Workspace {
  project: Project;
  displayedRun: RunRecord | null;
}
interface EditTransaction {
  start: Workspace;
  future: Workspace[];
  hasEdit: boolean;
}
export interface HistoryState {
  past: Workspace[];
  present: Workspace;
  future: Workspace[];
  initial: Workspace;
  editTransaction?: EditTransaction;
  revision: number;
}
export type WorkspaceAction =
  | { type: "replace-project"; project: Project }
  | { type: "replace-workspace"; workspace: Workspace }
  | { type: "set-displayed-run"; run: RunRecord | null }
  | { type: "begin-edit" }
  | { type: "end-edit" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; workspace?: Workspace };

export const HISTORY_LIMIT = 30;
export const PROPOSAL_MAX_BYTES = 2_000_000;
const SOURCE_DEFAULT = "User-defined synthetic optical constants";

/** Key order is irrelevant; array order, missing keys and every value matter. */
export function semanticEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length)
    return false;
  const left = Object.keys(a),
    right = Object.keys(b);
  if (left.length !== right.length) return false;
  return left.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      semanticEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** A mutable deep copy for constructing the next edit. Stored copies are frozen. */
export function cloneProject(project: Project): Project {
  return structuredClone(project);
}

/** Canonicalize only schema-defined optional defaults, never drop input fields. */
export function normalizeProject(project: Project): Project {
  const copy = cloneProject(project);
  for (const material of [
    copy.ambient,
    copy.substrate,
    ...copy.layers.flatMap((layer) => [layer.material, layer.background]),
  ]) {
    material.wavelengths_nm ??= null;
    material.n_values ??= null;
    material.k_values ??= null;
    material.source ??= SOURCE_DEFAULT;
  }
  return copy;
}

const immutableRuns = new WeakSet<RunRecord>();

/** Clone a newly received run once. History frames thereafter share the record. */
export function createRunRecord(run: RunRecord): RunRecord {
  if (immutableRuns.has(run)) return run;
  const error = resultCompatibilityError(run.inputProject, run.result);
  if (error) throw new Error(error);
  if (!["computed", "server", "imported", "reference"].includes(run.origin))
    throw new Error("Unknown run origin.");
  const copy = deepFreeze(structuredClone(run));
  immutableRuns.add(copy);
  return copy;
}

function immutableWorkspace(workspace: Workspace): Workspace {
  return Object.freeze({
    project: deepFreeze(cloneProject(workspace.project)),
    displayedRun: workspace.displayedRun
      ? createRunRecord(workspace.displayedRun)
      : null,
  });
}

function sameWorkspace(a: Workspace, b: Workspace): boolean {
  return (
    semanticEqual(a.project, b.project) &&
    semanticEqual(a.displayedRun, b.displayedRun)
  );
}

export function createHistory(initialWorkspace: Workspace): HistoryState {
  const initial = immutableWorkspace(initialWorkspace);
  return { past: [], present: initial, future: [], initial, revision: 0 };
}

function settleEdit(state: HistoryState): HistoryState {
  const transaction = state.editTransaction;
  if (!transaction) return state;
  const rest = { ...state };
  delete rest.editTransaction;
  const changed =
    transaction.hasEdit && !sameWorkspace(transaction.start, state.present);
  return {
    ...rest,
    past: changed
      ? [...state.past, transaction.start].slice(-HISTORY_LIMIT)
      : state.past,
    future: changed ? [] : transaction.future,
  };
}

/** Session-only input history. No action computes, saves or fetches anything. */
export function workspaceReducer(
  state: HistoryState,
  action: WorkspaceAction,
): HistoryState {
  if (action.type === "begin-edit")
    return state.editTransaction
      ? state
      : {
          ...state,
          editTransaction: {
            start: state.present,
            future: state.future,
            hasEdit: false,
          },
        };
  if (action.type === "end-edit") return settleEdit(state);
  if (action.type === "reset") {
    const initial = action.workspace
      ? immutableWorkspace(action.workspace)
      : state.initial;
    const changed = !sameWorkspace(initial, state.present);
    if (
      !changed &&
      !state.past.length &&
      !state.future.length &&
      !state.editTransaction &&
      initial === state.initial
    )
      return state;
    return {
      past: [],
      present: initial,
      future: [],
      initial,
      revision: state.revision + Number(changed),
    };
  }
  if (action.type === "undo" || action.type === "redo") {
    const settled = settleEdit(state);
    if (action.type === "undo") {
      if (!settled.past.length) return settled;
      return {
        ...settled,
        past: settled.past.slice(0, -1),
        present: settled.past[settled.past.length - 1],
        future: [settled.present, ...settled.future].slice(0, HISTORY_LIMIT),
        revision: settled.revision + 1,
      };
    }
    if (!settled.future.length) return settled;
    return {
      ...settled,
      past: [...settled.past, settled.present].slice(-HISTORY_LIMIT),
      present: settled.future[0],
      future: settled.future.slice(1),
      revision: settled.revision + 1,
    };
  }
  const next =
    action.type === "replace-project"
      ? { ...state.present, project: action.project }
      : action.type === "replace-workspace"
        ? action.workspace
        : { ...state.present, displayedRun: action.run };
  if (sameWorkspace(state.present, next)) return state;
  const present = immutableWorkspace(next);
  const revision = state.revision + 1;
  if (action.type === "set-displayed-run")
    return { ...state, present, revision };
  if (state.editTransaction)
    return {
      ...state,
      present,
      revision,
      future: [],
      editTransaction: { ...state.editTransaction, hasEdit: true },
    };
  return {
    ...state,
    present,
    revision,
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    future: [],
  };
}

export const GEOMETRY_FIELDS = ["period_nm", "cd_nm", "thickness_nm"] as const;
export type GeometryField = (typeof GEOMETRY_FIELDS)[number];
export type GeometryChanges = Partial<Record<GeometryField, number>>;
export interface GeometryDifference {
  field: GeometryField;
  before: number;
  after: number;
}
export interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  location: (string | number)[];
  message: string;
}
export interface ChangeProposal {
  schema_version: "rcwa-change-proposal/1.0";
  base_project: Project;
  candidate_project: Project;
  changes: GeometryChanges;
  base_input_hash: string;
  candidate_input_hash: string;
  diff: GeometryDifference[];
  diagnostics: Diagnostic[];
  valid: boolean;
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${location} must be an object.`);
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  location: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`${location}: unknown field ${key}.`);
  for (const key of required)
    if (!Object.prototype.hasOwnProperty.call(value, key))
      throw new Error(`${location}: missing field ${key}.`);
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function assertFiniteJson(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Proposal must contain finite JSON numbers.");
  if (value && typeof value === "object")
    Object.values(value).forEach(assertFiniteJson);
}
function strictProject(value: unknown, location: string): Project {
  const project = object(value, location);
  const projectKeys = [
    "schema_version",
    "name",
    "period_nm",
    "ambient",
    "substrate",
    "layers",
    "illumination",
    "solver",
  ];
  keys(project, projectKeys, projectKeys, location);
  if (!Array.isArray(project.layers) || project.layers.length !== 1)
    throw new Error(`${location}: exactly one layer is required.`);
  const layer = object(project.layers[0], `${location}.layers[0]`);
  const layerKeys = [
    "name",
    "geometry",
    "thickness_nm",
    "cd_nm",
    "material",
    "background",
  ];
  keys(layer, layerKeys, layerKeys, `${location}.layers[0]`);
  for (const [label, material] of [
    ["ambient", project.ambient],
    ["substrate", project.substrate],
    ["layers[0].material", layer.material],
    ["layers[0].background", layer.background],
  ]) {
    keys(
      object(material, `${location}.${label}`),
      [
        "name",
        "kind",
        "n",
        "k",
        "wavelengths_nm",
        "n_values",
        "k_values",
        "source",
      ],
      ["name", "kind", "n", "k"],
      `${location}.${label}`,
    );
  }
  const illuminationKeys = ["wavelengths_nm", "angle_deg", "polarization"];
  keys(
    object(project.illumination, `${location}.illumination`),
    illuminationKeys,
    illuminationKeys,
    `${location}.illumination`,
  );
  keys(
    object(project.solver, `${location}.solver`),
    ["harmonics"],
    ["harmonics"],
    `${location}.solver`,
  );
  const errors = validateProject(project);
  if (errors.length) throw new Error(`${location}: ${errors.join(" ")}`);
  return normalizeProject(project as unknown as Project);
}

export function parseGeometryChanges(value: unknown): GeometryChanges {
  const changes = object(value, "changes");
  keys(changes, GEOMETRY_FIELDS, [], "changes");
  if (!Object.keys(changes).length)
    throw new Error("changes must contain at least one geometry field.");
  for (const [field, number] of Object.entries(changes))
    if (!finite(number))
      throw new Error(`changes.${field} must be a finite number.`);
  return { ...changes } as GeometryChanges;
}

export function applyGeometryChanges(
  base: Project,
  changes: GeometryChanges,
): Project {
  const patch = parseGeometryChanges(changes);
  const candidate = strictProject(base, "base_project");
  // Assign the whole patch before checking CD <= period, so combined edits are atomic.
  if (patch.period_nm !== undefined) candidate.period_nm = patch.period_nm;
  if (patch.cd_nm !== undefined) candidate.layers[0].cd_nm = patch.cd_nm;
  if (patch.thickness_nm !== undefined)
    candidate.layers[0].thickness_nm = patch.thickness_nm;
  const errors = validateProject(candidate);
  if (errors.length) throw new Error(`candidate_project: ${errors.join(" ")}`);
  return candidate;
}

function geometryValue(project: Project, field: GeometryField): number {
  return field === "period_nm" ? project.period_nm : project.layers[0][field];
}
export function geometryDiff(
  base: Project,
  candidate: Project,
): GeometryDifference[] {
  return GEOMETRY_FIELDS.flatMap((field) => {
    const before = geometryValue(base, field),
      after = geometryValue(candidate, field);
    return before === after ? [] : [{ field, before, after }];
  });
}

function interpolate(
  wavelengths: number[],
  values: number[],
  wavelength: number,
): number {
  if (
    wavelength < wavelengths[0] ||
    wavelength > wavelengths[wavelengths.length - 1]
  )
    throw new Error("Material extrapolation is forbidden.");
  const upper = wavelengths.findIndex((value) => value >= wavelength);
  if (upper === 0 || wavelengths[upper] === wavelength) return values[upper];
  const ratio =
    (wavelength - wavelengths[upper - 1]) /
    (wavelengths[upper] - wavelengths[upper - 1]);
  return values[upper - 1] + ratio * (values[upper] - values[upper - 1]);
}
function refractiveIndex(
  material: Material,
  wavelength: number,
): [number, number] {
  return material.kind === "constant"
    ? [material.n, material.k]
    : [
        interpolate(material.wavelengths_nm!, material.n_values!, wavelength),
        interpolate(material.wavelengths_nm!, material.k_values!, wavelength),
      ];
}

/** Mirrors deterministic backend preflight; neither imports nor invokes a solver. */
export function localPreflight(project: Project): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const materials: [Material, (string | number)[]][] = [
    [project.ambient, ["ambient"]],
    [project.substrate, ["substrate"]],
    [project.layers[0]?.material, ["layers", 0, "material"]],
    [project.layers[0]?.background, ["layers", 0, "background"]],
  ];
  for (const [material, location] of materials) {
    const table = material?.wavelengths_nm;
    if (
      material?.kind === "tabulated" &&
      Array.isArray(table) &&
      table.length &&
      project.illumination?.wavelengths_nm?.some(
        (w) => w < table[0] || w > table[table.length - 1],
      )
    )
      diagnostics.push({
        code: "material_coverage",
        severity: "error",
        location: [...location, "wavelengths_nm"],
        message: `${material.name}: wavelength outside material table; extrapolation is forbidden`,
      });
  }
  if (diagnostics.length) return diagnostics;
  const errors = validateProject(project);
  if (errors.length)
    return errors.map((message) => ({
      code: "project_validation",
      severity: "error",
      location: [],
      message,
    }));
  const harmonics = project.solver.harmonics;
  const angle = (project.illumination.angle_deg * Math.PI) / 180;
  project.illumination.wavelengths_nm.forEach((wavelength, index) => {
    const [n0] = refractiveIndex(project.ambient, wavelength);
    const [ns, ks] = refractiveIndex(project.substrate, wavelength);
    const incident = n0 * Math.sin(angle);
    const largest = Math.max(n0, ks === 0 ? ns : n0);
    if (
      [-harmonics - 1, harmonics + 1].some(
        (order) =>
          Math.abs(incident + (order * wavelength) / project.period_nm) <=
          largest,
      )
    )
      diagnostics.push({
        code: "insufficient_harmonics",
        severity: "error",
        location: ["solver", "harmonics"],
        message:
          "Harmonics are too small to retain all propagating diffraction orders; increase harmonics or reduce the period",
      });
    let distance = Infinity;
    for (let order = -harmonics; order <= harmonics; order++) {
      const kx = incident + (order * wavelength) / project.period_nm;
      const top = Math.abs(n0 * n0 - kx * kx);
      // |(n + ik)^2 - kx^2| retains the lossy substrate's imaginary part.
      const bottom = Math.hypot(ns * ns - ks * ks - kx * kx, 2 * ns * ks);
      distance = Math.min(distance, top, bottom);
    }
    if (distance < 1e-10)
      diagnostics.push({
        code: "rayleigh_cutoff",
        severity: "error",
        location: ["illumination", "wavelengths_nm", index],
        message: `A diffraction order is exactly at a Rayleigh cutoff near ${Number(wavelength.toPrecision(6))} nm; move the sampled wavelength slightly`,
      });
    else if (distance < 1e-4)
      diagnostics.push({
        code: "near_rayleigh_cutoff",
        severity: "warning",
        location: ["illumination", "wavelengths_nm", index],
        message:
          "A sampled order is near a Rayleigh cutoff; refine wavelength and harmonic sampling.",
      });
  });
  return diagnostics;
}

export function parseChangeProposal(text: string): ChangeProposal {
  if (new TextEncoder().encode(text).byteLength > PROPOSAL_MAX_BYTES)
    throw new Error("Proposal exceeds the 2 MB file limit.");
  const data: unknown = JSON.parse(text);
  assertFiniteJson(data);
  const envelope = object(data, "proposal");
  const fields = [
    "schema_version",
    "base_project",
    "candidate_project",
    "changes",
    "base_input_hash",
    "candidate_input_hash",
    "diff",
    "diagnostics",
    "valid",
  ];
  keys(envelope, fields, fields, "proposal");
  if (envelope.schema_version !== "rcwa-change-proposal/1.0")
    throw new Error("Unsupported change proposal schema.");
  if (typeof envelope.valid !== "boolean")
    throw new Error("proposal.valid must be a boolean.");
  for (const field of ["base_input_hash", "candidate_input_hash"])
    if (
      typeof envelope[field] !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope[field] as string)
    )
      throw new Error(`proposal.${field} must be a SHA-256 hash.`);
  const base = strictProject(envelope.base_project, "base_project");
  const suppliedCandidate = strictProject(
    envelope.candidate_project,
    "candidate_project",
  );
  const changes = parseGeometryChanges(envelope.changes);
  const candidate = applyGeometryChanges(base, changes);
  if (!semanticEqual(candidate, suppliedCandidate))
    throw new Error(
      "Candidate contains changes outside the supplied geometry patch.",
    );
  const diff = geometryDiff(base, candidate);
  if (!Array.isArray(envelope.diff))
    throw new Error("proposal.diff must be an array.");
  for (const entry of envelope.diff) {
    const item = object(entry, "diff entry");
    keys(
      item,
      ["field", "before", "after"],
      ["field", "before", "after"],
      "diff entry",
    );
    if (
      !GEOMETRY_FIELDS.includes(item.field as GeometryField) ||
      !finite(item.before) ||
      !finite(item.after)
    )
      throw new Error("Invalid geometry diff entry.");
  }
  if (!semanticEqual(diff, envelope.diff))
    throw new Error(
      "Supplied diff does not match the reconstructed geometry changes.",
    );
  if (!Array.isArray(envelope.diagnostics))
    throw new Error("proposal.diagnostics must be an array.");
  for (const entry of envelope.diagnostics) {
    const diagnostic = object(entry, "diagnostic");
    keys(
      diagnostic,
      ["code", "severity", "location", "message"],
      ["code", "severity", "location", "message"],
      "diagnostic",
    );
    if (
      typeof diagnostic.code !== "string" ||
      typeof diagnostic.message !== "string" ||
      !["error", "warning", "info"].includes(diagnostic.severity as string) ||
      !Array.isArray(diagnostic.location) ||
      !diagnostic.location.every(
        (part) =>
          typeof part === "string" ||
          (typeof part === "number" && Number.isInteger(part)),
      )
    )
      throw new Error("Invalid proposal diagnostic.");
  }
  const diagnostics = localPreflight(candidate);
  // Hashes are informational. Only the server establishes computed provenance.
  return deepFreeze({
    schema_version: "rcwa-change-proposal/1.0",
    base_project: base,
    candidate_project: candidate,
    changes,
    base_input_hash: envelope.base_input_hash as string,
    candidate_input_hash: envelope.candidate_input_hash as string,
    diff,
    diagnostics,
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
  });
}

export function proposalApplyError(
  proposal: ChangeProposal,
  current: Project,
  previewRevision: number,
  currentRevision: number,
): string | null {
  if (
    previewRevision !== currentRevision ||
    !semanticEqual(
      normalizeProject(proposal.base_project),
      normalizeProject(current),
    )
  )
    return "The project changed since this proposal was created or opened. Make a proposal from the current exported project.";
  if (!proposal.valid)
    return "The proposed inputs have validation errors. Resolve them before applying.";
  if (!proposal.diff.length) return "This proposal makes no changes.";
  return null;
}

export function resultCompatibilityError(
  project: Project,
  result: unknown,
): string | null {
  if (!isForwardResult(result))
    return "The stored forward result is missing or invalid.";
  if (
    !semanticEqual(project.illumination.wavelengths_nm, result.wavelengths_nm)
  )
    return "Result wavelengths do not exactly match the run inputs.";
  const channels =
    project.illumination.polarization === "both"
      ? ["p", "s"]
      : [project.illumination.polarization];
  if (!semanticEqual(Object.keys(result.spectra).sort(), channels))
    return "Result polarizations do not exactly match the run inputs.";
  return null;
}

export function comparisonCompatibilityError(
  candidates: Workspace[],
  polarization: "s" | "p",
): string | null {
  if (candidates.length < 2 || candidates.length > 3)
    return "Select two or three distinct saved candidates.";
  const identities = new Set<string | RunRecord>();
  let wavelengths: number[] | undefined;
  for (const candidate of candidates) {
    const run = candidate.displayedRun;
    if (!run) return "A selected candidate has no stored spectrum.";
    const identity = run.snapshotId
      ? `snapshot:${run.snapshotId}`
      : run.sourceJobId
        ? `job:${run.sourceJobId}`
        : run;
    if (identities.has(identity)) return "Select distinct saved candidates.";
    identities.add(identity);
    const error = resultCompatibilityError(run.inputProject, run.result);
    if (error) return error;
    if (!run.result.spectra[polarization])
      return `A selected candidate has no ${polarization}-polarized spectrum.`;
    if (wavelengths && !semanticEqual(wavelengths, run.result.wavelengths_nm))
      return "Candidate wavelength grids differ. Comparison requires an exact match; no interpolation is performed.";
    wavelengths = run.result.wavelengths_nm;
  }
  return null;
}
