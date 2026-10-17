import type { Project2D } from "../core/project2d";
import type { PublicForwardResult2D, PublicSpectrum2D } from "../core/result2d";

/** An editable design: a schema-1.2 project whose spectrum may exceed one request. */
export type Design = Project2D;

export interface SpectrumResult {
  wavelengths_nm: number[];
  spectra: Partial<Record<"s" | "p", PublicSpectrum2D>>;
  warnings: string[];
  harmonics: [number, number];
  inputHashes: string[];
  elapsedSeconds: number;
  engine: "browser" | "server";
  maxLosslessFluxError: number | null;
}

export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  location: (string | number)[];
  message: string;
}

export class EngineError extends Error {
  constructor(
    public code: string,
    message: string,
    public diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface SolveOptions {
  priority?: "preview" | "interactive" | "background";
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface Engine {
  kind: "browser" | "server";
  solve(design: Design, options?: SolveOptions): Promise<SpectrumResult>;
  validate(design: Design): Promise<Diagnostic[]>;
}

export type { PublicForwardResult2D, PublicSpectrum2D };
