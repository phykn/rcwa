import { chunkDesign, mergeResults } from "./chunks";
import { EngineError, type Design, type Diagnostic, type Engine, type PublicForwardResult2D, type SolveOptions } from "./types";

interface Job<R = PublicForwardResult2D> {
  id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  result: R | null;
  error: string | null;
  error_code: string | null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

/** The local FastAPI solver: native BLAS, same rcwa_core. */
export class ServerEngine implements Engine {
  readonly kind = "server" as const;

  constructor(private base: string) {}

  static async probe(base: string, timeoutMs = 1500): Promise<ServerEngine | null> {
    try {
      const response = await fetch(`${base}/api/capabilities`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const body = (await response.json()) as { supported_project_schema_versions?: string[] };
      return body.supported_project_schema_versions?.includes("1.2") ? new ServerEngine(base) : null;
    } catch {
      return null;
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const { detail, error } = body as {
        detail?: { code?: string; message?: string; diagnostics?: Diagnostic[] } | string;
        error?: { code?: string; message?: string; diagnostics?: Diagnostic[] };
      };
      // Current API errors carry a typed `error`; `detail` stays for older servers.
      if (error?.code) throw new EngineError(error.code, error.message ?? "Server rejected the request", error.diagnostics);
      if (typeof detail === "object" && detail)
        throw new EngineError(detail.code ?? "server_error", detail.message ?? "Server rejected the request", detail.diagnostics);
      throw new EngineError("server_error", typeof detail === "string" ? detail : `Server error ${response.status}`);
    }
    return body as T;
  }

  async validate(design: Design) {
    const diagnostics: Diagnostic[] = [];
    for (const chunk of chunkDesign(design)) {
      const body = await this.request<{ diagnostics: Diagnostic[] }>("/api/validate", {
        method: "POST",
        body: JSON.stringify(chunk),
      });
      diagnostics.push(...body.diagnostics);
    }
    return diagnostics;
  }

  async solve(design: Design, options: SolveOptions = {}) {
    const started = performance.now();
    const chunks = chunkDesign(design);
    const total = design.illumination.wavelengths_nm.length;
    let done = 0;
    options.onProgress?.(0, total);
    const results: PublicForwardResult2D[] = [];
    // The server admits two jobs; sequential chunks avoid 429 under parallel sweeps.
    for (const chunk of chunks) {
      results.push(await this.job<PublicForwardResult2D>({ kind: "forward", project: chunk }, options));
      done += chunk.illumination.wavelengths_nm.length;
      options.onProgress?.(done, total);
    }
    return mergeResults(results, "server", (performance.now() - started) / 1000);
  }

  /** Submit, poll until terminal, and cancel the server job if the caller aborts. */
  private async job<R>(body: object, options: SolveOptions): Promise<R> {
    // The POST is not aborted mid-flight: a job the server already admitted would
    // keep its slot with no id to cancel. Cancel it once the id is known instead.
    let job = await this.request<Job<R>>("/api/jobs", { method: "POST", body: JSON.stringify(body) });
    try {
      options.signal?.throwIfAborted();
      while (job.status === "running") {
        await sleep(150, options.signal);
        job = await this.request<Job<R>>(`/api/jobs/${job.id}`, { signal: options.signal });
      }
    } catch (error) {
      if (options.signal?.aborted) void this.request(`/api/jobs/${job.id}`, { method: "DELETE" }).catch(() => {});
      throw error;
    }
    if (job.status !== "succeeded" || !job.result)
      throw new EngineError(job.error_code ?? "numerical_failure", job.error ?? "Calculation failed");
    return job.result;
  }
}
