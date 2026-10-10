import type {
  Job,
  Project,
  SavedProject,
  SavedSummary,
  ForwardResult,
} from "./model";
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
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${base}/api${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
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
  example: () => request<Project>("/example"),
  validate: (project: Project) =>
    request<{
      valid: boolean;
      project: Project;
      input_hash: string;
      diagnostics: { severity: string; message: string }[];
    }>("/validate", { method: "POST", body: JSON.stringify(project) }),
  snapshot: (jobId: string) =>
    request<SavedProject>("/snapshots", {
      method: "POST",
      body: JSON.stringify({ job_id: jobId }),
    }),
  start: (project: Project) =>
    request<Job>("/jobs", {
      method: "POST",
      body: JSON.stringify({ kind: "forward", project }),
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
  list: () => request<SavedSummary[]>("/projects"),
  load: (id: string) =>
    request<SavedProject>(`/projects/${encodeURIComponent(id)}`),
  save: (project: Project, result: ForwardResult | null) =>
    request<SavedProject>("/projects", {
      method: "POST",
      body: JSON.stringify({ project, result }),
    }),
};
