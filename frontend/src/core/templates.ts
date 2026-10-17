import { AIR, constantMaterial, wavelengthRange } from "./design";
import { LIBRARY } from "./materials";
import type { Layer2D } from "./project2d";
import type { Design } from "../engine/types";
import circular from "./fixtures/default-project-circular.json";

const lib = (id: string) => {
  const item = LIBRARY.find((m) => m.id === id);
  if (!item) throw new Error(`Missing library material ${id}`);
  return item.material;
};

function design(
  name: string,
  pitch: [number, number],
  layers: Layer2D[],
  light: { from: number; to: number; points: number; angle?: number; polarization?: "s" | "p" | "both" },
  orders: [number, number],
  substrate = lib("SiO2"),
): Design {
  return {
    schema_version: "1.2",
    name,
    period_nm: pitch[0],
    period_y_nm: pitch[1],
    ambient: AIR,
    substrate,
    layers,
    illumination: {
      wavelengths_nm: wavelengthRange(light.from, light.to, light.points),
      angle_deg: light.angle ?? 0,
      azimuth_deg: 0,
      polarization: light.polarization ?? "both",
    },
    solver: { harmonics_x: orders[0], harmonics_y: orders[1] },
  };
}

export interface Template {
  id: string;
  title: string;
  summary: string;
  /** What to look for in the result. */
  look: string;
  design: Design;
}

const film = (name: string, material: Design["ambient"], thickness: number): Layer2D => ({
  name,
  geometry: "homogeneous",
  thickness_nm: thickness,
  material,
});

export const TEMPLATES: Template[] = [
  {
    id: "circular-holes",
    title: "Circular-hole stack",
    summary: "Three dielectric layers perforated by air holes on a rectangular lattice.",
    look: "Weak reflection; move the hole diameters and watch the dip shift.",
    design: circular as Design,
  },
  {
    id: "ar-coating",
    title: "Anti-reflection coating",
    summary: "Quarter-wave MgF₂ on glass at 550 nm.",
    look: "Reflection falls from about 4% to about 1.3% near 550 nm.",
    design: design("MgF₂ anti-reflection coating", [400, 400], [film("MgF₂ quarter-wave", lib("MgF2"), 100)], { from: 400, to: 800, points: 81 }, [1, 1]),
  },
  {
    id: "bragg-mirror",
    title: "Bragg mirror",
    summary: "Four TiO₂/SiO₂ quarter-wave pairs designed for 600 nm.",
    look: "A broad high-reflection band centred near 600 nm.",
    design: design(
      "TiO₂/SiO₂ Bragg mirror",
      [400, 400],
      Array.from({ length: 4 }, (_, i) => [film(`TiO₂ ${i + 1}`, lib("TiO2"), 58), film(`SiO₂ ${i + 1}`, lib("SiO2"), 103)]).flat(),
      { from: 450, to: 850, points: 101 },
      [1, 1],
    ),
  },
  {
    id: "wire-grid",
    title: "Wire-grid polarizer",
    summary: "Aluminium lines, 50 nm wide on a 150 nm pitch, on glass.",
    look: "Compare s and p: one is reflected, the other transmitted.",
    design: design(
      "Aluminium wire-grid polarizer",
      [150, 150],
      [{ name: "Al lines", geometry: "rectangle_1d", thickness_nm: 150, cd_nm: 50, material: lib("Al"), background: AIR }],
      { from: 450, to: 1000, points: 56 },
      [5, 1],
    ),
  },
  {
    id: "phc-slab",
    title: "Photonic-crystal slab",
    summary: "Si₃N₄ membrane with a square lattice of air holes on glass.",
    look: "Sharp guided-mode resonances appear as narrow peaks and dips.",
    design: design(
      "Si₃N₄ photonic-crystal slab",
      [400, 400],
      [{ name: "Si₃N₄ slab", geometry: "circular_hole_2d", thickness_nm: 200, diameter_nm: 240, material: AIR, background: lib("Si3N4") }],
      { from: 500, to: 900, points: 101 },
      [3, 3],
    ),
  },
  {
    id: "gold-disks",
    title: "Gold nanodisk array",
    summary: "50 nm tall gold disks, 120 nm across, 300 nm apart on glass.",
    look: "A plasmon resonance shows as a reflection peak and absorption band.",
    design: design(
      "Gold nanodisk array",
      [300, 300],
      [{ name: "Au disks", geometry: "circular_hole_2d", thickness_nm: 50, diameter_nm: 120, material: lib("Au"), background: AIR }],
      { from: 450, to: 1100, points: 66 },
      [3, 3],
    ),
  },
  {
    id: "si-metasurface",
    title: "Silicon nanopillars",
    summary: "Square silicon pillars on glass, a basic dielectric metasurface.",
    look: "Mie-type resonances give strong, colourful reflection.",
    design: design(
      "Silicon nanopillar metasurface",
      [300, 300],
      [{ name: "Si pillars", geometry: "rectangle_2d", thickness_nm: 150, cd_x_nm: 140, cd_y_nm: 140, material: lib("Si"), background: AIR }],
      { from: 450, to: 1000, points: 56 },
      [3, 3],
    ),
  },
  {
    id: "grating-1d",
    title: "Lamellar grating",
    summary: "A dielectric line grating at oblique incidence.",
    look: "Wood–Rayleigh anomalies appear where diffraction orders open.",
    design: design(
      "Dielectric line grating",
      [600, 600],
      [{ name: "Grating lines", geometry: "rectangle_1d", thickness_nm: 200, cd_nm: 300, material: constantMaterial("n=2.0", 2.0), background: AIR }],
      { from: 450, to: 900, points: 91, angle: 15 },
      [5, 1],
    ),
  },
];

export const DEFAULT_TEMPLATE = TEMPLATES[0];
