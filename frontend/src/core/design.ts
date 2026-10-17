import { normalizeProject2D, type Layer2D } from "./project2d";
import type { Material } from "./model";
import type { Design } from "../engine/types";

export const MAX_DESIGN_WAVELENGTHS = 301;
export const WAVELENGTH_LIMITS: [number, number] = [200, 2500];

export function constantMaterial(name: string, n: number, k = 0): Material {
  return {
    name,
    kind: "constant",
    n,
    k,
    wavelengths_nm: null,
    n_values: null,
    k_values: null,
    source: "User-defined synthetic optical constants",
  };
}

export const AIR = constantMaterial("Air", 1);

/** Evenly spaced, strictly increasing wavelengths rounded to 0.01 nm. */
export function wavelengthRange(start: number, end: number, points: number): number[] {
  if (points <= 1 || end <= start) return [start];
  const step = (end - start) / (points - 1);
  return Array.from({ length: points }, (_, i) => Math.round((start + i * step) * 100) / 100);
}

export function describeRange(wavelengths: number[]) {
  const start = wavelengths[0];
  const end = wavelengths[wavelengths.length - 1];
  const step = wavelengths.length > 1 ? (end - start) / (wavelengths.length - 1) : 0;
  const uniform = wavelengths.every((w, i) => Math.abs(w - (start + i * step)) < 0.006);
  return { start, end, points: wavelengths.length, step, uniform };
}

/** Validate a design. Spectra may exceed one request; everything else follows schema 1.2. */
export function normalizeDesign(value: unknown): Design {
  if (!value || typeof value !== "object") throw new Error("A design must be a JSON object.");
  const v = value as { illumination?: { wavelengths_nm?: unknown } };
  const ws = v.illumination?.wavelengths_nm;
  if (!Array.isArray(ws) || ws.length < 1 || ws.length > MAX_DESIGN_WAVELENGTHS)
    throw new Error(`Use 1 to ${MAX_DESIGN_WAVELENGTHS} wavelengths.`);
  ws.forEach((w, i) => {
    if (typeof w !== "number" || !Number.isFinite(w) || w < WAVELENGTH_LIMITS[0] || w > WAVELENGTH_LIMITS[1])
      throw new Error(`Wavelengths must be between ${WAVELENGTH_LIMITS[0]} and ${WAVELENGTH_LIMITS[1]} nm.`);
    if (i && w <= (ws[i - 1] as number)) throw new Error("Wavelengths must increase.");
  });
  const head = normalizeProject2D({ ...v, illumination: { ...v.illumination, wavelengths_nm: [ws[0], ws[ws.length - 1]].filter((w, i, a) => a.indexOf(w) === i) } });
  return { ...head, illumination: { ...head.illumination, wavelengths_nm: [...(ws as number[])] } };
}

/** First problem a person can fix, or null. Cheap enough to run on every edit. */
export function designError(design: Design): string | null {
  try {
    normalizeDesign(design);
    return null;
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).replace(/^Schema 1\.2 /, "");
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  return value;
}

/** Stable identity for "does this result belong to these inputs". */
export function designKey(design: Design): string {
  return JSON.stringify(sortKeys(design));
}

export function layerFeature(layer: Layer2D): number | null {
  if (layer.geometry === "circular_hole_2d") return layer.diameter_nm;
  if (layer.geometry === "rectangle_2d") return layer.cd_x_nm;
  if (layer.geometry === "rectangle_1d") return layer.cd_nm;
  return null;
}

export function newLayer(kind: Layer2D["geometry"], design: Design, index: number): Layer2D {
  const px = design.period_nm;
  const py = design.period_y_nm;
  const host = constantMaterial("Dielectric", 2.0);
  const name = `Layer ${index + 1}`;
  if (kind === "homogeneous") return { name, geometry: kind, thickness_nm: 100, material: host };
  if (kind === "circular_hole_2d")
    return { name, geometry: kind, thickness_nm: 100, diameter_nm: Math.round(Math.min(px, py) * 0.5), material: AIR, background: host };
  if (kind === "rectangle_2d")
    return { name, geometry: kind, thickness_nm: 100, cd_x_nm: Math.round(px * 0.5), cd_y_nm: Math.round(py * 0.5), material: host, background: AIR };
  return { name, geometry: kind, thickness_nm: 100, cd_nm: Math.round(px * 0.5), material: host, background: AIR };
}

/** Change a layer's shape while keeping its name, thickness and materials. */
export function convertLayer(layer: Layer2D, kind: Layer2D["geometry"], design: Design): Layer2D {
  const fresh = newLayer(kind, design, 0);
  const background = "background" in layer ? layer.background : AIR;
  const merged = { ...fresh, name: layer.name, thickness_nm: layer.thickness_nm } as Layer2D;
  // A hole layer's host is its bulk material; the hole fill is what disappears.
  const bulk = layer.geometry === "circular_hole_2d" ? layer.background : layer.material;
  if (merged.geometry === "homogeneous") return { ...merged, material: bulk };
  if (merged.geometry === "circular_hole_2d")
    return layer.geometry === "homogeneous" ? { ...merged, background: layer.material } : { ...merged, material: layer.material, background };
  if (layer.geometry === "circular_hole_2d") return { ...merged, material: layer.background, background: layer.material } as Layer2D;
  return { ...merged, material: layer.material, background } as Layer2D;
}
