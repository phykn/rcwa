import type { Material, Project } from "./model";

export type StructureDimension = "width" | "height" | "pitch";
export type StructureMaterial = "ridge" | "substrate" | "ambient" | "groove";
export type StructureSheet = StructureDimension | StructureMaterial;
export interface StructureLayerValues {
  geometry: "rectangle_1d" | "homogeneous";
  width: number;
  height: number;
}
export interface StructureValues {
  width: number;
  height: number;
  pitch: number;
  angle: number;
  layers?: StructureLayerValues[];
  selectedLayer?: number;
}

export const structureDimensions: StructureDimension[] = [
  "width",
  "height",
  "pitch",
];

/** A stale selection (for example after deleting the last layer) stays in range. */
export function structureLayerIndex(count: number, selectedLayer = 0): number {
  return Math.max(
    0,
    Math.min(
      count - 1,
      Number.isFinite(selectedLayer) ? Math.trunc(selectedLayer) : 0,
    ),
  );
}

export function structureValues(
  project: Project,
  selectedLayer = 0,
): StructureValues {
  const index = structureLayerIndex(project.layers.length, selectedLayer);
  const layers = project.layers.map((layer) => ({
    geometry: layer.geometry,
    width: layer.geometry === "rectangle_1d" ? layer.cd_nm : project.period_nm,
    height: layer.thickness_nm,
  }));
  const selected = layers[index];
  return {
    width: selected?.width ?? 0,
    height: selected?.height ?? 0,
    pitch: project.period_nm,
    angle: project.illumination.angle_deg,
    layers,
    selectedLayer: index,
  };
}

export function visibleStructureDimensions(
  values: StructureValues,
): StructureDimension[] {
  const selected = structureLayerIndex(
    values.layers?.length ?? 1,
    values.selectedLayer,
  );
  return values.layers?.[selected]?.geometry === "homogeneous"
    ? ["height", "pitch"]
    : structureDimensions;
}

export function dimensionRange(
  dimension: StructureDimension,
  values: StructureValues,
): readonly [number, number] {
  if (dimension === "width") return [0, values.pitch];
  if (dimension === "height") return [0, 2000];
  const selected = structureLayerIndex(
    values.layers?.length ?? 1,
    values.selectedLayer,
  );
  const widths = values.layers
    ? values.layers.map((layer, index) =>
        layer.geometry === "rectangle_1d"
          ? index === selected
            ? values.width
            : layer.width
          : 0,
      )
    : [values.width];
  return [Math.max(20, ...widths), 5000];
}

/** One common physical x/z scale preserves CD / thickness / period proportions.
 * Physical z is rendered along Three.js y; invariant groove length and substrate
 * depth are schematic. Layers are supplied top-to-bottom, with substrate at y=0.
 * fixedScale freezes only the common scale during a dimension drag.
 */
export function structureGeometry(
  values: StructureValues,
  fixedScale?: number,
) {
  const selectedIndex = structureLayerIndex(
    values.layers?.length ?? 1,
    values.selectedLayer,
  );
  const inputs = values.layers?.map((layer, index) =>
    index === selectedIndex
      ? { ...layer, width: values.width, height: values.height }
      : layer,
  ) ?? [
    {
      geometry: "rectangle_1d" as const,
      width: values.width,
      height: values.height,
    },
  ];
  // Sum from the substrate upwards. Reusing these exact interfaces avoids
  // cancellation drift (and a tiny negative bottom) for decimal thicknesses.
  const interfaces = new Array<number>(inputs.length + 1).fill(0);
  for (let index = inputs.length - 1; index >= 0; index--)
    interfaces[index] = interfaces[index + 1] + inputs[index].height;
  const totalHeightNm = interfaces[0];
  const scale =
    fixedScale ?? 5.1 / Math.max(values.pitch * 3, totalHeightNm, 1);
  const pitch = values.pitch * scale;
  const span = pitch * 3;
  const layers = inputs.map((layer, index) => {
    const top = interfaces[index] * scale;
    const bottom = interfaces[index + 1] * scale;
    const height = layer.height * scale;
    const width = layer.width * scale;
    const ridgeMode =
      layer.height === 0
        ? ("none" as const)
        : layer.geometry === "homogeneous" || layer.width === values.pitch
          ? ("continuous" as const)
          : layer.width === 0
            ? ("none" as const)
            : ("patterned" as const);
    const regions: { kind: "ridge" | "groove"; width: number; x: number }[] =
      [];
    if (height > 0) {
      if (ridgeMode === "continuous") {
        regions.push({ kind: "ridge", width: span, x: 0 });
      } else if (ridgeMode === "none") {
        regions.push({ kind: "groove", width: span, x: 0 });
      } else {
        // Merge adjacent half-grooves across cell interfaces: each volume is
        // represented once, without holes, overlaps or fake inter-cell seams.
        let cursor = -span / 2;
        for (const repeat of [-1, 0, 1]) {
          const left = repeat * pitch - width / 2;
          if (left > cursor)
            regions.push({
              kind: "groove",
              width: left - cursor,
              x: (left + cursor) / 2,
            });
          regions.push({ kind: "ridge", width, x: repeat * pitch });
          cursor = repeat * pitch + width / 2;
        }
        if (cursor < span / 2)
          regions.push({
            kind: "groove",
            width: span / 2 - cursor,
            x: (span / 2 + cursor) / 2,
          });
      }
    }
    return {
      index,
      geometry: layer.geometry,
      width,
      height,
      top,
      bottom,
      center: (top + bottom) / 2,
      ridgeMode,
      regions,
    };
  });
  const selectedLayer = structureLayerIndex(
    layers.length,
    values.selectedLayer,
  );
  const selected = layers[selectedLayer];
  return {
    scale,
    width: selected?.width ?? 0,
    height: selected?.height ?? 0,
    top: selected?.top ?? 0,
    bottom: selected?.bottom ?? 0,
    pitch,
    span,
    totalHeight: totalHeightNm * scale,
    depth: 3.3,
    substrateDepth: 0.25,
    ridgeMode: selected?.ridgeMode ?? ("none" as const),
    selectedLayer,
    layers,
  };
}

/** Selected-layer handles use distinct physical surfaces. The patterned
 * thickness handle stays on the top/rear surface so its 44 px target cannot
 * cover the width handle on the front face at the default mobile view.
 */
export function structureHandlePosition(
  dimension: StructureDimension,
  geometry: ReturnType<typeof structureGeometry>,
): [number, number, number] {
  if (dimension === "height")
    return geometry.layers[geometry.selectedLayer]?.geometry === "homogeneous"
      ? [geometry.span / 2 + 0.35, geometry.top, geometry.depth / 2 + 0.03]
      : [0, geometry.top, -0.35];
  if (dimension === "width")
    return [
      geometry.width / 2,
      geometry.bottom + geometry.height * 0.52,
      geometry.depth / 2,
    ];
  return [geometry.pitch, 0, geometry.depth / 2 + 0.47];
}

/** Color encodes optical material, never repeat position or selection. Air is
 * shown as a faint volume; every non-air material is opaque in this schematic.
 */
export function structureMaterialAppearance(material: Material) {
  const air =
    material.kind === "constant" && material.n === 1 && material.k === 0;
  if (air) return { color: "#dbeafe", opacity: 0.16 };
  if (material.kind === "constant" && material.n === 2.1 && material.k === 0)
    return { color: "#6366f1", opacity: 1 };
  if (material.kind === "constant" && material.n === 1.5 && material.k === 0)
    return { color: "#b8c1d1", opacity: 1 };
  const identity = JSON.stringify(
    material.kind === "constant"
      ? [material.kind, material.n, material.k]
      : [
          material.kind,
          material.wavelengths_nm,
          material.n_values,
          material.k_values,
        ],
  );
  let hash = 0;
  for (const character of identity)
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  const palette = [
    "#818cf8",
    "#14b8a6",
    "#e9a24b",
    "#a78bfa",
    "#e8799b",
    "#60a5fa",
    "#91ad64",
  ];
  return { color: palette[(hash >>> 0) % palette.length], opacity: 1 };
}

export function materialColor(material: Material): string {
  return structureMaterialAppearance(material).color;
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
