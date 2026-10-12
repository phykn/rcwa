import type {
  Job,
  Project,
  SavedProject,
  SavedSummary,
  ForwardResult,
} from "./model";
import { parseJSONWith2DNumberGate, stringify2DEnvelope } from "./project2d";

export interface SavedProjectIndex {
  view: "index";
  snapshots: SavedSummary[];
  limit: 100;
  may_have_more: boolean;
}

export function validateSavedProjectIndex(value: unknown): SavedProjectIndex {
  const index = value as Partial<SavedProjectIndex> | null;
  if (
    !index ||
    index.view !== "index" ||
    index.limit !== 100 ||
    !Array.isArray(index.snapshots) ||
    index.snapshots.length > index.limit ||
    index.may_have_more !== (index.snapshots.length === index.limit) ||
    index.snapshots.some(
      (item) =>
        !item ||
        typeof item.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) ||
        typeof item.name !== "string",
    ) ||
    new Set(index.snapshots.map((item) => item.id)).size !==
      index.snapshots.length
  )
    throw new ApiContractError(
      "The saved-project index is invalid. Your current design is unchanged.",
    );
  return index as SavedProjectIndex;
}

export function savedSnapshotId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id))
    throw new Error(
      "Enter a snapshot ID using letters, numbers, hyphens or underscores (up to 100 characters).",
    );
  return id;
}

export interface ServerCapabilities {
  supported_project_schema_versions: string[];
  supported_result_schema_versions: string[];
  engine: {
    engine: string;
    installed_version: string | null;
    required_version: string;
    available: boolean;
    status: string;
    message: string;
  };
  project_profiles: Record<
    string,
    {
      operations: string[];
      geometry: string[];
      wavelength_count: number;
      harmonics: { x: number[]; y?: number[] };
      basis_size_max: number;
      adapter_version: string;
    }
  >;
}

/** A reachable server is not necessarily a compatible solver for this project. */
export function solverSupportError(
  capabilities: unknown,
  project: Project,
): string | null {
  const cap = capabilities as Partial<ServerCapabilities> | null;
  if (
    !cap ||
    !Array.isArray(cap.supported_project_schema_versions) ||
    !Array.isArray(cap.supported_result_schema_versions) ||
    !cap.engine ||
    !cap.project_profiles ||
    typeof cap.project_profiles !== "object"
  )
    return "The local server did not provide supported solver capabilities. Update the local server and reconnect.";
  if (
    !cap.supported_project_schema_versions.includes(project.schema_version) ||
    !cap.supported_result_schema_versions.includes(
      project.schema_version === "1.0" ? "1.1" : project.schema_version,
    )
  )
    return `This local server does not support schema ${project.schema_version}. Update it and reconnect. Your inputs are preserved.`;
  if (
    cap.engine.available !== true ||
    cap.engine.status !== "available" ||
    cap.engine.engine !== "meent" ||
    cap.engine.installed_version !== "0.13.2" ||
    cap.engine.required_version !== "0.13.2"
  )
    return "The local solver engine is unavailable or has an incompatible version. Install the pinned backend dependencies and reconnect.";
  const profile = cap.project_profiles[project.schema_version];
  if (
    !profile ||
    !Array.isArray(profile.operations) ||
    !["validate", "forward", "poll", "cancel"].every((operation) =>
      profile.operations.includes(operation),
    )
  )
    return `This server does not support forward calculations for schema ${project.schema_version}.`;
  if (
    project.schema_version === "1.2" &&
    (!["1.2.0", "1.3.0"].includes(profile.adapter_version) ||
      profile.wavelength_count !== 31 ||
      profile.basis_size_max !== 121 ||
      !Array.isArray(profile.geometry) ||
      !["rectangle_2d", "rectangle_1d", "homogeneous"].every((kind) =>
        profile.geometry.includes(kind),
      ) ||
      JSON.stringify(profile.harmonics?.x) !== "[1,5]" ||
      JSON.stringify(profile.harmonics?.y) !== "[1,5]")
  )
    return "The local server's 2D profile is missing or incompatible. Update it and reconnect; these inputs will not be downgraded.";
  if (
    project.schema_version === "1.2" &&
    project.layers.some((layer) => layer.geometry === "circular_hole_2d") &&
    (profile.adapter_version !== "1.3.0" ||
      !profile.geometry.includes("circular_hole_2d"))
  )
    return "This local server does not support circular-hole geometry. Update it and reconnect; these inputs will not be converted.";
  return null;
}

export function projectRequestBody(
  project: Project,
  envelope: unknown = project,
): string {
  const body =
    project.schema_version === "1.2"
      ? stringify2DEnvelope(envelope)
      : JSON.stringify(envelope);
  if (new TextEncoder().encode(body).byteLength > 2_000_000)
    throw new Error(
      "This full-result request exceeds the local API's 2 MB limit. Export JSON to keep the complete result. To save inputs only, remove result and result_project from a copy, import it, then save. A computed run can instead be saved by job ID. Nothing was changed.",
    );
  return body;
}
const base = (
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_API_BASE_URL || ""
).replace(/\/$/, "");
export const apiDescription = base || "Same-origin local API";
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export class ApiContractError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ApiContractError";
  }
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${base}/api${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    if (response.ok) {
      try {
        data = parseJSONWith2DNumberGate(text);
      } catch (cause) {
        throw new ApiContractError(
          `The server returned invalid JSON data. ${cause instanceof Error ? cause.message : "Contract validation failed."}`,
          cause,
        );
      }
    } else {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!response.ok)
      throw new ApiError(
        typeof data?.detail === "string"
          ? data.detail
          : typeof data?.error === "string"
            ? data.error
            : `API ${response.status}: ${JSON.stringify(data?.detail || data || response.statusText)}`,
        response.status,
      );
    return data as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw new Error(
        "API request timed out after 20 seconds. Check the local server.",
        { cause: error },
      );
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
export const api = {
  capabilities: () => request<ServerCapabilities>("/capabilities"),
  example: () => request<Project>("/example"),
  validate: (project: Project) =>
    request<{
      valid: boolean;
      project: Project;
      input_hash: string;
      diagnostics: { severity: string; message: string }[];
    }>("/validate", { method: "POST", body: projectRequestBody(project) }),
  snapshot: (jobId: string) =>
    request<SavedProject>("/snapshots", {
      method: "POST",
      body: JSON.stringify({ job_id: jobId }),
    }),
  start: (project: Project) =>
    request<Job>("/jobs", {
      method: "POST",
      body: projectRequestBody(project, { kind: "forward", project }),
    }),
  fit: (
    project: Project,
    fit: { target_cd_nm: number; lower_cd_nm: number; upper_cd_nm: number },
  ) =>
    request<Job>("/jobs", {
      method: "POST",
      body: JSON.stringify({ kind: "fit", project, fit }),
    }),
  job: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}`),
  cancel: (id: string) =>
    request<Job>(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  list: async () =>
    validateSavedProjectIndex(await request<unknown>("/projects?view=index")),
  load: (id: string) =>
    request<SavedProject>(`/projects/${encodeURIComponent(id)}`),
  save: (project: Project, result: ForwardResult | null) =>
    request<SavedProject>("/projects", {
      method: "POST",
      body: projectRequestBody(project, { project, result }),
    }),
};
