import type { Material } from "./model";
import type { Project2D } from "./project2d";
import {
  canonicalProject2D,
  hashProject2D,
  normalizeProject2D,
} from "./project2d";

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

const resultKeys = [
  "result_type",
  "schema_version",
  "wavelengths_nm",
  "spectra",
  "metadata",
  "warnings",
];
const metadataLiterals = {
  stage: "bounded_forward",
  engine: "meent",
  version: "0.13.2",
  precision: "complex128",
  backend: "numpy",
  offline_reference_override: false,
  factorization: "directional_inverse_rule",
  stack_order: "top_to_bottom",
  units: "nm; vacuum wavelength",
  convergence_checked: false,
} as const;
const metadataStrings = [
  "geometry",
  "polarization_convention",
  "port_adapter",
  "power_normalization",
  "material_interpolation",
  "regularization",
];
const metadataKeys = [
  ...Object.keys(metadataLiterals),
  "adapter_version",
  ...metadataStrings,
  "input_hash",
  "harmonics_x",
  "harmonics_y",
  "basis_size",
  "retained_orders",
  "layer_count",
  "active_slab_count",
  "total_thickness_nm",
  "max_lossless_flux_error",
  "elapsed_seconds",
];
const spectrumKeys = [
  "R",
  "T",
  "R_specular",
  "T_specular",
  "A_balance",
  "orders",
];
const orderKeys = [
  "m",
  "n",
  "R",
  "T",
  "R_s",
  "R_p",
  "T_s",
  "T_p",
  "kx_over_k0",
  "ky_over_k0",
  "reflection_propagating",
  "transmission_propagating",
  "transmission_class",
];

function invalid(message: string): never {
  // Paths and descriptions come from this module, never from untrusted keys or values.
  throw new Error(`Invalid 1.2 result: ${message.slice(0, 220)}`);
}

function object(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${path} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid(`${path} must contain plain JSON data.`);
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    invalid(`${path} has missing or unknown fields.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      invalid(`${path} must contain plain JSON data.`);
  }
  return value as Record<string, unknown>;
}

function array(
  value: unknown,
  min: number,
  max: number,
  path: string,
): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    invalid(`${path} has an invalid number of entries.`);
  // Sparse arrays, custom properties and accessors have no accepted JSON counterpart.
  if (Reflect.ownKeys(value).length !== value.length + 1)
    invalid(`${path} must be a dense JSON array.`);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      invalid(`${path} must be a dense JSON array.`);
  }
  return value;
}

function number(
  value: unknown,
  path: string,
  min = -Infinity,
  max = Infinity,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    invalid(`${path} must be a finite number within its supported range.`);
  return value;
}

function integer(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  const result = number(value, path, min, max);
  if (!Number.isInteger(result)) invalid(`${path} must be an integer.`);
  return result;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(`${path} must be a string.`);
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      invalid(`${path} must contain valid Unicode.`);
  }
  return value;
}

// Python math.isclose uses the greater of absolute and relative tolerances.
function close(actual: number, expected: number, label: string): void {
  if (
    !Number.isFinite(expected) ||
    Math.abs(actual - expected) >
      Math.max(1e-9, 1e-9 * Math.max(Math.abs(actual), Math.abs(expected)))
  )
    invalid(`${label} is inconsistent.`);
}

/** Complete public shape/internal validation only. This does not authorize display. */
export function validateForwardResult2D(value: unknown): PublicForwardResult2D {
  const result = object(value, resultKeys, "result");
  if (result.result_type !== "forward" || result.schema_version !== "1.2")
    invalid("Expected an explicit schema 1.2 forward result.");
  const wavelengths = array(result.wavelengths_nm, 1, 31, "wavelengths_nm");
  let previous = -Infinity;
  for (const value of wavelengths) {
    const wavelength = number(value, "wavelengths_nm", 200, 2500);
    if (wavelength <= previous)
      invalid("Wavelengths must be strictly increasing.");
    previous = wavelength;
  }
  const hasCircular =
    !!result.metadata &&
    typeof result.metadata === "object" &&
    Object.prototype.hasOwnProperty.call(result.metadata, "circular_geometry");
  const meta = object(
    result.metadata,
    hasCircular ? [...metadataKeys, "circular_geometry"] : metadataKeys,
    "metadata",
  );
  if (hasCircular) {
    if (meta.adapter_version === "1.2.0")
      invalid("Circular geometry requires adapter 1.3.0 or later.");
    const circle = object(
      meta.circular_geometry,
      [
        "method",
        "strips",
        "offline_spatial_override",
        "area_bound_is_optical_error_bound",
        "layers",
      ],
      "metadata.circular_geometry",
    );
    if (
      circle.method !== "centered_midpoint_strips" ||
      circle.strips !== 64 ||
      circle.offline_spatial_override !== false ||
      circle.area_bound_is_optical_error_bound !== false
    )
      invalid(
        "Unsupported circular geometry discretization or convergence claim.",
      );
    let prior = -1;
    for (const entry of array(
      circle.layers,
      1,
      8,
      "circular geometry layers",
    )) {
      const item = object(
        entry,
        [
          "layer_index",
          "exact_area_nm2",
          "approximate_area_nm2",
          "symmetric_difference_area_bound_nm2",
        ],
        "circular geometry layer",
      );
      const index = integer(item.layer_index, "circular layer_index", 0, 7);
      if (index <= prior)
        invalid("Circular geometry layers must be unique and ordered.");
      prior = index;
      for (const key of [
        "exact_area_nm2",
        "approximate_area_nm2",
        "symmetric_difference_area_bound_nm2",
      ])
        number(item[key], `circular geometry ${key}`, 0);
    }
  }
  for (const [key, value] of Object.entries(metadataLiterals))
    if (meta[key] !== value) invalid(`metadata.${key} is unsupported.`);
  if (
    meta.adapter_version !== "1.2.0" &&
    meta.adapter_version !== "1.3.0" &&
    meta.adapter_version !== "1.4.0"
  )
    invalid("metadata.adapter_version is unsupported.");
  for (const key of metadataStrings) string(meta[key], `metadata.${key}`);
  const hash = string(meta.input_hash, "metadata.input_hash");
  if (!/^[0-9a-f]{64}$/.test(hash))
    invalid("metadata.input_hash must be a lowercase SHA-256 hash.");
  const hx = integer(meta.harmonics_x, "metadata.harmonics_x", 1, 5);
  const hy = integer(meta.harmonics_y, "metadata.harmonics_y", 1, 5);
  const basisSize = integer(meta.basis_size, "metadata.basis_size", 9, 121);
  const expectedSize = (2 * hx + 1) * (2 * hy + 1);
  const labels = array(
    meta.retained_orders,
    9,
    121,
    "metadata.retained_orders",
  );
  if (basisSize !== expectedSize || labels.length !== expectedSize)
    invalid("Declared basis must be complete, x fast and y slow.");
  for (let i = 0; i < labels.length; i++) {
    const pair = array(labels[i], 2, 2, "metadata.retained_orders entry");
    if (
      integer(pair[0], "retained m", -5, 5) !== (i % (2 * hx + 1)) - hx ||
      integer(pair[1], "retained n", -5, 5) !==
        Math.floor(i / (2 * hx + 1)) - hy
    )
      invalid("Declared basis must be complete, x fast and y slow.");
  }
  integer(meta.layer_count, "metadata.layer_count", 1, 8);
  integer(meta.active_slab_count, "metadata.active_slab_count", 0, 8);
  number(meta.total_thickness_nm, "metadata.total_thickness_nm", 0, 16000);
  number(meta.elapsed_seconds, "metadata.elapsed_seconds", 0);
  if (meta.max_lossless_flux_error !== null)
    number(
      meta.max_lossless_flux_error,
      "metadata.max_lossless_flux_error",
      0,
      1e-6,
    );
  for (const warning of array(result.warnings, 0, Infinity, "warnings"))
    string(warning, "warnings entry");

  if (
    !result.spectra ||
    typeof result.spectra !== "object" ||
    Array.isArray(result.spectra)
  )
    invalid("spectra must contain incident s and/or p spectra.");
  const pols = Object.keys(result.spectra);
  if (
    pols.length < 1 ||
    pols.length > 2 ||
    pols.some((pol) => pol !== "s" && pol !== "p")
  )
    invalid("spectra must contain incident s and/or p spectra.");
  const spectra = object(result.spectra, pols, "spectra");
  for (const pol of pols) {
    const series = object(spectra[pol], spectrumKeys, `spectra.${pol}`);
    for (const key of spectrumKeys) {
      const values = array(
        series[key],
        wavelengths.length,
        wavelengths.length,
        `spectra.${pol}.${key}`,
      );
      if (key !== "orders")
        for (const value of values) number(value, `spectra.${pol}.${key}`);
    }
    const typed = series as unknown as PublicSpectrum2D;
    for (let wi = 0; wi < wavelengths.length; wi++) {
      const orders = array(
        typed.orders[wi],
        expectedSize,
        expectedSize,
        `spectra.${pol}.orders`,
      );
      let reflected = 0,
        transmitted = 0;
      for (let oi = 0; oi < orders.length; oi++) {
        const order = object(orders[oi], orderKeys, "order");
        if (
          integer(order.m, "order.m", -5, 5) !== (oi % (2 * hx + 1)) - hx ||
          integer(order.n, "order.n", -5, 5) !==
            Math.floor(oi / (2 * hx + 1)) - hy
        )
          invalid("Order labels must match the complete declared 2D basis.");
        for (const key of ["R", "T", "R_s", "R_p", "T_s", "T_p"])
          number(order[key], `order.${key}`, -1e-8);
        number(order.kx_over_k0, "order.kx_over_k0");
        number(order.ky_over_k0, "order.ky_over_k0");
        if (typeof order.reflection_propagating !== "boolean")
          invalid("order.reflection_propagating must be a boolean.");
        const classification = order.transmission_class;
        if (
          classification !== "absorbing_half_space" &&
          classification !== "propagating" &&
          classification !== "evanescent"
        )
          invalid("order.transmission_class is unsupported.");
        const flag =
          classification === "absorbing_half_space"
            ? null
            : classification === "propagating";
        if (order.transmission_propagating !== flag)
          invalid("Transmission classification and propagating flag disagree.");
        const typedOrder = order as unknown as PublicOrderPower2D;
        close(
          typedOrder.R,
          typedOrder.R_s + typedOrder.R_p,
          "Reflected polarization sum",
        );
        close(
          typedOrder.T,
          typedOrder.T_s + typedOrder.T_p,
          "Transmitted polarization sum",
        );
        reflected += typedOrder.R;
        transmitted += typedOrder.T;
      }
      const zero = typed.orders[wi][Math.floor(expectedSize / 2)];
      close(typed.R[wi], reflected, "Total reflection");
      close(typed.T[wi], transmitted, "Total transmission");
      close(typed.R_specular[wi], zero.R, "Specular reflection");
      close(typed.T_specular[wi], zero.T, "Specular transmission");
      close(typed.A_balance[wi], 1 - typed.R[wi] - typed.T[wi], "Flux balance");
      if (typed.A_balance[wi] < -1e-6)
        invalid("Passive flux tolerance failed.");
    }
  }
  return value as PublicForwardResult2D;
}

export function isForwardResult2D(
  value: unknown,
): value is PublicForwardResult2D {
  try {
    validateForwardResult2D(value);
    return true;
  } catch {
    return false;
  }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

// Matching np.interp: exact knots first, then slope * offset + left ordinate.
function interpolate(
  wavelength: number,
  wavelengths: number[],
  values: number[],
): number {
  if (
    wavelength < wavelengths[0] ||
    wavelength > wavelengths[wavelengths.length - 1]
  )
    invalid("Material extrapolation is forbidden.");
  for (let i = 0; i < wavelengths.length; i++) {
    if (wavelength === wavelengths[i]) return values[i];
    if (wavelength < wavelengths[i])
      return (
        ((values[i] - values[i - 1]) / (wavelengths[i] - wavelengths[i - 1])) *
          (wavelength - wavelengths[i - 1]) +
        values[i - 1]
      );
  }
  invalid("Material interpolation failed.");
}

function index(material: Material, wavelength: number): [number, number] {
  if (material.kind === "constant") return [material.n, material.k];
  return [
    interpolate(wavelength, material.wavelengths_nm!, material.n_values!),
    interpolate(wavelength, material.wavelengths_nm!, material.k_values!),
  ];
}

function finiteStackHasLoss(project: Project2D, wavelength: number): boolean {
  for (const layer of project.layers) {
    if (layer.thickness_nm === 0) continue;
    if (layer.geometry === "homogeneous") {
      if (index(layer.material, wavelength)[1] !== 0) return true;
      continue;
    }
    if (layer.geometry === "circular_hole_2d") {
      if (layer.diameter_nm > 0 && index(layer.material, wavelength)[1] !== 0)
        return true;
      // Even a circle tangent to both cell edges leaves host-filled corners.
      if (index(layer.background, wavelength)[1] !== 0) return true;
      continue;
    }
    const wx = layer.geometry === "rectangle_1d" ? layer.cd_nm : layer.cd_x_nm;
    const wy =
      layer.geometry === "rectangle_1d" ? project.period_y_nm : layer.cd_y_nm;
    if (wx > 0 && wy > 0 && index(layer.material, wavelength)[1] !== 0)
      return true;
    if (
      (wx < project.period_nm || wy < project.period_y_nm) &&
      index(layer.background, wavelength)[1] !== 0
    )
      return true;
  }
  return false;
}

function matchProject(project: Project2D, result: PublicForwardResult2D): void {
  const meta = result.metadata;
  if (
    project.layers.some((layer) => layer.geometry === "circular_hole_2d") &&
    meta.adapter_version === "1.2.0"
  )
    invalid("Circular-hole results require adapter 1.3.0 or later.");
  if (
    meta.harmonics_x !== project.solver.harmonics_x ||
    meta.harmonics_y !== project.solver.harmonics_y
  )
    invalid("Result basis differs from the requested basis.");
  const circles = project.layers.flatMap((layer, layer_index) =>
    layer.geometry === "circular_hole_2d" ? [{ layer, layer_index }] : [],
  );
  if (circles.length > 0 !== !!meta.circular_geometry)
    invalid("Circular geometry metadata differs from the request.");
  if (meta.circular_geometry) {
    if (meta.circular_geometry.layers.length !== circles.length)
      invalid("Circular layer count differs from the request.");
    circles.forEach(({ layer, layer_index }, i) => {
      const item = meta.circular_geometry!.layers[i];
      if (item.layer_index !== layer_index)
        invalid("Circular layer index differs from the request.");
      const d = layer.diameter_nm,
        radius = d / 2;
      // Match the documented symmetric midpoint construction without squaring
      // tiny radii before sqrt; allow only binary64 summation roundoff below.
      const widths = Array.from({ length: 32 }, (_, j) => {
        const y = (j + 0.5) / 64 - 0.5;
        return d * Math.sqrt(1 - (2 * y) ** 2);
      });
      const approximate =
        ([...widths, ...[...widths].reverse()].reduce(
          (sum, width) => sum + width,
          0,
        ) *
          d) /
        64;
      function circleAreaClose(
        actual: number,
        expected: number,
        label: string,
      ) {
        const tolerance = Math.max(
          64 * Number.MIN_VALUE,
          64 * Number.EPSILON * Math.max(Math.abs(actual), Math.abs(expected)),
        );
        if (
          !Number.isFinite(expected) ||
          Math.abs(actual - expected) > tolerance
        )
          invalid(`${label} is inconsistent.`);
      }
      circleAreaClose(
        item.exact_area_nm2,
        Math.PI * radius * radius,
        "Circular exact area",
      );
      circleAreaClose(
        item.approximate_area_nm2,
        approximate,
        "Circular approximate area",
      );
      circleAreaClose(
        item.symmetric_difference_area_bound_nm2,
        (d * d) / 64 +
          64 * Number.EPSILON * project.period_nm * project.period_y_nm,
        "Circular area bound",
      );
    });
  }
  const wavelengths = project.illumination.wavelengths_nm;
  if (
    wavelengths.length !== result.wavelengths_nm.length ||
    wavelengths.some((wl, i) => wl !== result.wavelengths_nm[i])
  )
    invalid("Result wavelengths differ from the request.");
  const pols =
    project.illumination.polarization === "both"
      ? (["s", "p"] as const)
      : [project.illumination.polarization];
  if (
    Object.keys(result.spectra).length !== pols.length ||
    pols.some((pol) => !result.spectra[pol])
  )
    invalid("Result incident polarizations differ from the request.");
  if (
    meta.layer_count !== project.layers.length ||
    meta.active_slab_count !==
      project.layers.filter((layer) => layer.thickness_nm > 0).length
  )
    invalid("Layer metadata differs from the request.");
  close(
    meta.total_thickness_nm,
    project.layers.reduce((sum, layer) => sum + layer.thickness_nm, 0),
    "Total thickness",
  );
  const theta = project.illumination.angle_deg * (Math.PI / 180);
  const phi = project.illumination.azimuth_deg * (Math.PI / 180);
  let anyLoss = false,
    maxError = 0;
  for (let wi = 0; wi < wavelengths.length; wi++) {
    const wl = wavelengths[wi];
    const [n0] = index(project.ambient, wl);
    const [ns, ks] = index(project.substrate, wl);
    const hasLoss = finiteStackHasLoss(project, wl);
    anyLoss ||= hasLoss;
    for (const pol of pols) {
      const spectrum = result.spectra[pol]!;
      for (const order of spectrum.orders[wi]) {
        const x =
          n0 * Math.sin(theta) * Math.cos(phi) +
          (order.m * wl) / project.period_nm;
        const y =
          n0 * Math.sin(theta) * Math.sin(phi) +
          (order.n * wl) / project.period_y_nm;
        close(order.kx_over_k0, x, "Order kx");
        close(order.ky_over_k0, y, "Order ky");
        const qr = n0 ** 2 - x * x - y * y;
        const qt = ns ** 2 - ks ** 2 - x * x - y * y;
        // Match the backend preflight's exact-cutoff exclusion (1e-10).
        // Different browser/NumPy trig rounding can flip a near-zero sign;
        // accepting either claimed classification here would weaken binding.
        if (Math.abs(qr) < 1e-10 || (ks === 0 && Math.abs(qt) < 1e-10))
          invalid(
            "Local order classification is ambiguous at a Rayleigh cutoff; import the project without its result.",
          );
        if (order.reflection_propagating !== qr > 0)
          invalid("Reflection classification differs from the input.");
        const expected =
          ks !== 0
            ? "absorbing_half_space"
            : qt > 0
              ? "propagating"
              : "evanescent";
        if (order.transmission_class !== expected)
          invalid("Transmission classification differs from the input.");
        if (
          (qr < 0 && Math.abs(order.R) > 1e-9) ||
          (ks === 0 && qt < 0 && Math.abs(order.T) > 1e-9)
        )
          invalid("Evanescent lossless orders cannot carry normal power.");
      }
      if (!hasLoss) {
        maxError = Math.max(maxError, Math.abs(spectrum.A_balance[wi]));
        if (Math.abs(spectrum.A_balance[wi]) > 1e-6)
          invalid("Lossless flux tolerance failed.");
      }
    }
  }
  if (anyLoss) {
    if (meta.max_lossless_flux_error !== null)
      invalid("Lossy finite stacks must not claim lossless flux validation.");
  } else {
    if (meta.max_lossless_flux_error === null)
      invalid("Lossless finite stacks must report their lossless flux error.");
    close(
      meta.max_lossless_flux_error,
      maxError,
      "Maximum lossless flux error",
    );
  }
}

// This is a local integrity capability, never server-computed provenance.
const bindings = new WeakMap<PublicForwardResult2D, string>();

/** Bind a private immutable snapshot; neither later caller mutation nor a copied result inherits it. */
export async function bindResult2D(
  project: Project2D,
  value: unknown,
): Promise<PublicForwardResult2D> {
  const captured = freezeDeep(normalizeProject2D(project));
  const canonical = canonicalProject2D(captured);
  const result = structuredClone(validateForwardResult2D(value));
  // Python schema integers canonicalize signed zero; retain -0 on float fields.
  if (result.metadata.active_slab_count === 0)
    result.metadata.active_slab_count = 0;
  for (const pair of result.metadata.retained_orders) {
    if (pair[0] === 0) pair[0] = 0;
    if (pair[1] === 0) pair[1] = 0;
  }
  for (const spectrum of Object.values(result.spectra))
    for (const orders of spectrum.orders)
      for (const order of orders) {
        if (order.m === 0) order.m = 0;
        if (order.n === 0) order.n = 0;
      }
  freezeDeep(result);
  matchProject(captured, result);
  const hash = await hashProject2D(captured);
  if (result.metadata.input_hash !== hash)
    invalid("2D result input hash mismatch.");
  bindings.set(result, canonical);
  return result;
}

/** Synchronous installation is restricted to the exact successfully bound, frozen identity. */
export function boundResult2DCompatibilityError(
  project: Project2D,
  value: unknown,
): string | null {
  if (!value || typeof value !== "object" || !Object.isFrozen(value))
    return "The 1.2 result must be validated and bound to its project before use.";
  const canonical = bindings.get(value as PublicForwardResult2D);
  if (canonical === undefined)
    return "The 1.2 result must be validated and bound to its project before use.";
  try {
    return canonicalProject2D(project) === canonical
      ? null
      : "The 1.2 result belongs to a different project.";
  } catch {
    return "The 1.2 result cannot be paired with an invalid project.";
  }
}
