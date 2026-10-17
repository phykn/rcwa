/** Strict schema-1.2 input boundary. Legacy parsing/identity deliberately stays separate. */
import type { HomogeneousLayer, Material, RectangleLayer } from "./model";

export interface Rectangle2DLayer {
  name: string;
  geometry: "rectangle_2d";
  thickness_nm: number;
  cd_x_nm: number;
  cd_y_nm: number;
  material: Material;
  background: Material;
}
export interface CircularHole2DLayer {
  name: string;
  geometry: "circular_hole_2d";
  thickness_nm: number;
  diameter_nm: number;
  /** Material inside the hole; background is the surrounding host. */
  material: Material;
  background: Material;
}
export type Layer2D =
  Rectangle2DLayer | CircularHole2DLayer | RectangleLayer | HomogeneousLayer;
export interface Project2D {
  schema_version: "1.2";
  name: string;
  period_nm: number;
  period_y_nm: number;
  ambient: Material;
  substrate: Material;
  layers: Layer2D[];
  illumination: {
    wavelengths_nm: number[];
    angle_deg: number;
    azimuth_deg: number;
    polarization: "s" | "p" | "both";
  };
  solver: { harmonics_x: number; harmonics_y: number };
}

type RecordValue = Record<string, unknown>;
const own = (o: object, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k);
function fail(path: string, message: string): never {
  throw new Error(`Schema 1.2 ${path.slice(0, 180)}: ${message}`);
}
function record(
  value: unknown,
  path: string,
  keys: readonly string[],
): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail(path, "expected an object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail(path, "expected plain JSON data.");
  const o = value as RecordValue;
  for (const key of Reflect.ownKeys(o)) {
    if (typeof key !== "string" || !keys.includes(key))
      fail(path, `unknown field ${String(key).slice(0, 80)}.`);
    const descriptor = Object.getOwnPropertyDescriptor(o, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail(path, "expected plain JSON fields, without accessors.");
  }
  return o;
}
function field(o: RecordValue, key: string, fallback?: unknown): unknown {
  return own(o, key) ? o[key] : fallback;
}
function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function str(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== "string" || !validUnicode(value))
    return fail(path, "expected a valid Unicode string.");
  const length = [...value].length;
  if (length < min || length > max)
    fail(path, `use ${min}–${max} Unicode characters.`);
  return value;
}
function num(
  value: unknown,
  path: string,
  min = -Infinity,
  max = Infinity,
): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return fail(
      path,
      "expected a finite number, without string or boolean coercion.",
    );
  if (value < min || value > max)
    fail(path, `must be between ${min} and ${max}.`);
  return value;
}
function integer(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  const n = num(value, path, min, max);
  if (!Number.isInteger(n)) fail(path, "expected an integer.");
  return n === 0 ? 0 : n;
}
function arr(
  value: unknown,
  path: string,
  min: number,
  max: number,
): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    return fail(path, `expected ${min}–${max} entries.`);
  if (Reflect.ownKeys(value).length !== value.length + 1)
    fail(path, "expected a dense JSON array without extra fields.");
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail(path, "expected a dense JSON array without accessors.");
  }
  return value;
}
function numbers(
  value: unknown,
  path: string,
  minLength: number,
  maxLength: number,
  min = -Infinity,
  max = Infinity,
): number[] {
  return arr(value, path, minLength, maxLength).map((n, i) =>
    num(n, `${path}[${i}]`, min, max),
  );
}
function increasing(values: number[], path: string): void {
  if (values.some((n, i) => i > 0 && n <= values[i - 1]))
    fail(path, "values must be strictly increasing.");
}
function material(value: unknown, path: string): Material {
  const o = record(value, path, [
    "name",
    "kind",
    "n",
    "k",
    "wavelengths_nm",
    "n_values",
    "k_values",
    "source",
  ]);
  const kind = field(o, "kind", "constant");
  if (kind !== "constant" && kind !== "tabulated")
    fail(`${path}.kind`, "expected constant or tabulated.");
  const n = num(field(o, "n", 1), `${path}.n`, 0, 10);
  if (n === 0) fail(`${path}.n`, "must be greater than zero.");
  const result: Material = {
    name: str(field(o, "name", "Synthetic material"), `${path}.name`, 1, 100),
    kind,
    n,
    k: num(field(o, "k", 0), `${path}.k`, 0, 10),
    wavelengths_nm: null,
    n_values: null,
    k_values: null,
    source: str(
      field(o, "source", "User-defined synthetic optical constants"),
      `${path}.source`,
      0,
      500,
    ),
  };
  for (const key of ["wavelengths_nm", "n_values", "k_values"] as const) {
    const column = field(o, key, null);
    if (column !== null)
      result[key] = numbers(column, `${path}.${key}`, 2, 2000);
  }
  const { wavelengths_nm: ws, n_values: ns, k_values: ks } = result;
  if (kind === "constant") {
    if (ws !== null || ns !== null || ks !== null)
      fail(path, "constant materials must not contain a table.");
  } else {
    if (!ws || !ns || !ks)
      fail(path, "tabulated materials require all three columns.");
    if (ws.length !== ns.length || ws.length !== ks.length)
      fail(path, "table column lengths must match.");
    if (ws.some((v) => v <= 0))
      fail(`${path}.wavelengths_nm`, "values must be positive.");
    increasing(ws, `${path}.wavelengths_nm`);
    if (ns.some((v) => v <= 0 || v > 10) || ks.some((v) => v < 0 || v > 10))
      fail(path, "table values require 0 < n ≤ 10 and 0 ≤ k ≤ 10.");
  }
  return result;
}

export function normalizeProject2D(value: unknown): Project2D {
  const o = record(value, "project", [
    "schema_version",
    "name",
    "period_nm",
    "period_y_nm",
    "ambient",
    "substrate",
    "layers",
    "illumination",
    "solver",
  ]);
  if (o.schema_version !== "1.2")
    fail("schema_version", "explicit 1.2 is required.");
  const px = num(o.period_nm, "period_nm", 20, 5000);
  const py = num(o.period_y_nm, "period_y_nm", 20, 5000);
  const layers = arr(o.layers, "layers", 1, 8).map((value, i): Layer2D => {
    const path = `layers[${i}]`;
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(path, "expected a layer object.");
    const tag = (value as RecordValue).geometry;
    if (
      ![
        "circular_hole_2d",
        "rectangle_2d",
        "rectangle_1d",
        "homogeneous",
      ].includes(tag as string)
    )
      fail(
        `${path}.geometry`,
        "an explicit circular_hole_2d, rectangle_2d, rectangle_1d or homogeneous tag is required.",
      );
    const keys = ["geometry", "name", "thickness_nm", "material"];
    if (tag !== "homogeneous")
      keys.push(
        "background",
        ...(tag === "circular_hole_2d"
          ? ["diameter_nm"]
          : tag === "rectangle_2d"
            ? ["cd_x_nm", "cd_y_nm"]
            : ["cd_nm"]),
      );
    const l = record(value, path, keys);
    const name = str(
      field(
        l,
        "name",
        tag === "circular_hole_2d"
          ? "Synthetic circular hole"
          : tag === "rectangle_2d"
            ? "Synthetic rectangular pattern"
            : tag === "rectangle_1d"
              ? "Patterned layer"
              : "Homogeneous layer",
      ),
      `${path}.name`,
      1,
      100,
    );
    const thickness_nm = num(
      field(
        l,
        "thickness_nm",
        tag === "rectangle_2d" || tag === "circular_hole_2d" ? 90 : 160,
      ),
      `${path}.thickness_nm`,
      0,
      2000,
    );
    const mat = material(
      field(
        l,
        "material",
        tag === "rectangle_2d" || tag === "circular_hole_2d"
          ? undefined
          : { name: "Synthetic dielectric", n: 2.1 },
      ),
      `${path}.material`,
    );
    if (tag === "homogeneous")
      return { geometry: tag, name, thickness_nm, material: mat };
    const background = material(
      field(
        l,
        "background",
        tag === "rectangle_2d" || tag === "circular_hole_2d"
          ? undefined
          : { name: "Air", n: 1 },
      ),
      `${path}.background`,
    );
    if (tag === "circular_hole_2d")
      return {
        geometry: tag,
        name,
        thickness_nm,
        material: mat,
        background,
        diameter_nm: num(
          l.diameter_nm,
          `${path}.diameter_nm`,
          0,
          Math.min(px, py),
        ),
      };
    if (tag === "rectangle_1d")
      return {
        geometry: tag,
        name,
        thickness_nm,
        material: mat,
        background,
        cd_nm: num(field(l, "cd_nm", 180), `${path}.cd_nm (X width)`, 0, px),
      };
    return {
      geometry: "rectangle_2d",
      name,
      thickness_nm,
      material: mat,
      background,
      cd_x_nm: num(l.cd_x_nm, `${path}.cd_x_nm (X width)`, 0, px),
      cd_y_nm: num(l.cd_y_nm, `${path}.cd_y_nm (Y width)`, 0, py),
    };
  });
  const light = record(o.illumination, "illumination", [
    "wavelengths_nm",
    "angle_deg",
    "azimuth_deg",
    "polarization",
  ]);
  const ws = numbers(
    light.wavelengths_nm,
    "illumination.wavelengths_nm",
    1,
    31,
    200,
    2500,
  );
  increasing(ws, "illumination.wavelengths_nm");
  const polarization = field(light, "polarization", "both");
  if (polarization !== "s" && polarization !== "p" && polarization !== "both")
    fail("illumination.polarization", "expected s, p or both.");
  const azimuth = num(
    field(light, "azimuth_deg", 0),
    "illumination.azimuth_deg",
    0,
    360,
  );
  if (azimuth === 360)
    fail("illumination.azimuth_deg", "must be less than 360.");
  const solver = record(field(o, "solver", {}), "solver", [
    "harmonics_x",
    "harmonics_y",
  ]);
  const ambient = material(
    field(o, "ambient", { name: "Air", n: 1 }),
    "ambient",
  );
  const substrate = material(
    field(o, "substrate", { name: "Synthetic substrate", n: 1.5 }),
    "substrate",
  );
  if (
    ambient.kind === "constant"
      ? ambient.k !== 0
      : ambient.k_values!.some((k) => k !== 0)
  )
    fail("ambient", "the incident ambient must be lossless.");
  const allMaterials: [Material, string][] = [
    [ambient, "ambient"],
    [substrate, "substrate"],
  ];
  layers.forEach((l, i) => {
    allMaterials.push([l.material, `layers[${i}].material`]);
    if (l.geometry !== "homogeneous")
      allMaterials.push([l.background, `layers[${i}].background`]);
  });
  for (const [m, path] of allMaterials) {
    if (
      m.kind === "tabulated" &&
      (ws[0] < m.wavelengths_nm![0] ||
        ws[ws.length - 1] > m.wavelengths_nm![m.wavelengths_nm!.length - 1])
    )
      fail(
        path,
        "wavelength outside material table; extrapolation is forbidden (including unused materials).",
      );
  }
  return {
    schema_version: "1.2",
    name: str(field(o, "name", "Synthetic 2D stack"), "name", 1, 100),
    period_nm: px,
    period_y_nm: py,
    ambient,
    substrate,
    layers,
    illumination: {
      wavelengths_nm: ws,
      angle_deg: num(
        field(light, "angle_deg", 15),
        "illumination.angle_deg",
        0,
        75,
      ),
      azimuth_deg: azimuth,
      polarization,
    },
    solver: {
      harmonics_x: integer(
        field(solver, "harmonics_x", 3),
        "solver.harmonics_x",
        1,
        5,
      ),
      harmonics_y: integer(
        field(solver, "harmonics_y", 3),
        "solver.harmonics_y",
        1,
        5,
      ),
    },
  };
}
export function validateProject2D(value: unknown): string[] {
  try {
    normalizeProject2D(value);
    return [];
  } catch (error) {
    return [
      error instanceof Error
        ? error.message.slice(0, 400)
        : "Invalid schema 1.2 project.",
    ];
  }
}

/** Python float repr for this contract's binary64 fields. Find the nearest
 * shortest decimal using exact integer ratios and ties-to-even, then apply
 * Python's fixed/scientific formatting thresholds. No locale or toPrecision. */
export function pythonFloat2D(value: number): string {
  if (!Number.isFinite(value))
    return fail("number", "nonfinite values are forbidden.");
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const x = Math.abs(value);
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = biased === 0 ? fraction : fraction + (1n << 52n);
  const exponent = (biased === 0 ? -1022 : biased - 1023) - 52;
  const numerator = exponent >= 0 ? mantissa << BigInt(exponent) : mantissa;
  const denominator = exponent < 0 ? 1n << BigInt(-exponent) : 1n;
  const power10 = (n: number) => 10n ** BigInt(n);
  const comparePower = (p: number) =>
    p >= 0
      ? numerator - denominator * power10(p)
      : numerator * power10(-p) - denominator;
  let decimalExponent = Math.floor(Math.log10(x));
  while (comparePower(decimalExponent) < 0n) decimalExponent--;
  while (comparePower(decimalExponent + 1) >= 0n) decimalExponent++;
  let digits = "";
  let scale = 0;
  for (let precision = 1; precision <= 17; precision++) {
    scale = decimalExponent - precision + 1;
    const a = scale < 0 ? numerator * power10(-scale) : numerator;
    const b = scale > 0 ? denominator * power10(scale) : denominator;
    let q = a / b;
    const r = a % b;
    if (2n * r > b || (2n * r === b && q % 2n !== 0n)) q++;
    if (Number(`${q}e${scale}`) === x) {
      digits = q.toString();
      break;
    }
  }
  if (!digits)
    return fail("number", "could not establish canonical float identity.");
  while (digits.length > 1 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    scale++;
  }
  const scientificExponent = digits.length - 1 + scale;
  if (scientificExponent < -4 || scientificExponent >= 16) {
    const tail = digits.length > 1 ? `.${digits.slice(1)}` : "";
    return `${sign}${digits[0]}${tail}e${scientificExponent < 0 ? "-" : "+"}${Math.abs(scientificExponent).toString().padStart(2, "0")}`;
  }
  const point = digits.length + scale;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length)
    return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
function canonicalNormalized(project: Project2D): string {
  function encode(value: unknown, path: string[]): string {
    if (typeof value === "number")
      return path.length === 2 && path[0] === "solver"
        ? String(value)
        : pythonFloat2D(value);
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string"
    )
      return JSON.stringify(value);
    if (Array.isArray(value))
      return `[${value.map((v, i) => encode(v, [...path, String(i)])).join(",")}]`;
    const o = value as RecordValue;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${encode(o[k], [...path, k])}`)
      .join(",")}}`;
  }
  return encode(project, []);
}
export function canonicalProject2D(value: unknown): string {
  return canonicalNormalized(normalizeProject2D(value));
}
export function canonicalProject2DBytes(
  value: unknown,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalProject2D(value));
}
export async function hashProject2D(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle)
    fail(
      "identity",
      "SHA-256 verification requires a secure browser context; project-only editing is still available.",
    );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    canonicalProject2DBytes(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function sameProject2D(a: unknown, b: unknown): boolean {
  try {
    return canonicalProject2D(a) === canonicalProject2D(b);
  } catch {
    return false;
  }
}

/** A compact wire writer, not a canonical serializer. Preserve negative zero
 * through POST/export, where JSON.stringify would silently change the input. */
export function stringify2DEnvelope(value: unknown): string {
  const seen = new Set<object>();
  function encode(v: unknown, depth: number): string {
    if (depth > 64) return fail("JSON", "nesting exceeds the supported limit.");
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number") {
      if (!Number.isFinite(v))
        return fail("JSON", "nonfinite numbers are forbidden.");
      return Object.is(v, -0) ? "-0.0" : JSON.stringify(v);
    }
    if (typeof v === "string") {
      if (!validUnicode(v))
        return fail("JSON", "lone Unicode surrogates are forbidden.");
      return JSON.stringify(v);
    }
    if (typeof v !== "object")
      return fail("JSON", "only JSON values are supported.");
    if (seen.has(v)) return fail("JSON", "cyclic values are forbidden.");
    seen.add(v);
    const output = Array.isArray(v)
      ? `[${v.map((item) => encode(item, depth + 1)).join(",")}]`
      : `{${Object.entries(v)
          .map(
            ([k, item]) => `${encode(k, depth + 1)}:${encode(item, depth + 1)}`,
          )
          .join(",")}}`;
    seen.delete(v);
    return output;
  }
  return encode(value, 0);
}

type JsonPath = (string | number)[];
function isIntegerPath(path: JsonPath): boolean {
  if (path.length === 2 && path[0] === "solver")
    return path[1] === "harmonics_x" || path[1] === "harmonics_y";
  if (path[0] === "metadata") {
    if (path.length === 2)
      return [
        "harmonics_x",
        "harmonics_y",
        "basis_size",
        "layer_count",
        "active_slab_count",
      ].includes(String(path[1]));
    if (
      path.length === 3 &&
      path[1] === "circular_geometry" &&
      path[2] === "strips"
    )
      return true;
    if (
      path.length === 5 &&
      path[1] === "circular_geometry" &&
      path[2] === "layers" &&
      typeof path[3] === "number" &&
      path[4] === "layer_index"
    )
      return true;
    return (
      path.length === 4 &&
      path[1] === "retained_orders" &&
      typeof path[2] === "number" &&
      typeof path[3] === "number"
    );
  }
  return (
    path.length === 6 &&
    path[0] === "spectra" &&
    (path[1] === "s" || path[1] === "p") &&
    path[2] === "orders" &&
    typeof path[3] === "number" &&
    typeof path[4] === "number" &&
    (path[5] === "m" || path[5] === "n")
  );
}
/** Inspect raw tokens before integer spellings and signed-zero origins vanish.
 * Actual schema-1.2 input/result subtrees fail closed on duplicate members.
 * Ignored envelope metadata and legacy inputs retain JSON.parse behavior. */
export function parseJSONWith2DNumberGate(
  text: string,
  options: { dimensionProposal?: boolean } = {},
): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("JSON", "invalid JSON syntax.");
  }
  // Only actual ingress positions participate. Unknown envelope claims are
  // intentionally ignored by legacy readers and must not opt them into 1.2.
  const candidates: JsonPath[] = [
    ["project"],
    ["result"],
    ["result_project"],
    ["validation", "project"],
    ["job", "result"],
    ["snapshot", "project"],
    ["snapshot", "result"],
    ["snapshot", "result_project"],
  ];
  const top =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RecordValue)
      : null;
  if (
    top &&
    ![
      "project",
      "result",
      "result_project",
      "validation",
      "job",
      "snapshot",
    ].some((key) => own(top, key))
  )
    candidates.unshift([]);
  function atPath(path: JsonPath): unknown {
    let value = parsed;
    for (const key of path) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
      value = (value as RecordValue)[key];
    }
    return value;
  }
  const roots: JsonPath[] = options.dimensionProposal
    ? [[]]
    : candidates.filter((path) => {
        const value = atPath(path);
        return (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          (value as RecordValue).schema_version === "1.2"
        );
      });
  if (!roots.length) return parsed;
  const prefix = (a: JsonPath, b: JsonPath) =>
    a.length <= b.length && a.every((part, i) => part === b[i]);
  const insideRoot = (path: JsonPath) =>
    roots.some((root) => prefix(root, path));
  const relevant = (path: JsonPath) =>
    roots.some((root) => prefix(root, path) || prefix(path, root));
  const tokens = new Map<string, string>();
  let at = 0;
  const whitespace = () => {
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
  };
  function stringToken(): string {
    const start = at++;
    while (at < text.length) {
      if (text[at] === "\\") {
        at += 2;
        continue;
      }
      if (text[at++] === '"')
        return JSON.parse(text.slice(start, at)) as string;
    }
    return fail("JSON", "unterminated string.");
  }
  // Skip unrelated data iteratively: ignored legacy metadata may be deep or
  // contain duplicate members, neither of which changes the actual project.
  function skipValue(): void {
    const first = text[at];
    if (first === '"') {
      stringToken();
      return;
    }
    if (first === "{" || first === "[") {
      let depth = 0;
      while (at < text.length) {
        const c = text[at];
        if (c === '"') {
          stringToken();
          continue;
        }
        at++;
        if (c === "{" || c === "[") depth++;
        if ((c === "}" || c === "]") && --depth === 0) return;
      }
      return;
    }
    while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
  }
  function scan(path: JsonPath): void {
    whitespace();
    if (!relevant(path)) {
      skipValue();
      return;
    }
    if (path.length > 64) fail("JSON", "nesting exceeds the supported limit.");
    const c = text[at];
    if (c === "{") {
      at++;
      whitespace();
      const keys = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      while (at < text.length) {
        whitespace();
        const k = stringToken();
        if (keys.has(k) && insideRoot(path))
          fail(
            "JSON",
            `duplicate member ${JSON.stringify(k).slice(0, 80)} is not accepted in a 1.2 envelope.`,
          );
        keys.add(k);
        whitespace();
        at++;
        scan([...path, k]);
        whitespace();
        if (text[at++] === "}") return;
      }
    } else if (c === "[") {
      at++;
      whitespace();
      let index = 0;
      if (text[at] === "]") {
        at++;
        return;
      }
      while (at < text.length) {
        scan([...path, index++]);
        whitespace();
        if (text[at++] === "]") return;
      }
    } else if (c === '"') {
      stringToken();
    } else {
      const start = at;
      while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
      const token = text.slice(start, at);
      if (token !== "true" && token !== "false" && token !== "null")
        tokens.set(JSON.stringify(path), token);
    }
  }
  scan([]);
  function rewrite(
    value: unknown,
    absolute: JsonPath,
    relative: JsonPath,
  ): unknown {
    if (typeof value === "number") {
      const token = tokens.get(JSON.stringify(absolute));
      if (
        (options.dimensionProposal
          ? ((relative[0] === "base_project" ||
              relative[0] === "candidate_project") &&
              isIntegerPath(relative.slice(1))) ||
            (relative.length === 4 &&
              relative[0] === "changes" &&
              relative[1] === "layers" &&
              relative[3] === "index") ||
            (relative.length === 4 &&
              relative[0] === "diagnostics" &&
              relative[2] === "location")
          : isIntegerPath(relative)) &&
        (!token || !/^-?(?:0|[1-9]\d*)$/.test(token))
      )
        fail(
          relative.join("."),
          "integer JSON token required; decimal or exponent spellings are not accepted.",
        );
      if (!Number.isFinite(value))
        fail(relative.join("."), "nonfinite values are forbidden.");
      return token === "-0" ? 0 : value;
    }
    if (typeof value === "string" && !validUnicode(value))
      fail(relative.join("."), "lone Unicode surrogates are forbidden.");
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (!validUnicode(key))
          fail(
            "JSON",
            "lone Unicode surrogates in member names are forbidden.",
          );
        const part = Array.isArray(value) ? Number(key) : key;
        const next = rewrite(child, [...absolute, part], [...relative, part]);
        Object.defineProperty(value, key, {
          value: next,
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
    }
    return value;
  }
  for (const path of roots) {
    let value = parsed;
    for (const key of path)
      value = (value as Record<string | number, unknown>)[key];
    rewrite(value, path, []);
  }
  return parsed;
}
