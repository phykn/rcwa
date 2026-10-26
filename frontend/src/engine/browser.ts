import { chunkDesign, mergeResults } from "./chunks";
import type { WorkerPool } from "./pyodide/pool";
import type { BridgeOp, BridgeResponse } from "./pyodide/runtime";
import {
  EngineError,
  type Design,
  type Diagnostic,
  type Engine,
  type PublicForwardResult2D,
  type SolveOptions,
} from "./types";

interface Partial2D {
  wavelength_nm: number;
}

/** Shards every wavelength across the worker pool, then assembles per request chunk. */
export class BrowserEngine implements Engine {
  readonly kind = "browser" as const;

  constructor(private pool: WorkerPool) {}

  private async call<T>(op: BridgeOp, args: (string | number)[], options: SolveOptions, front = false): Promise<T> {
    const response: BridgeResponse<T> = await this.pool.run<T>(op, args, options.priority, options.signal, front);
    if (!response.ok)
      throw new EngineError(response.code, response.message, (response.diagnostics ?? []) as Diagnostic[]);
    return response.value;
  }

  async validate(design: Design): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    for (const chunk of chunkDesign(design)) {
      const value = await this.call<{ diagnostics: Diagnostic[] }>("validate", [JSON.stringify(chunk)], {});
      diagnostics.push(...value.diagnostics);
    }
    return diagnostics;
  }

  async solve(design: Design, options: SolveOptions = {}) {
    const started = performance.now();
    const chunks = chunkDesign(design);
    const total = design.illumination.wavelengths_nm.length;
    let done = 0;
    options.onProgress?.(0, total);
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const text = JSON.stringify(chunk);
        const partials = await Promise.all(
          chunk.illumination.wavelengths_nm.map(async (_, index) => {
            const [partial] = await this.call<Partial2D[]>("solve", [text, JSON.stringify([index])], options);
            options.onProgress?.(++done, total);
            return partial;
          }),
        );
        const elapsed = (performance.now() - started) / 1000;
        // Assembly finishes work already paid for, so it jumps its queue.
        return this.call<PublicForwardResult2D>("assemble", [text, JSON.stringify(partials), elapsed], options, true);
      }),
    );
    return mergeResults(results, "browser", (performance.now() - started) / 1000);
  }
}
