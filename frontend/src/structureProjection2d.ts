import {
  buildStructureGeometry2D,
  type StructureGeometryProject2D,
  type StructureMaterial2D,
} from "./structureGeometry2d";

export interface ProjectionBounds2D {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

interface ProjectionRegionBase2D {
  readonly layerIndex: number;
  readonly role: "material" | "background";
  readonly material: StructureMaterial2D;
}

export type ProjectionRegion2D = ProjectionRegionBase2D &
  (
    | { readonly shape: "rectangle"; readonly bounds: ProjectionBounds2D }
    | { readonly shape: "circle"; readonly radius: number }
    | {
        readonly shape: "circle-host";
        readonly bounds: ProjectionBounds2D;
        readonly radius: number;
      }
  );

/** Only a constant n=1, k=0 region is empty, independent of its name. */
export function isAir2D(material: StructureMaterial2D): boolean {
  return material.kind === "constant" && material.n === 1 && material.k === 0;
}

/**
 * Exact orthographic sections of the canonical uncut geometry, in physical nm.
 * Both projections show the center repeat cell. XY is the selected finite
 * layer, not a view through the stack; XZ is the section at physical Y=0.
 * Circular interfaces stay analytic circles, rather than projecting mesh
 * polygons. Zero-thickness slabs have interfaces but no fabricated area.
 */
export function buildStructureProjections2D(
  project: StructureGeometryProject2D,
  selected: number,
) {
  const geometry = buildStructureGeometry2D(project);
  if (!Number.isInteger(selected) || !geometry.layers[selected])
    throw new RangeError("Select an existing finite layer.");
  const halfX = project.period_nm / 2;
  const halfY = project.period_y_nm / 2;
  const topBounds: ProjectionBounds2D = {
    minX: -halfX,
    maxX: halfX,
    minY: -halfY,
    maxY: halfY,
  };
  const totalThickness = geometry.bounds.max.z;
  const sectionBounds: ProjectionBounds2D = {
    minX: -halfX,
    maxX: halfX,
    minY: 0,
    maxY: totalThickness,
  };
  const top: ProjectionRegion2D[] = [];
  const section: ProjectionRegion2D[] = [];
  for (const region of geometry.regions) {
    const minX = Math.max(-halfX, region.bounds.min.x);
    const maxX = Math.min(halfX, region.bounds.max.x);
    if (minX >= maxX) continue;
    const identity = {
      layerIndex: region.layerIndex,
      role: region.role,
      material: region.material,
    };
    const minY = Math.max(-halfY, region.bounds.min.y);
    const maxY = Math.min(halfY, region.bounds.max.y);
    if (region.layerIndex === selected && minY < maxY)
      top.push({
        ...identity,
        shape: "rectangle",
        bounds: { minX, maxX, minY, maxY },
      });
    // Strict containment avoids treating a zero-area tangent as a solid strip.
    if (region.bounds.min.y < 0 && region.bounds.max.y > 0)
      section.push({
        ...identity,
        shape: "rectangle",
        bounds: {
          minX,
          maxX,
          minY: region.bounds.min.z,
          maxY: region.bounds.max.z,
        },
      });
  }
  for (const region of geometry.meshRegions) {
    const radius = region.diameterNm / 2;
    const identity = {
      layerIndex: region.layerIndex,
      role: region.role,
      material: region.material,
    };
    if (region.layerIndex === selected)
      top.push(
        region.role === "material"
          ? { ...identity, shape: "circle", radius }
          : { ...identity, shape: "circle-host", radius, bounds: topBounds },
      );
    const intervals =
      region.role === "material"
        ? [[-radius, radius]]
        : [
            [-halfX, -radius],
            [radius, halfX],
          ];
    for (const [minX, maxX] of intervals)
      if (minX < maxX)
        section.push({
          ...identity,
          shape: "rectangle",
          bounds: {
            minX,
            maxX,
            minY: region.bounds.min.z,
            maxY: region.bounds.max.z,
          },
        });
  }
  return {
    top,
    section,
    topBounds,
    sectionBounds,
    totalThickness,
    layers: geometry.layers,
  };
}

/** Fit once per projection, with the SAME scale for its two physical axes. */
export function fitProjection2D(
  bounds: ProjectionBounds2D,
  width: number,
  height: number,
) {
  const physicalWidth = bounds.maxX - bounds.minX;
  const physicalHeight = bounds.maxY - bounds.minY;
  const availableWidth = Math.max(1, width - 20);
  const availableHeight = Math.max(1, height - 48);
  const scale = Math.min(
    availableWidth / physicalWidth,
    physicalHeight > 0 ? availableHeight / physicalHeight : Infinity,
  );
  return {
    scale,
    originX: width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
    originY: height / 2 + ((bounds.minY + bounds.maxY) / 2) * scale,
  };
}
