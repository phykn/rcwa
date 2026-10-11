import {
  isForwardResult,
  validateProject,
  validLayerIndex,
  supportsSyntheticFit,
} from "./model";
import type {
  ForwardResult,
  Material,
  Project,
  Project1D,
  Layer,
} from "./model";
import { normalizeProject2D } from "./project2d";
import { bindResult2D, boundResult2DCompatibilityError } from "./result2d";

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
  selectedLayer?: number;
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
  | { type: "replace-project"; project: Project; selectedLayer?: number }
  | { type: "select-layer"; index: number }
  | { type: "replace-workspace"; workspace: Workspace }
  | { type: "set-displayed-run"; run: RunRecord | null }
  | { type: "begin-edit" }
  | { type: "end-edit" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; workspace?: Workspace };

export const HISTORY_LIMIT = 30;
export const PROPOSAL_MAX_BYTES = 2_000_000;
export const STACK_PROPOSAL_MAX_BYTES = 8_000_000;
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

/** Exact value comparison for 1.2 identity: +0 and -0 remain different. */
export function exactSemanticEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
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
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        exactSemanticEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  );
}

/** Editing equality also accepts invalid drafts; it does not normalize or hash. */
export function projectInputsEqual(a: Project | null, b: Project): boolean {
  if (a === null) return false;
  return a.schema_version === "1.2" || b.schema_version === "1.2"
    ? exactSemanticEqual(a, b)
    : semanticEqual(a, b);
}

/** Version-aware same-input comparison for stale labels and normalized snapshots. */
export function sameNormalizedProject(a: Project | null, b: Project): boolean {
  if (a === null) return false;
  try {
    return projectInputsEqual(normalizeProject(a), normalizeProject(b));
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** A mutable deep copy for constructing the next edit. Stored copies are frozen. */
export function cloneProject<T extends Project>(project: T): T {
  return structuredClone(project);
}

/** Canonicalize only schema-defined optional defaults, never drop input fields. */
export function normalizeProject<T extends Project>(project: T): T {
  if (project.schema_version === "1.2") return normalizeProject2D(project) as T;
  const copy = cloneProject(project);
  for (const material of [
    copy.ambient,
    copy.substrate,
    ...copy.layers.flatMap((layer) =>
      layer.geometry === "rectangle_1d"
        ? [layer.material, layer.background]
        : [layer.material],
    ),
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
  // Binding is attached to the checked, frozen 1.2 result identity. Preserve it
  // instead of copying the large order payload and losing the verified proof.
  const copy =
    run.result.schema_version === "1.2"
      ? deepFreeze({
          ...run,
          inputProject: cloneProject(run.inputProject),
          result: run.result,
        })
      : deepFreeze(structuredClone(run));
  immutableRuns.add(copy);
  return copy;
}

/** Verify at asynchronous ingress, never inside reducers or history operations. */
export async function createRunRecordAsync(run: RunRecord): Promise<RunRecord> {
  if (immutableRuns.has(run)) return run;
  // Capture input values before hashing can yield to newer edits.
  const captured = { ...run, inputProject: cloneProject(run.inputProject) };
  if (
    captured.inputProject.schema_version === "1.2" &&
    boundResult2DCompatibilityError(captured.inputProject, captured.result) !==
      null
  ) {
    captured.result = await bindResult2D(
      captured.inputProject,
      captured.result,
    );
  }
  return createRunRecord(captured);
}

function immutableWorkspace(workspace: Workspace): Workspace {
  return Object.freeze({
    project: deepFreeze(cloneProject(workspace.project)),
    ...(workspace.selectedLayer === undefined
      ? {}
      : {
          selectedLayer: validLayerIndex(
            workspace.project,
            workspace.selectedLayer,
          ),
        }),
    displayedRun: workspace.displayedRun
      ? createRunRecord(workspace.displayedRun)
      : null,
  });
}

function sameWorkspace(a: Workspace, b: Workspace): boolean {
  return (
    projectInputsEqual(a.project, b.project) &&
    (a.displayedRun === b.displayedRun ||
      (a.displayedRun?.inputProject.schema_version === "1.2" ||
      b.displayedRun?.inputProject.schema_version === "1.2"
        ? exactSemanticEqual(a.displayedRun, b.displayedRun)
        : semanticEqual(a.displayedRun, b.displayedRun)))
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
  if (action.type === "select-layer")
    return {
      ...state,
      present: Object.freeze({
        ...state.present,
        selectedLayer: validLayerIndex(state.present.project, action.index),
      }),
    };
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
      ? {
          ...state.present,
          project: action.project,
          ...(action.selectedLayer === undefined &&
          state.present.selectedLayer === undefined
            ? {}
            : {
                selectedLayer: validLayerIndex(
                  action.project,
                  action.selectedLayer ?? state.present.selectedLayer,
                ),
              }),
        }
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
export interface LegacyChangeProposal {
  schema_version: "rcwa-change-proposal/1.0";
  base_project: Project1D;
  candidate_project: Project1D;
  changes: GeometryChanges;
  base_input_hash: string;
  candidate_input_hash: string;
  diff: GeometryDifference[];
  diagnostics: Diagnostic[];
  valid: boolean;
}

export interface StackChanges {
  period_nm?: number;
  layers?: Layer[];
}
export interface MaterialSummary {
  name: string;
  kind: Material["kind"];
  n: number;
  k: number;
  source: string;
  table: null | {
    rows: number;
    wavelength_min_nm: number;
    wavelength_max_nm: number;
    checksum: string;
  };
}
export interface LayerSummary {
  name: string;
  geometry: Layer["geometry"];
  thickness_nm: number;
  material: MaterialSummary;
  cd_nm: number | null;
  cd_x_nm?: number;
  cd_y_nm?: number;
  background: MaterialSummary | null;
}
export type StackDifference =
  | {
      kind: "value";
      path: string;
      before: string | number | null;
      after: string | number | null;
    }
  | {
      kind: "material";
      path: string;
      before: MaterialSummary | null;
      after: MaterialSummary | null;
    }
  | {
      kind: "layer";
      path: string;
      before: LayerSummary | null;
      after: LayerSummary | null;
    };
export interface StackChangeProposal extends Omit<
  LegacyChangeProposal,
  "schema_version" | "changes" | "diff"
> {
  schema_version: "rcwa-change-proposal/1.1";
  changes: StackChanges;
  diff: StackDifference[];
}
export type ChangeProposal = LegacyChangeProposal | StackChangeProposal;

/** Compact content fingerprint, not a security or provenance claim. */
export function summarizeMaterial(material: Material): MaterialSummary {
  let table: MaterialSummary["table"] = null;
  if (material.kind === "tabulated") {
    const wavelengths = material.wavelengths_nm!;
    const bytes = new DataView(new ArrayBuffer(8));
    let hash = 2166136261;
    for (let i = 0; i < wavelengths.length; i++)
      for (const value of [
        wavelengths[i],
        material.n_values![i],
        material.k_values![i],
      ]) {
        bytes.setFloat64(0, value, false);
        for (let j = 0; j < 8; j++)
          hash = Math.imul(hash ^ bytes.getUint8(j), 16777619) >>> 0;
      }
    table = {
      rows: wavelengths.length,
      wavelength_min_nm: wavelengths[0],
      wavelength_max_nm: wavelengths.at(-1)!,
      checksum: `fnv1a32-f64be:${hash.toString(16).padStart(8, "0")}`,
    };
  }
  return {
    name: material.name,
    kind: material.kind,
    n: material.n,
    k: material.k,
    source: material.source ?? SOURCE_DEFAULT,
    table,
  };
}
export function summarizeLayer(layer: Layer): LayerSummary {
  return {
    name: layer.name,
    geometry: layer.geometry,
    thickness_nm: layer.thickness_nm,
    material: summarizeMaterial(layer.material),
    cd_nm: layer.geometry === "rectangle_1d" ? layer.cd_nm : null,
    ...(layer.geometry === "rectangle_2d"
      ? { cd_x_nm: layer.cd_x_nm, cd_y_nm: layer.cd_y_nm }
      : {}),
    background:
      layer.geometry !== "homogeneous"
        ? summarizeMaterial(layer.background)
        : null,
  };
}
export function parseStackChanges(value: unknown): StackChanges {
  const changes = object(value, "changes");
  keys(changes, ["period_nm", "layers"], [], "changes");
  if (!Object.keys(changes).length)
    throw new Error("changes must contain period_nm and/or layers.");
  if ("period_nm" in changes && !finite(changes.period_nm))
    throw new Error("changes.period_nm must be a finite number.");
  if (
    "layers" in changes &&
    (!Array.isArray(changes.layers) ||
      changes.layers.length < 1 ||
      changes.layers.length > 8)
  )
    throw new Error("changes.layers must contain 1–8 complete layers.");
  return structuredClone(changes) as StackChanges;
}
export function applyStackChanges(
  base: Project,
  changes: StackChanges,
): Project1D {
  reject2DProposal(base);
  const patch = parseStackChanges(changes);
  const candidate = strictProject(base, "base_project");
  candidate.schema_version = "1.1";
  if (patch.period_nm !== undefined) candidate.period_nm = patch.period_nm;
  return strictProject(
    patch.layers === undefined
      ? candidate
      : { ...candidate, layers: structuredClone(patch.layers) },
    "candidate_project",
  );
}
export function stackDiff(
  base: Project,
  candidate: Project,
): StackDifference[] {
  reject2DProposal(base);
  reject2DProposal(candidate);
  const diff: StackDifference[] = [];
  for (const field of ["schema_version", "period_nm"] as const)
    if (base[field] !== candidate[field])
      diff.push({
        kind: "value",
        path: field,
        before: base[field],
        after: candidate[field],
      });
  for (
    let i = 0;
    i < Math.max(base.layers.length, candidate.layers.length);
    i++
  ) {
    const before = base.layers[i],
      after = candidate.layers[i],
      path = `layers[${i}]`;
    if (!before || !after || before.geometry !== after.geometry) {
      diff.push({
        kind: "layer",
        path,
        before: before ? summarizeLayer(before) : null,
        after: after ? summarizeLayer(after) : null,
      });
      continue;
    }
    for (const field of ["name", "thickness_nm"] as const)
      if (before[field] !== after[field])
        diff.push({
          kind: "value",
          path: `${path}.${field}`,
          before: before[field],
          after: after[field],
        });
    if (
      before.geometry === "rectangle_1d" &&
      after.geometry === "rectangle_1d" &&
      before.cd_nm !== after.cd_nm
    )
      diff.push({
        kind: "value",
        path: `${path}.cd_nm`,
        before: before.cd_nm,
        after: after.cd_nm,
      });
    if (!semanticEqual(before.material, after.material))
      diff.push({
        kind: "material",
        path: `${path}.material`,
        before: summarizeMaterial(before.material),
        after: summarizeMaterial(after.material),
      });
    if (
      before.geometry === "rectangle_1d" &&
      after.geometry === "rectangle_1d" &&
      !semanticEqual(before.background, after.background)
    )
      diff.push({
        kind: "material",
        path: `${path}.background`,
        before: summarizeMaterial(before.background),
        after: summarizeMaterial(after.background),
      });
  }
  return diff;
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
const UNSUPPORTED_2D_PROPOSAL =
  "Schema 1.2 change proposals are unsupported. Edit the structure directly instead.";
function reject2DProposal(value: unknown): void {
  if (
    value &&
    typeof value === "object" &&
    "schema_version" in value &&
    value.schema_version === "1.2"
  )
    throw new Error(UNSUPPORTED_2D_PROPOSAL);
}
function strictProject(value: unknown, location: string): Project1D {
  reject2DProposal(value);
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
  if (
    !Array.isArray(project.layers) ||
    project.layers.length < 1 ||
    project.layers.length > 8
  )
    throw new Error(`${location}: 1–8 layers are required.`);
  const materials: [string, unknown][] = [
    ["ambient", project.ambient],
    ["substrate", project.substrate],
  ];
  project.layers.forEach((value, index) => {
    const label = `${location}.layers[${index}]`;
    const layer = object(value, label);
    const layerKeys =
      layer.geometry === "homogeneous"
        ? ["name", "geometry", "thickness_nm", "material"]
        : [
            "name",
            "geometry",
            "thickness_nm",
            "cd_nm",
            "material",
            "background",
          ];
    keys(layer, layerKeys, layerKeys, label);
    materials.push([`layers[${index}].material`, layer.material]);
    if (layer.geometry === "rectangle_1d")
      materials.push([`layers[${index}].background`, layer.background]);
  });
  for (const [label, material] of materials) {
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
  return normalizeProject(project as unknown as Project1D);
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
): Project1D {
  reject2DProposal(base);
  const patch = parseGeometryChanges(changes);
  const candidate = strictProject(base, "base_project");
  if (candidate.schema_version !== "1.0" || !supportsSyntheticFit(candidate))
    throw new Error(
      "Legacy geometry proposals require a schema 1.0 single rectangular layer.",
    );
  const layer = candidate.layers[0];
  if (layer.geometry !== "rectangle_1d") throw new Error("Rectangle required.");
  // Assign the whole patch before checking CD <= period, so combined edits are atomic.
  if (patch.period_nm !== undefined) candidate.period_nm = patch.period_nm;
  if (patch.cd_nm !== undefined) layer.cd_nm = patch.cd_nm;
  if (patch.thickness_nm !== undefined) layer.thickness_nm = patch.thickness_nm;
  const errors = validateProject(candidate);
  if (errors.length) throw new Error(`candidate_project: ${errors.join(" ")}`);
  return candidate;
}

function geometryValue(project: Project, field: GeometryField): number {
  if (field === "period_nm") return project.period_nm;
  const layer = project.layers[0];
  if (layer.geometry !== "rectangle_1d")
    throw new Error("Geometry diff requires one rectangle.");
  return layer[field];
}
export function geometryDiff(
  base: Project,
  candidate: Project,
): GeometryDifference[] {
  reject2DProposal(base);
  reject2DProposal(candidate);
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
  // The 1.2 backend owns physical open-order/cutoff preflight. This branch only
  // reports client schema errors and never runs the legacy 1D approximation.
  if (project.schema_version === "1.2")
    return validateProject(project).map((message) => ({
      code: "project_validation",
      severity: "error",
      location: [],
      message,
    }));
  const diagnostics: Diagnostic[] = [];
  const materials: [Material, (string | number)[]][] = [
    [project.ambient, ["ambient"]],
    [project.substrate, ["substrate"]],
    ...project.layers.flatMap(
      (layer, index): [Material, (string | number)[]][] => [
        [layer.material, ["layers", index, "material"]],
        ...(layer.geometry === "rectangle_1d"
          ? [
              [layer.background, ["layers", index, "background"]] as [
                Material,
                (string | number)[],
              ],
            ]
          : []),
      ],
    ),
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
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > STACK_PROPOSAL_MAX_BYTES)
    throw new Error("Proposal exceeds the 8 MB file limit.");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    if (bytes > PROPOSAL_MAX_BYTES)
      throw new Error("Invalid JSON above the 2 MB legacy proposal limit.", {
        cause: error,
      });
    throw error;
  }
  assertFiniteJson(data);
  const envelope = object(data, "proposal");
  reject2DProposal(envelope.base_project);
  reject2DProposal(envelope.candidate_project);
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
  const legacy = envelope.schema_version === "rcwa-change-proposal/1.0";
  if (!legacy && envelope.schema_version !== "rcwa-change-proposal/1.1")
    throw new Error("Unsupported change proposal schema.");
  if (legacy && bytes > PROPOSAL_MAX_BYTES)
    throw new Error("Proposal exceeds the 2 MB file limit.");
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
  const changes = legacy
    ? parseGeometryChanges(envelope.changes)
    : parseStackChanges(envelope.changes);
  const candidate = legacy
    ? applyGeometryChanges(base, changes as GeometryChanges)
    : applyStackChanges(base, changes as StackChanges);
  if (!semanticEqual(candidate, suppliedCandidate))
    throw new Error(
      "Candidate contains changes outside the supplied geometry patch or stack changes.",
    );
  const diff = legacy
    ? geometryDiff(base, candidate)
    : stackDiff(base, candidate);
  if (!Array.isArray(envelope.diff) || envelope.diff.length > 64)
    throw new Error("proposal.diff must be an array with at most 64 entries.");
  if (!semanticEqual(diff, envelope.diff))
    throw new Error(
      "Supplied diff does not match the reconstructed geometry changes or stack changes.",
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
    schema_version: envelope.schema_version,
    base_project: base,
    candidate_project: candidate,
    changes,
    base_input_hash: envelope.base_input_hash as string,
    candidate_input_hash: envelope.candidate_input_hash as string,
    diff,
    diagnostics,
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
  } as ChangeProposal);
}

export function proposalApplyError(
  proposal: ChangeProposal,
  current: Project,
  previewRevision: number,
  currentRevision: number,
): string | null {
  if (
    current.schema_version === "1.2" ||
    (proposal.base_project as Project).schema_version === "1.2" ||
    (proposal.candidate_project as Project).schema_version === "1.2"
  )
    return UNSUPPORTED_2D_PROPOSAL;
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
  if ((project.schema_version === "1.2") !== (result.schema_version === "1.2"))
    return "Result schema does not match the run inputs.";
  if (project.schema_version === "1.2")
    return boundResult2DCompatibilityError(project, result);
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

/** Compare geometry, illumination, accuracy and every layer's optical conditions. */
export function comparisonConditionsDiffer(
  first: Project,
  next: Project,
): boolean {
  const conditions = (project: Project) => ({
    schema_version: project.schema_version,
    period_nm: project.period_nm,
    ...(project.schema_version === "1.2"
      ? { period_y_nm: project.period_y_nm }
      : {}),
    illumination: project.illumination,
    solver: project.solver,
    ambient: project.ambient,
    substrate: project.substrate,
    layers: project.layers.map((layer) => {
      const { name, ...conditions } = layer;
      void name;
      return conditions;
    }),
  });
  return !(first.schema_version === "1.2" || next.schema_version === "1.2"
    ? exactSemanticEqual(conditions(first), conditions(next))
    : semanticEqual(conditions(first), conditions(next)));
}
