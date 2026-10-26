import type { Project2D } from "../core/project2d";

export interface PublicOrderPower2D {
  m: number;
  n: number;
  R: number;
  T: number;
  R_s: number;
  R_p: number;
  T_s: number;
  T_p: number;
  kx_over_k0: number;
  ky_over_k0: number;
  reflection_propagating: boolean;
  transmission_propagating: boolean | null;
  transmission_class: "absorbing_half_space" | "propagating" | "evanescent";
}

export interface PublicSpectrum2D {
  R: number[];
  T: number[];
  R_specular: number[];
  T_specular: number[];
  A_balance: number[];
  orders: PublicOrderPower2D[][];
}

export interface PublicMetadata2D extends Record<string, unknown> {
  stage: "bounded_forward";
  engine: "meent";
  version: "0.13.2";
  adapter_version: "1.2.0" | "1.3.0" | "1.4.0";
  precision: "complex128";
  backend: "numpy";
  input_hash: string;
  harmonics_x: number;
  harmonics_y: number;
  basis_size: number;
  retained_orders: [number, number][];
  offline_reference_override: false;
  factorization: "directional_inverse_rule";
  layer_count: number;
  active_slab_count: number;
  total_thickness_nm: number;
  stack_order: "top_to_bottom";
  units: "nm; vacuum wavelength";
  geometry: string;
  polarization_convention: string;
  port_adapter: string;
  power_normalization: string;
  material_interpolation: string;
  convergence_checked: false;
  max_lossless_flux_error: number | null;
  regularization: string;
  elapsed_seconds: number;
  circular_geometry?: {
    method: "centered_midpoint_strips";
    strips: 64;
    offline_spatial_override: false;
    area_bound_is_optical_error_bound: false;
    layers: {
      layer_index: number;
      exact_area_nm2: number;
      approximate_area_nm2: number;
      symmetric_difference_area_bound_nm2: number;
    }[];
  };
}

export interface PublicForwardResult2D {
  result_type: "forward";
  schema_version: "1.2";
  wavelengths_nm: number[];
  spectra: { s?: PublicSpectrum2D; p?: PublicSpectrum2D };
  metadata: PublicMetadata2D;
  warnings: string[];
}

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
