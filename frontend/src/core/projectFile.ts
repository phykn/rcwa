import { convertLegacy } from "./legacy";
import { normalizeDesign } from "./design";
import { parseJSONWith2DNumberGate } from "./project2d";
import type { Design } from "../engine/types";

export const DESIGN_FORMAT = "rcwa-design";
export const MAX_FILE_BYTES = 2_000_000;

/** Top-level fields of a legacy 1.0/1.1 project; anything else is not a project. */
const LEGACY_FIELDS = new Set(["schema_version", "name", "period_nm", "ambient", "substrate", "layers", "illumination", "solver"]);

export interface ParsedFile {
  design: Design;
  notes: string[];
}

/**
 * Rejoin this app's own API export, which splits a long spectrum into {projects: [...]}
 * chunks. The chunks must be one design that differs only in its wavelengths.
 */
function joinChunks(chunks: unknown[]): Record<string, unknown> {
  const parts = chunks.map((chunk) => {
    const project = chunk as Record<string, unknown> | null;
    const illumination = project?.illumination as Record<string, unknown> | undefined;
    if (project?.schema_version !== "1.2" || !Array.isArray(illumination?.wavelengths_nm))
      throw new Error("Expected every entry of projects to be a 1.2 project.");
    return { project, wavelengths: illumination.wavelengths_nm as unknown[] };
  });
  const without = (project: Record<string, unknown>) =>
    JSON.stringify({ ...project, illumination: { ...(project.illumination as object), wavelengths_nm: null } });
  if (!parts.length || parts.some((part) => without(part.project) !== without(parts[0].project)))
    throw new Error("The projects in this file are different designs; open them one at a time.");
  const first = parts[0].project;
  return {
    ...first,
    illumination: { ...(first.illumination as object), wavelengths_nm: parts.flatMap((part) => part.wavelengths) },
  };
}

/** Accepts design files, {project} envelopes, API exports and bare 1.0–1.2 projects. */
export function parseProjectFile(text: string): ParsedFile {
  if (text.length > MAX_FILE_BYTES) throw new Error("File is larger than 2 MB.");
  const data = parseJSONWith2DNumberGate(text) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a JSON object.");
  const inner =
    data.format === DESIGN_FORMAT
      ? data.design
      : "project" in data
        ? data.project
        : Array.isArray(data.projects)
          ? joinChunks(data.projects)
          : data;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) throw new Error("Expected a project object.");
  const version = (inner as { schema_version?: unknown }).schema_version;
  if (version === "1.2") return { design: normalizeDesign(inner), notes: [] };
  if (version === undefined || version === "1.0" || version === "1.1") {
    // Legacy files may omit fields, but must not be some other JSON entirely.
    const keys = Object.keys(inner);
    if (!keys.some((key) => key !== "schema_version" && LEGACY_FIELDS.has(key)) || keys.some((key) => !LEGACY_FIELDS.has(key)))
      throw new Error("This file is not an RCWA project or design file.");
    const { design, notes } = convertLegacy(inner);
    return { design: normalizeDesign(design), notes };
  }
  throw new Error(`Unsupported schema version ${String(version)}.`);
}

export function serializeDesign(design: Design): string {
  return JSON.stringify({ format: DESIGN_FORMAT, version: 2, design }, null, 2);
}

export function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "design";
}
