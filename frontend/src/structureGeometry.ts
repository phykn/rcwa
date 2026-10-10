import type { Material, Project } from "./model";

export type StructureDimension = "width" | "height" | "pitch";
export type StructureMaterial = "ridge" | "substrate" | "ambient" | "groove";
export type StructureSheet = StructureDimension | StructureMaterial;
export interface StructureValues {
  width: number;
  height: number;
  pitch: number;
  angle: number;
}

export const structureDimensions: StructureDimension[] = [
  "width",
  "height",
  "pitch",
];

export function structureValues(project: Project): StructureValues {
  return {
    width: project.layers[0].cd_nm,
    height: project.layers[0].thickness_nm,
    pitch: project.period_nm,
    angle: project.illumination.angle_deg,
  };
}

export function dimensionRange(
  dimension: StructureDimension,
  values: StructureValues,
): readonly [number, number] {
  if (dimension === "width") return [0, values.pitch];
  if (dimension === "height") return [0, 2000];
  return [Math.max(20, values.width), 5000];
}

/** One common scale preserves the actual CD / thickness / period proportions.
 * The length along invariant grooves and substrate depth are schematic only.
 */
export function structureGeometry(values: StructureValues) {
  const scale = 5.1 / Math.max(values.pitch * 3, values.height);
  return {
    scale,
    width: values.width * scale,
    height: values.height * scale,
    pitch: values.pitch * scale,
    span: values.pitch * 3 * scale,
    depth: 3.3,
    substrateDepth: 0.25,
    ridgeMode:
      values.width === 0 || values.height === 0
        ? ("none" as const)
        : values.width === values.pitch
          ? ("continuous" as const)
          : ("patterned" as const),
  };
}

export function materialSummary(material: Material): string {
  if (material.kind === "tabulated") return "Tabulated n/k";
  return `n ${material.n} · k ${material.k}`;
}

/** A pick is a single stationary pointer, never an orbit or multi-touch gesture. */
export class StructurePickGesture {
  private pointers = new Map<number, { x: number; y: number }>();
  private blocked = false;

  down(id: number, x: number, y: number, primaryButton: boolean) {
    if (this.pointers.size === 0) this.blocked = !primaryButton;
    this.pointers.set(id, { x, y });
    if (this.pointers.size > 1) this.blocked = true;
  }

  move(id: number, x: number, y: number) {
    const start = this.pointers.get(id);
    if (start && Math.hypot(x - start.x, y - start.y) > 3) this.blocked = true;
  }

  suppress() {
    this.blocked = true;
  }

  cameraChanged() {
    if (this.pointers.size) this.blocked = true;
  }

  up(id: number, x: number, y: number): boolean {
    this.move(id, x, y);
    const canPick =
      this.pointers.has(id) && this.pointers.size === 1 && !this.blocked;
    this.pointers.delete(id);
    return canPick;
  }

  cancel(id: number) {
    this.blocked = true;
    this.pointers.delete(id);
  }
}
