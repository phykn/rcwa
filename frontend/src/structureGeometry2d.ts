/** Read-only geometry inputs. This module never normalizes or changes solver input. */
export interface StructureMaterial2D {
  readonly name: string;
  readonly kind: "constant" | "tabulated";
  readonly n: number;
  readonly k: number;
  readonly wavelengths_nm?: readonly number[] | null;
  readonly n_values?: readonly number[] | null;
  readonly k_values?: readonly number[] | null;
  readonly source?: string;
}

interface StructureLayerBase2D {
  readonly name: string;
  readonly thickness_nm: number;
  readonly material: StructureMaterial2D;
}

export type StructureGeometryLayer2D = StructureLayerBase2D &
  (
    | {
        readonly geometry: "rectangle_2d";
        readonly cd_x_nm: number;
        readonly cd_y_nm: number;
        readonly background: StructureMaterial2D;
      }
    | {
        readonly geometry: "rectangle_1d";
        readonly cd_nm: number;
        readonly background: StructureMaterial2D;
      }
    | { readonly geometry: "homogeneous" }
  );

export interface StructureGeometryProject2D {
  readonly period_nm: number;
  readonly period_y_nm: number;
  readonly layers: readonly StructureGeometryLayer2D[];
}

/** Physical coordinates in nm. z is height above the substrate, not depth. */
export interface PhysicalVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PhysicalBounds {
  readonly min: PhysicalVector;
  readonly max: PhysicalVector;
}

/** Positive-volume boxes only. Shared faces are boundaries, not overlap. */
export interface PhysicalRegion {
  readonly layerIndex: number;
  readonly role: "material" | "background";
  /** Original material reference, including low-index and tabulated materials. */
  readonly material: StructureMaterial2D;
  readonly center: PhysicalVector;
  readonly size: PhysicalVector;
  readonly bounds: PhysicalBounds;
}

export interface StructureLayerSlab2D {
  readonly layerIndex: number;
  readonly geometry: StructureGeometryLayer2D["geometry"];
  readonly top: number;
  readonly bottom: number;
  readonly thickness: number;
  /** Uncut bounds; zero-thickness interfaces remain represented here. */
  readonly bounds: PhysicalBounds;
}

export interface StructureGeometry2D {
  readonly regions: readonly PhysicalRegion[];
  /** Uncut 3-by-3 display bounds, never rescaled for the inspection view. */
  readonly bounds: PhysicalBounds;
  /** Top-to-bottom shared interfaces; the last entry is exactly zero. */
  readonly layerInterfaces: readonly number[];
  readonly layers: readonly StructureLayerSlab2D[];
  /** Removed front (+x,+y) quarter; null in the full-stack view. */
  readonly cutawayBounds: PhysicalBounds | null;
}

interface AxisInterval {
  min: number;
  max: number;
  material: boolean;
}

function dimension(value: number, min: number, max: number, name: string) {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`${name} must be between ${min} and ${max} nm.`);
}

/** Merge neighboring background half-cells instead of drawing false seams. */
function repeatedIntervals(period: number, width: number): AxisInterval[] {
  const min = -1.5 * period;
  const max = 1.5 * period;
  if (width === 0) return [{ min, max, material: false }];
  if (width === period) return [{ min, max, material: true }];

  const intervals: AxisInterval[] = [];
  let cursor = min;
  for (const repeat of [-1, 0, 1]) {
    const left = repeat * period - width / 2;
    const right = repeat * period + width / 2;
    intervals.push({ min: cursor, max: left, material: false });
    intervals.push({ min: left, max: right, material: true });
    cursor = right;
  }
  intervals.push({ min: cursor, max, material: false });
  return intervals;
}

function hasVolume(bounds: PhysicalBounds): boolean {
  return (
    bounds.max.x > bounds.min.x &&
    bounds.max.y > bounds.min.y &&
    bounds.max.z > bounds.min.z
  );
}

/** Actual solid subtraction. No invisible-but-pickable clipped mesh remains. */
function subtractBox(
  box: PhysicalBounds,
  removed: PhysicalBounds,
): PhysicalBounds[] {
  const min = {
    x: Math.max(box.min.x, removed.min.x),
    y: Math.max(box.min.y, removed.min.y),
    z: Math.max(box.min.z, removed.min.z),
  };
  const max = {
    x: Math.min(box.max.x, removed.max.x),
    y: Math.min(box.max.y, removed.max.y),
    z: Math.min(box.max.z, removed.max.z),
  };
  if (!hasVolume({ min, max })) return [box];

  // Peel x slabs, then y slabs within the remaining x interval, then z.
  // Every piece has a disjoint interior and shares the exact cut interfaces.
  return [
    { min: box.min, max: { ...box.max, x: min.x } },
    { min: { ...box.min, x: max.x }, max: box.max },
    {
      min: { ...box.min, x: min.x },
      max: { ...box.max, x: max.x, y: min.y },
    },
    {
      min: { ...box.min, x: min.x, y: max.y },
      max: { ...box.max, x: max.x },
    },
    {
      min: { x: min.x, y: min.y, z: box.min.z },
      max: { x: max.x, y: max.y, z: min.z },
    },
    {
      min: { x: min.x, y: min.y, z: max.z },
      max: { x: max.x, y: max.y, z: box.max.z },
    },
  ].filter(hasVolume);
}

function region(
  bounds: PhysicalBounds,
  layerIndex: number,
  role: PhysicalRegion["role"],
  material: StructureMaterial2D,
): PhysicalRegion {
  return {
    bounds,
    layerIndex,
    role,
    material,
    center: {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    },
    size: {
      x: bounds.max.x - bounds.min.x,
      y: bounds.max.y - bounds.min.y,
      z: bounds.max.z - bounds.min.z,
    },
  };
}

/**
 * Partition the complete finite 3-by-3 stack, in unscaled physical nm.
 * Layers are top-to-bottom; z=0 touches the substrate. A renderer maps physical
 * z to its vertical axis and applies ONE scale to all three axes. Substrate and
 * ambient are deliberately excluded because neither has a finite input depth.
 *
 * The optional inspection cut removes x>0 AND y>0 through every layer, including
 * a quarter of each center-cell inclusion. It changes only returned view boxes;
 * the input, uncut bounds, material identities and layer interfaces are intact.
 * This checks geometric limits only, not the full project/solver schema.
 */
export function buildStructureGeometry2D(
  project: StructureGeometryProject2D,
  options: { readonly cutaway?: boolean } = {},
): StructureGeometry2D {
  dimension(project.period_nm, 20, 5000, "Pitch X");
  dimension(project.period_y_nm, 20, 5000, "Pitch Y");
  if (project.layers.length < 1 || project.layers.length > 8)
    throw new RangeError("The stack must contain 1–8 layers.");

  for (const [index, layer] of project.layers.entries()) {
    dimension(layer.thickness_nm, 0, 2000, `Layer ${index + 1} thickness`);
    switch (layer.geometry) {
      case "rectangle_2d":
        dimension(layer.cd_x_nm, 0, project.period_nm, `Layer ${index + 1} X`);
        dimension(
          layer.cd_y_nm,
          0,
          project.period_y_nm,
          `Layer ${index + 1} Y`,
        );
        break;
      case "rectangle_1d":
        dimension(layer.cd_nm, 0, project.period_nm, `Layer ${index + 1} X`);
        break;
      case "homogeneous":
        break;
      default:
        throw new RangeError(`Layer ${index + 1} has an unsupported geometry.`);
    }
  }

  // Accumulate upward so the final layer cannot drift below the substrate.
  const layerInterfaces = new Array<number>(project.layers.length + 1).fill(0);
  for (let index = project.layers.length - 1; index >= 0; index--)
    layerInterfaces[index] =
      layerInterfaces[index + 1] + project.layers[index].thickness_nm;

  const bounds: PhysicalBounds = {
    min: { x: -1.5 * project.period_nm, y: -1.5 * project.period_y_nm, z: 0 },
    max: {
      x: 1.5 * project.period_nm,
      y: 1.5 * project.period_y_nm,
      z: layerInterfaces[0],
    },
  };
  const cutawayBounds: PhysicalBounds | null = options.cutaway
    ? { min: { x: 0, y: 0, z: 0 }, max: { ...bounds.max } }
    : null;
  const layers: StructureLayerSlab2D[] = [];
  const regions: PhysicalRegion[] = [];

  const addRegion = (
    box: PhysicalBounds,
    layerIndex: number,
    role: PhysicalRegion["role"],
    material: StructureMaterial2D,
  ) => {
    if (!hasVolume(box)) return;
    const pieces = cutawayBounds ? subtractBox(box, cutawayBounds) : [box];
    for (const piece of pieces)
      regions.push(region(piece, layerIndex, role, material));
  };

  for (const [layerIndex, layer] of project.layers.entries()) {
    const bottom = layerInterfaces[layerIndex + 1];
    const top = layerInterfaces[layerIndex];
    const slabBounds: PhysicalBounds = {
      min: { ...bounds.min, z: bottom },
      max: { ...bounds.max, z: top },
    };
    layers.push({
      layerIndex,
      geometry: layer.geometry,
      top,
      bottom,
      thickness: layer.thickness_nm,
      bounds: slabBounds,
    });
    if (layer.thickness_nm === 0) continue;
    if (layer.geometry === "homogeneous") {
      addRegion(slabBounds, layerIndex, "material", layer.material);
      continue;
    }

    const widthX =
      layer.geometry === "rectangle_2d" ? layer.cd_x_nm : layer.cd_nm;
    const widthY =
      layer.geometry === "rectangle_2d" ? layer.cd_y_nm : project.period_y_nm;
    if (widthX === 0 || widthY === 0) {
      addRegion(slabBounds, layerIndex, "background", layer.background);
      continue;
    }
    const xIntervals = repeatedIntervals(project.period_nm, widthX);
    const yIntervals = repeatedIntervals(project.period_y_nm, widthY);
    for (const y of yIntervals) {
      // A gap along y is all background, so no artificial x seams are needed.
      const row = y.material
        ? xIntervals
        : [{ min: bounds.min.x, max: bounds.max.x, material: false }];
      for (const x of row) {
        const role = x.material && y.material ? "material" : "background";
        addRegion(
          {
            min: { x: x.min, y: y.min, z: bottom },
            max: { x: x.max, y: y.max, z: top },
          },
          layerIndex,
          role,
          role === "material" ? layer.material : layer.background,
        );
      }
    }
  }
  return { regions, bounds, layerInterfaces, layers, cutawayBounds };
}

/** One shared physical-to-view scale for all axes; never exaggerate a thin layer. */
export function structureScale2D(project: StructureGeometryProject2D): number {
  const thickness = project.layers.reduce(
    (sum, layer) => sum + layer.thickness_nm,
    0,
  );
  return (
    4.8 / Math.max(3 * project.period_nm, 3 * project.period_y_nm, thickness, 1)
  );
}

/** Incident propagation vector: physical +z is up, so propagation goes down. */
export function illuminationDirection2D(
  angleDeg: number,
  azimuthDeg: number,
): PhysicalVector {
  const theta = (angleDeg * Math.PI) / 180;
  const phi = (azimuthDeg * Math.PI) / 180;
  return {
    x: Math.sin(theta) * Math.cos(phi),
    y: Math.sin(theta) * Math.sin(phi),
    z: -Math.cos(theta),
  };
}

/** Right-handed view mapping, using exactly the same scale in all directions. */
export function physicalToScene2D(
  point: PhysicalVector,
  scale = 1,
  height = 0,
): PhysicalVector {
  return {
    x: point.x * scale,
    y: (point.z - height / 2) * scale,
    z: -point.y * scale,
  };
}
