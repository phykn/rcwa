import { designKey, normalizeDesign } from "./design";
import { parseJSONWith2DNumberGate, type Layer2D } from "./project2d";
import type { Design } from "../engine/types";

export const PROPOSAL_SCHEMA = "rcwa-change-proposal/1.2";
export const MAX_PROPOSAL_BYTES = 8_000_000;

const FIELDS: Record<Layer2D["geometry"], readonly string[]> = {
  homogeneous: ["thickness_nm"],
  rectangle_1d: ["thickness_nm", "cd_nm"],
  rectangle_2d: ["thickness_nm", "cd_x_nm", "cd_y_nm"],
  circular_hole_2d: ["thickness_nm", "diameter_nm"],
};

export interface ProposalReview {
  candidate: Design;
  diff: { path: string; before: number; after: number }[];
  /** Diagnostics as reported by whoever made the file; not verified here. */
  reported: { severity: string; message: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function fail(message: string): never {
  throw new Error(`Change proposal: ${message}`);
}

export function isProposal(data: unknown) {
  return isRecord(data) && data.schema_version === PROPOSAL_SCHEMA;
}

/**
 * Rebuild the candidate from the current design and the allowlisted dimension
 * changes only. The file's own candidate, hashes and diagnostics are not trusted.
 */
export function reviewProposal(text: string, current: Design): ProposalReview {
  if (text.length > MAX_PROPOSAL_BYTES) fail("file is larger than 8 MB.");
  const data = parseJSONWith2DNumberGate(text);
  if (!isRecord(data) || data.schema_version !== PROPOSAL_SCHEMA) fail("unsupported format.");
  let base: Design;
  try {
    base = normalizeDesign(data.base_project);
  } catch (error) {
    return fail(`its base design is invalid (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (designKey(base) !== designKey(current))
    fail("it was made for a different design. Export the current design and ask for a new proposal.");
  const changes = isRecord(data.changes) ? data.changes : fail("missing changes.");
  for (const key of Object.keys(changes))
    if (!["period_nm", "period_y_nm", "layers"].includes(key)) fail(`changes.${key.slice(0, 40)} is not a dimension.`);
  const candidate = structuredClone(current);
  const diff: ProposalReview["diff"] = [];
  const set = (target: Record<string, unknown>, field: string, value: unknown, path: string) => {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} must be a number.`);
    const before = target[field] as number;
    // Object.is keeps a signed-zero change visible, like the server's diff.
    if (!Object.is(before, value)) diff.push({ path, before, after: value as number });
    target[field] = value;
  };
  for (const field of ["period_nm", "period_y_nm"] as const)
    if (field in changes) set(candidate as unknown as Record<string, unknown>, field, changes[field], field);
  if ("layers" in changes) {
    if (!Array.isArray(changes.layers)) fail("changes.layers must be a list.");
    for (const entry of changes.layers as unknown[]) {
      if (!isRecord(entry) || typeof entry.index !== "number" || !Number.isInteger(entry.index)) fail("each layer change needs an index.");
      const index = entry.index as number;
      const layer = candidate.layers[index] as unknown as Record<string, unknown> | undefined;
      if (!layer) fail(`layer ${index + 1} does not exist.`);
      if (entry.geometry !== layer!.geometry) fail(`layer ${index + 1} changes shape, which proposals cannot do.`);
      for (const [key, value] of Object.entries(entry)) {
        if (key === "index" || key === "geometry") continue;
        if (!FIELDS[layer!.geometry as Layer2D["geometry"]].includes(key)) fail(`layer ${index + 1}.${key.slice(0, 40)} is not a dimension.`);
        set(layer!, key, value, `layers[${index}].${key}`);
      }
    }
  }
  const checked = normalizeDesign(candidate);
  const reported = Array.isArray(data.diagnostics)
    ? (data.diagnostics as unknown[]).filter(isRecord).slice(0, 20).map((d) => ({ severity: String(d.severity ?? ""), message: String(d.message ?? "").slice(0, 300) }))
    : [];
  return { candidate: checked, diff, reported };
}
