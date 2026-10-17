import library from "./library.json";
import type { Material } from "../model";

export interface LibraryMaterial {
  id: string;
  name: string;
  family: "dielectric" | "semiconductor" | "metal";
  range_nm: [number, number];
  source: string;
  material: Material;
}

export const LIBRARY = library as LibraryMaterial[];

/** Linear n/k interpolation, matching rcwa_core; null outside a table. */
export function indexAt(material: Material, wavelength: number): { n: number; k: number } | null {
  if (material.kind === "constant") return { n: material.n, k: material.k };
  const ws = material.wavelengths_nm ?? [];
  const ns = material.n_values ?? [];
  const ks = material.k_values ?? [];
  if (!ws.length || wavelength < ws[0] || wavelength > ws[ws.length - 1]) return null;
  let i = 1;
  while (i < ws.length - 1 && ws[i] < wavelength) i++;
  const t = (wavelength - ws[i - 1]) / (ws[i] - ws[i - 1] || 1);
  return { n: ns[i - 1] + t * (ns[i] - ns[i - 1]), k: ks[i - 1] + t * (ks[i] - ks[i - 1]) };
}

export function coverage(material: Material): [number, number] | null {
  if (material.kind === "constant") return null;
  const ws = material.wavelengths_nm ?? [];
  return [ws[0], ws[ws.length - 1]];
}

export function describeMaterial(material: Material, wavelength: number) {
  const value = indexAt(material, wavelength);
  if (!value) return "outside its data";
  const n = value.n.toFixed(value.n < 10 ? 3 : 2);
  return value.k > 0 ? `n ${n}, k ${value.k.toFixed(3)}` : `n ${n}`;
}

/** Parse "wavelength n k" rows; wavelengths in nm, or µm when all are below 30. */
export function parseMaterialCsv(name: string, text: string): Material {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[#a-z]/i.test(line))
    .map((line) => line.split(/[\s,;\t]+/).map(Number));
  if (rows.length < 2) throw new Error("Need at least two rows of wavelength, n and k.");
  if (rows.some((r) => r.length < 2 || r.some((v) => !Number.isFinite(v))))
    throw new Error("Each row needs numeric wavelength and n, with an optional k.");
  const scale = rows.every((r) => r[0] < 30) ? 1000 : 1;
  const sorted = rows.map((r) => [r[0] * scale, r[1], r[2] ?? 0]).sort((a, b) => a[0] - b[0]);
  if (sorted.some((r, i) => i && r[0] <= sorted[i - 1][0])) throw new Error("Wavelengths must not repeat.");
  if (sorted.some((r) => !(r[1] > 0 && r[1] <= 10 && r[2] >= 0 && r[2] <= 10)))
    throw new Error("Use 0 < n ≤ 10 and 0 ≤ k ≤ 10.");
  if (sorted.length > 2000) throw new Error("Use at most 2000 rows.");
  const mid = sorted[Math.floor(sorted.length / 2)];
  return {
    name: name.slice(0, 100) || "Imported material",
    kind: "tabulated",
    n: mid[1],
    k: mid[2],
    wavelengths_nm: sorted.map((r) => r[0]),
    n_values: sorted.map((r) => r[1]),
    k_values: sorted.map((r) => r[2]),
    source: "Imported table",
  };
}
