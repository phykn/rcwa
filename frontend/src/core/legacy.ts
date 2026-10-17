import type { Material } from "./model";
import type { Design } from "../engine/types";

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});

function material(value: unknown, fallback: Partial<Material>): Material {
  const m = { ...fallback, ...obj(value) } as Raw;
  return {
    name: (m.name as string) ?? "Synthetic material",
    kind: (m.kind as Material["kind"]) ?? "constant",
    n: (m.n as number) ?? 1,
    k: (m.k as number) ?? 0,
    wavelengths_nm: (m.wavelengths_nm as number[] | null) ?? null,
    n_values: (m.n_values as number[] | null) ?? null,
    k_values: (m.k_values as number[] | null) ?? null,
    source: (m.source as string) ?? "User-defined synthetic optical constants",
  };
}

export interface Conversion {
  design: Design;
  notes: string[];
}

/** Schema 1.0/1.1 (x-periodic, y-invariant) projects become 1.2 designs. */
export function convertLegacy(value: unknown): Conversion {
  const p = obj(value);
  const notes = [`Converted from schema ${(p.schema_version as string) ?? "1.0"}.`];
  const period = (p.period_nm as number) ?? 400;
  const illumination = obj(p.illumination);
  const harmonics = (obj(p.solver).harmonics as number) ?? 7;
  const layers = (Array.isArray(p.layers) ? p.layers : [{}]).map((raw) => {
    const layer = obj(raw);
    const dielectric = { name: "Synthetic dielectric", n: 2.1 };
    if (layer.geometry === "homogeneous")
      return {
        name: (layer.name as string) ?? "Homogeneous layer",
        geometry: "homogeneous" as const,
        thickness_nm: (layer.thickness_nm as number) ?? 160,
        material: material(layer.material, dielectric),
      };
    return {
      name: (layer.name as string) ?? "Patterned layer",
      geometry: "rectangle_1d" as const,
      thickness_nm: (layer.thickness_nm as number) ?? 160,
      cd_nm: (layer.cd_nm as number) ?? 180,
      material: material(layer.material, dielectric),
      background: material(layer.background, { name: "Air", n: 1 }),
    };
  });
  const hx = Math.min(5, Math.max(1, harmonics));
  if (hx !== harmonics) notes.push(`Fourier orders reduced from ${harmonics} to ${hx} (2D limit).`);
  return {
    notes,
    design: {
      schema_version: "1.2",
      name: (p.name as string) ?? "One-layer grating",
      period_nm: period,
      // y-invariant layers do not depend on the y period; one order in y suffices.
      period_y_nm: period,
      ambient: material(p.ambient, { name: "Air", n: 1 }),
      substrate: material(p.substrate, { name: "Synthetic substrate", n: 1.5 }),
      layers,
      illumination: {
        wavelengths_nm: (illumination.wavelengths_nm as number[]) ?? Array.from({ length: 21 }, (_, i) => 450 + 20 * i),
        angle_deg: (illumination.angle_deg as number) ?? 15,
        azimuth_deg: 0,
        polarization: (illumination.polarization as "s" | "p" | "both") ?? "both",
      },
      solver: { harmonics_x: hx, harmonics_y: 1 },
    },
  };
}
