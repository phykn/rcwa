/** Tab-local input recovery. No results, jobs, credentials or server provenance. */
import { parseProjectFile, validateProject } from "./model";
import type { Material, Project } from "./model";
import { stringify2DEnvelope } from "./project2d";
import { normalizeProject } from "./workflow";

export const INPUT_DRAFT_FORMAT = "rcwa-input-draft/1";
export const INPUT_DRAFT_MAX_BYTES = 512 * 1024;
export const INPUT_DRAFT_DELAY_MS = 300;
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type DraftRead = {
  project: Project | null;
  status: "empty" | "restored" | "unavailable" | "invalid";
};
export type DraftWrite = "saved" | "invalid" | "too-large" | "unavailable";

// Keep the explicit example routes independent, without retaining arbitrary URL
// text. sessionStorage is scoped to this origin and browser tab by the browser.
export function inputDraftKey(example: string | null): string {
  const profile =
    example === "1d"
      ? "1d"
      : example === "rectangle" || example === "rectangular"
        ? "rectangle"
        : "circle";
  return `rcwa:input-draft:1:${profile}`;
}

export function browserDraftStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage || null;
  } catch {
    return null;
  }
}

function onlyKeys(value: object, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Only supported input fields can be recovered.");
}
function validateLegacyFields(project: Project): void {
  if (project.schema_version === "1.2") return;
  // Legacy imports intentionally allow some metadata. It is not input and must
  // never become persisted recovery state. Decline recovery rather than silently
  // changing an imported project's fields or identity.
  onlyKeys(project, [
    "schema_version",
    "name",
    "period_nm",
    "ambient",
    "substrate",
    "layers",
    "illumination",
    "solver",
  ]);
  onlyKeys(project.illumination, [
    "wavelengths_nm",
    "angle_deg",
    "polarization",
  ]);
  onlyKeys(project.solver, ["harmonics"]);
  const materials: Material[] = [
    project.ambient,
    project.substrate,
    ...project.layers.flatMap((layer) =>
      layer.geometry === "rectangle_1d"
        ? [layer.material, layer.background]
        : [layer.material],
    ),
  ];
  for (const material of materials)
    onlyKeys(material, [
      "name",
      "kind",
      "n",
      "k",
      "wavelengths_nm",
      "n_values",
      "k_values",
      "source",
    ]);
}
function validatedInputs(project: Project): Project {
  if (validateProject(project).length) throw new Error("Invalid draft inputs.");
  validateLegacyFields(project);
  return normalizeProject(project);
}
function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function readInputDraft(
  storage: DraftStorage | null,
  key: string,
): DraftRead {
  let text: string | null;
  try {
    if (!storage) return { project: null, status: "unavailable" };
    text = storage.getItem(key);
  } catch {
    return { project: null, status: "unavailable" };
  }
  if (text === null) return { project: null, status: "empty" };
  try {
    // Bound the raw input before parsing, including cheap UTF-16 length first.
    if (
      text.length > INPUT_DRAFT_MAX_BYTES ||
      byteLength(text) > INPUT_DRAFT_MAX_BYTES
    )
      throw new Error("Draft exceeds the recovery limit.");
    const envelope: unknown = JSON.parse(text);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
      throw new Error("Invalid draft envelope.");
    onlyKeys(envelope, ["format", "project"]);
    if (
      !("format" in envelope) ||
      envelope.format !== INPUT_DRAFT_FORMAT ||
      !("project" in envelope)
    )
      throw new Error("Unsupported draft version.");
    // The existing ingress applies strict 1.2 validation and the raw-number gate;
    // it preserves signed zeros and does not infer a schema migration.
    const project = validatedInputs(parseProjectFile(text).project);
    return { project, status: "restored" };
  } catch {
    return { project: null, status: "invalid" };
  }
}

function discardOutdatedDraft(storage: DraftStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* A fully blocked store is unreadable too. */
  }
}

export function writeInputDraft(
  storage: DraftStorage | null,
  key: string,
  project: Project,
): DraftWrite {
  let text: string;
  try {
    const normalized = validatedInputs(project);
    text =
      normalized.schema_version === "1.2"
        ? stringify2DEnvelope({
            format: INPUT_DRAFT_FORMAT,
            project: normalized,
          })
        : JSON.stringify({ format: INPUT_DRAFT_FORMAT, project: normalized });
  } catch {
    return "invalid";
  }
  if (byteLength(text) > INPUT_DRAFT_MAX_BYTES) {
    discardOutdatedDraft(storage, key);
    return "too-large";
  }
  try {
    if (!storage) return "unavailable";
    storage.setItem(key, text);
    return "saved";
  } catch {
    // A quota failure must not make an older draft look like the latest edit on
    // reload. Removing an existing key does not require additional quota.
    discardOutdatedDraft(storage, key);
    return "unavailable";
  }
}
