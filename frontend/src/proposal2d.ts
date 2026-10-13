/** Exact-base dimension proposals. No network, solver, persistence or application. */
import {
  hashProject2D,
  normalizeProject2D,
  parseJSONWith2DNumberGate,
} from "./project2d";
import type { Layer2D, Project2D } from "./project2d";
import { exactSemanticEqual, STACK_PROPOSAL_MAX_BYTES } from "./workflow";
import type { Diagnostic } from "./workflow";

type LayerDimensions = {
  index: number;
  geometry: Layer2D["geometry"];
  thickness_nm?: number;
  cd_nm?: number;
  cd_x_nm?: number;
  cd_y_nm?: number;
  diameter_nm?: number;
};
export interface DimensionChanges {
  period_nm?: number;
  period_y_nm?: number;
  layers?: LayerDimensions[];
}
export interface DimensionDifference {
  path: string;
  before: number;
  after: number;
}
export interface DimensionChangeProposal {
  schema_version: "rcwa-change-proposal/1.2";
  base_project: Project2D;
  candidate_project: Project2D;
  changes: DimensionChanges;
  base_input_hash: string;
  candidate_input_hash: string;
  diff: DimensionDifference[];
  diagnostics: Diagnostic[];
  valid: boolean;
}
const fields = {
  homogeneous: ["thickness_nm"],
  rectangle_1d: ["thickness_nm", "cd_nm"],
  rectangle_2d: ["thickness_nm", "cd_x_nm", "cd_y_nm"],
  circular_hole_2d: ["thickness_nm", "diameter_nm"],
} as const;
function fail(message: string): never {
  throw new Error(`2D dimension proposal: ${message}`);
}
function record(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("expected a plain JSON object.");
  const object = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (typeof key !== "string" || !allowed.includes(key))
      fail(`unknown field ${String(key).slice(0, 80)}.`);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail("plain JSON fields are required.");
  }
  for (const key of required)
    if (!Object.prototype.hasOwnProperty.call(object, key))
      fail(`missing field ${key}.`);
  return object;
}
function dimension(value: unknown, field: string) {
  const min = field.startsWith("period") ? 20 : 0;
  const max = field === "thickness_nm" ? 2000 : 5000;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    fail(`${field} must be a finite number between ${min} and ${max}.`);
  return value;
}
export function parse2DDimensionChanges(value: unknown): DimensionChanges {
  const changes = record(value, ["period_nm", "period_y_nm", "layers"]);
  if (!Object.keys(changes).length) fail("at least one dimension is required.");
  const patch: DimensionChanges = {};
  for (const key of ["period_nm", "period_y_nm"] as const)
    if (key in changes) patch[key] = dimension(changes[key], key);
  if ("layers" in changes) {
    if (
      !Array.isArray(changes.layers) ||
      !changes.layers.length ||
      changes.layers.length > 8
    )
      fail("layers must contain 1–8 indexed patches.");
    const indexes = new Set<number>();
    patch.layers = changes.layers.map((value) => {
      const item = record(
        value,
        [
          "index",
          "geometry",
          "thickness_nm",
          "cd_nm",
          "cd_x_nm",
          "cd_y_nm",
          "diameter_nm",
        ],
        ["index", "geometry"],
      );
      const index = item.index;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > 7 ||
        indexes.has(index)
      )
        fail("layer indexes must be unique integers from 0 through 7.");
      indexes.add(index);
      if (
        typeof item.geometry !== "string" ||
        !Object.prototype.hasOwnProperty.call(fields, item.geometry)
      )
        fail("unknown layer geometry.");
      const geometry = item.geometry as Layer2D["geometry"];
      const keys = Object.keys(item).filter(
        (key) => key !== "index" && key !== "geometry",
      );
      if (!keys.length) fail("each layer patch requires a dimension.");
      const result: LayerDimensions = {
        index: index === 0 ? 0 : index,
        geometry,
      };
      for (const key of keys) {
        if (!(fields[geometry] as readonly string[]).includes(key))
          fail("dimension does not belong to the layer geometry.");
        Object.assign(result, { [key]: dimension(item[key], key) });
      }
      return result;
    });
  }
  return patch;
}
export function apply2DDimensionChanges(
  base: unknown,
  changes: unknown,
): Project2D {
  const candidate = normalizeProject2D(base);
  const patch = parse2DDimensionChanges(changes);
  for (const key of ["period_nm", "period_y_nm"] as const)
    if (key in patch) candidate[key] = patch[key]!;
  for (const entry of patch.layers ?? []) {
    const layer = candidate.layers[entry.index];
    if (!layer || layer.geometry !== entry.geometry)
      fail("indexed layer must exist and match its geometry tag.");
    for (const key of fields[entry.geometry])
      if (key in entry) Object.assign(layer, { [key]: entry[key] });
  }
  // Cross-field checks run once on the complete patch, never on intermediate states.
  return normalizeProject2D(candidate);
}
export function dimensionDiff2D(
  base: Project2D,
  candidate: Project2D,
): DimensionDifference[] {
  const diff: DimensionDifference[] = [];
  function compare(path: string, before: number, after: number) {
    if (!Object.is(before, after)) diff.push({ path, before, after });
  }
  for (const key of ["period_nm", "period_y_nm"] as const)
    compare(key, base[key], candidate[key]);
  base.layers.forEach((layer, index) => {
    for (const key of fields[layer.geometry])
      compare(
        `layers[${index}].${key}`,
        (layer as unknown as Record<string, number>)[key],
        (candidate.layers[index] as unknown as Record<string, number>)[key],
      );
  });
  return diff;
}
function canonicalProject(value: unknown): Project2D {
  const normalized = normalizeProject2D(value);
  if (!exactSemanticEqual(value, normalized))
    fail("base and candidate must include every normalized project field.");
  return normalized;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export async function parse2DChangeProposal(
  text: string,
): Promise<DimensionChangeProposal> {
  if (new TextEncoder().encode(text).byteLength > STACK_PROPOSAL_MAX_BYTES)
    fail("file exceeds the 8 MB limit.");
  const envelopeFields = [
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
  const envelope = record(
    parseJSONWith2DNumberGate(text, { dimensionProposal: true }),
    envelopeFields,
    envelopeFields,
  );
  if (envelope.schema_version !== "rcwa-change-proposal/1.2")
    fail("unsupported schema version.");
  if (typeof envelope.valid !== "boolean") fail("valid must be a boolean.");
  const base = canonicalProject(envelope.base_project);
  const supplied = canonicalProject(envelope.candidate_project);
  const changes = parse2DDimensionChanges(envelope.changes);
  const candidate = apply2DDimensionChanges(base, changes);
  if (!exactSemanticEqual(candidate, supplied))
    fail("candidate does not match the dimension patch.");
  const diff = dimensionDiff2D(base, candidate);
  if (
    !Array.isArray(envelope.diff) ||
    envelope.diff.length > 26 ||
    !exactSemanticEqual(diff, envelope.diff)
  )
    fail("diff does not match the reconstructed dimensions.");
  if (!Array.isArray(envelope.diagnostics) || envelope.diagnostics.length > 62)
    fail("diagnostics must contain at most 62 entries.");
  let reportsErrors = false;
  for (const value of envelope.diagnostics) {
    const d = record(
      value,
      ["code", "severity", "location", "message"],
      ["code", "severity", "location", "message"],
    );
    if (
      typeof d.code !== "string" ||
      d.code.length > 100 ||
      typeof d.message !== "string" ||
      d.message.length > 2000 ||
      typeof d.severity !== "string" ||
      !["error", "warning", "info"].includes(d.severity) ||
      !Array.isArray(d.location) ||
      d.location.length > 16 ||
      !d.location.every(
        (v) =>
          (typeof v === "string" && v.length <= 100) ||
          (typeof v === "number" && Number.isInteger(v)),
      )
    )
      fail("invalid diagnostic.");
    if (d.severity === "error") reportsErrors = true;
  }
  if (envelope.valid !== !reportsErrors)
    fail("valid flag contradicts the reported diagnostics.");
  for (const key of ["base_input_hash", "candidate_input_hash"])
    if (
      typeof envelope[key] !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope[key] as string)
    )
      fail("input hashes must be SHA-256 strings.");
  const [baseHash, candidateHash] = await Promise.all([
    hashProject2D(base),
    hashProject2D(candidate),
  ]);
  if (
    baseHash !== envelope.base_input_hash ||
    candidateHash !== envelope.candidate_input_hash
  )
    fail("input hash does not match the exact normalized inputs.");
  // Input editing is permitted after strict schema checks. Imported numerical
  // diagnostics and valid claims are untrusted; the server validates before Run.
  // A reported failure remains a conservative block, without echoing its claims.
  return freeze({
    schema_version: "rcwa-change-proposal/1.2",
    base_project: base,
    candidate_project: candidate,
    changes,
    base_input_hash: baseHash,
    candidate_input_hash: candidateHash,
    diff,
    diagnostics: [],
    valid: envelope.valid,
  });
}
