import type { Layer2D } from "./project2d";
import type { Design } from "../engine/types";

export type Path = (string | number)[];

export interface Parameter {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  path: Path;
  /** Paths that always move together with `path` (square lattices). */
  linked: Path[];
}

function read(design: Design, path: Path): number {
  let value: unknown = design;
  for (const key of path) value = (value as Record<string | number, unknown>)[key];
  return value as number;
}

export function getValue(design: Design, p: Parameter) {
  return read(design, p.path);
}

export function setValue(design: Design, p: Parameter, value: number): Design {
  const next = structuredClone(design);
  for (const path of [p.path, ...p.linked]) {
    let parent: Record<string | number, unknown> = next as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
    parent[path[path.length - 1]] = value;
  }
  return next;
}

function layerParameters(layer: Layer2D, i: number, design: Design): Parameter[] {
  const tag = `Layer ${i + 1}`;
  const px = design.period_nm;
  const py = design.period_y_nm;
  const out: Parameter[] = [
    { id: `l${i}-t`, label: `${tag} thickness`, unit: "nm", min: 0, max: 2000, path: ["layers", i, "thickness_nm"], linked: [] },
  ];
  if (layer.geometry === "circular_hole_2d")
    out.push({ id: `l${i}-d`, label: `${tag} hole diameter`, unit: "nm", min: 0, max: Math.min(px, py), path: ["layers", i, "diameter_nm"], linked: [] });
  if (layer.geometry === "rectangle_2d")
    out.push(
      { id: `l${i}-wx`, label: `${tag} width X`, unit: "nm", min: 0, max: px, path: ["layers", i, "cd_x_nm"], linked: [] },
      { id: `l${i}-wy`, label: `${tag} width Y`, unit: "nm", min: 0, max: py, path: ["layers", i, "cd_y_nm"], linked: [] },
    );
  if (layer.geometry === "rectangle_1d")
    out.push({ id: `l${i}-w`, label: `${tag} line width`, unit: "nm", min: 0, max: px, path: ["layers", i, "cd_nm"], linked: [] });
  return out;
}

/** Every continuous input a sweep or fit can vary, with its physical limits. */
export function parameters(design: Design): Parameter[] {
  const square = design.period_nm === design.period_y_nm;
  const features = design.layers.map((l) =>
    l.geometry === "circular_hole_2d" ? l.diameter_nm : l.geometry === "rectangle_2d" ? Math.max(l.cd_x_nm, l.cd_y_nm) : l.geometry === "rectangle_1d" ? l.cd_nm : 0,
  );
  const minPitch = Math.max(20, ...features);
  return [
    ...design.layers.flatMap((l, i) => layerParameters(l, i, design)),
    square
      ? { id: "pitch", label: "Pitch (square)", unit: "nm", min: minPitch, max: 5000, path: ["period_nm"], linked: [["period_y_nm"]] }
      : { id: "pitch-x", label: "Pitch X", unit: "nm", min: minPitch, max: 5000, path: ["period_nm"], linked: [] },
    ...(square ? [] : [{ id: "pitch-y", label: "Pitch Y", unit: "nm", min: minPitch, max: 5000, path: ["period_y_nm"], linked: [] }]),
    { id: "angle", label: "Incidence angle θ", unit: "°", min: 0, max: 75, path: ["illumination", "angle_deg"], linked: [] },
    { id: "azimuth", label: "Azimuth φ", unit: "°", min: 0, max: 359.9, path: ["illumination", "azimuth_deg"], linked: [] },
  ];
}

/** 0, n-1, then breadth-first midpoints: a coarse picture first that refines in place. */
export function refinementOrder(n: number): number[] {
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const order = [0, n - 1];
  const queue: [number, number][] = [[0, n - 1]];
  while (queue.length) {
    const [lo, hi] = queue.shift()!;
    if (hi - lo < 2) continue;
    const mid = Math.floor((lo + hi) / 2);
    order.push(mid);
    queue.push([lo, mid], [mid, hi]);
  }
  return order;
}
