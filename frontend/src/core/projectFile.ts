import { convertLegacy } from "./legacy";
import { normalizeDesign } from "./design";
import { parseJSONWith2DNumberGate } from "./project2d";
import type { Design } from "../engine/types";

export const DESIGN_FORMAT = "rcwa-design";
export const MAX_FILE_BYTES = 2_000_000;

export interface ParsedFile {
  design: Design;
  notes: string[];
}

/** Accepts design files, {project} envelopes and bare 1.0–1.2 projects. */
export function parseProjectFile(text: string): ParsedFile {
  if (text.length > MAX_FILE_BYTES) throw new Error("File is larger than 2 MB.");
  const data = parseJSONWith2DNumberGate(text) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a JSON object.");
  const inner = data.format === DESIGN_FORMAT ? data.design : "project" in data ? data.project : data;
  const version = (inner as { schema_version?: unknown })?.schema_version;
  if (version === "1.2") return { design: normalizeDesign(inner), notes: [] };
  if (version === undefined || version === "1.0" || version === "1.1") {
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
