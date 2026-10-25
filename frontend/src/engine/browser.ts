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

export interface FieldMap {
  wavelength_nm: number;
  polarization: "s" | "p";
  x_nm: number[];
  y_nm: number[];
  depth_nm: number[];
  layer_tops_nm: number[];
  layer_indices: number[];
  xz: number[][];
  /** The x–z cut is taken through the cell centre line. */
  xz_y_nm: number;
  xy: number[][][];
  /** Depth of each layer's mid-plane x–y cut. */
  xy_depth_nm: number[];
  R: number;
  T: number;
  max_intensity: number;
  note: string;
}

export interface FitParameter {
  path: (string | number)[];
  lower: number;
  upper: number;
  linked?: (string | number)[][];
}

export interface FitSpec {
  parameters: FitParameter[];
  wavelengths_nm: number[];
  values: number[];
  quantity: "R" | "T" | "R_specular" | "T_specular";
  polarization: "s" | "p" | "avg";
}

export interface FitResult {
  values: number[];
  sigma: (number | null)[];
  at_bound: boolean[];
  rms: number;
  wavelengths_nm: number[];
  fitted: number[];
  evaluations: number;
  history: { x: number[]; rms: number }[];
  elapsed_seconds: number;
  note: string;
  /** Forward warnings for the fitted design. */
  warnings: string[];
}

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

  /** |E|² maps at one wavelength; the design's own spectrum must not exceed one request. */
  field(design: Design, wavelength: number, polarization: "s" | "p", resolution: number, options: SolveOptions = {}) {
    const single = { ...design, illumination: { ...design.illumination, wavelengths_nm: [wavelength] } };
    return this.call<FieldMap>("field", [JSON.stringify(single), wavelength, polarization, resolution], options);
  }

  fit(design: Design, spec: FitSpec, options: SolveOptions = {}) {
    return this.call<FitResult>("fit", [JSON.stringify({ ...design, illumination: { ...design.illumination, wavelengths_nm: spec.wavelengths_nm } }), JSON.stringify(spec)], options);
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
