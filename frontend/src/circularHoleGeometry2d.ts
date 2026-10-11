import { BufferGeometry, Float32BufferAttribute } from "three";
import type {
  PhysicalMeshRegion,
  StructureMaterial2D,
} from "./structureGeometry2d";

interface Point2D {
  readonly x: number;
  readonly y: number;
}

interface CircularHoleMeshOptions {
  readonly periodX: number;
  readonly periodY: number;
  readonly diameter: number;
  readonly bottom: number;
  readonly top: number;
  readonly layerIndex: number;
  readonly material: StructureMaterial2D;
  readonly background: StructureMaterial2D;
  readonly cutaway: boolean;
}

/** One shared tessellation is used on both sides of every circular interface. */
const QUADRANT_SEGMENTS = 64;

class PlanarPartition {
  private readonly points: Point2D[] = [];
  private readonly pointIndices = new Map<string, number>();
  private readonly triangles: number[] = [];
  private readonly edges = new Map<string, [number, number]>();
  area = 0;

  private index(point: Point2D): number {
    // Cardinal/corner samples are constructed exactly. Neighboring cells use
    // identical edge samples, so their internal walls cancel without welding
    // tolerances that could erase a small but valid diameter.
    const key = `${point.x},${point.y}`;
    const existing = this.pointIndices.get(key);
    if (existing !== undefined) return existing;
    const index = this.points.length;
    this.points.push(point);
    this.pointIndices.set(key, index);
    return index;
  }

  addPolygon(points: readonly Point2D[]) {
    const vertices: number[] = [];
    for (const point of points) {
      const index = this.index(point);
      if (vertices.at(-1) !== index) vertices.push(index);
    }
    if (vertices[0] === vertices.at(-1)) vertices.pop();
    if (vertices.length < 3) return;
    let area = 0;
    const a = this.points[vertices[0]];
    for (let i = 1; i + 1 < vertices.length; i++) {
      const b = this.points[vertices[i]];
      const c = this.points[vertices[i + 1]];
      // Difference coordinates retain precision for small circles far from 0.
      const doubleArea = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (doubleArea <= 0) continue;
      this.triangles.push(vertices[0], vertices[i], vertices[i + 1]);
      area += doubleArea / 2;
    }
    if (area === 0) return;
    this.area += area;
    for (let i = 0; i < vertices.length; i++) {
      const start = vertices[i];
      const end = vertices[(i + 1) % vertices.length];
      const key = start < end ? `${start}:${end}` : `${end}:${start}`;
      if (this.edges.has(key)) this.edges.delete(key);
      else this.edges.set(key, [start, end]);
    }
  }

  extrude(bottom: number, top: number) {
    const positions: number[] = [];
    const indices: number[] = [];
    const count = this.points.length;
    for (const z of [bottom, top])
      for (const { x, y } of this.points) positions.push(x, y, z);
    for (let i = 0; i < this.triangles.length; i += 3) {
      const [a, b, c] = this.triangles.slice(i, i + 3);
      indices.push(a, c, b, a + count, b + count, c + count);
    }
    // Only the union's boundary is extruded. Internal fan edges and repeat-cell
    // boundaries have cancelled, leaving no false radial or cell walls.
    for (const [a, b] of this.edges.values())
      indices.push(a, b, b + count, a, b + count, a + count);
    const used = new Set(indices);
    const bounds = {
      min: { x: Infinity, y: Infinity, z: bottom },
      max: { x: -Infinity, y: -Infinity, z: top },
    };
    for (const index of used) {
      const x = positions[index * 3];
      const y = positions[index * 3 + 1];
      bounds.min.x = Math.min(bounds.min.x, x);
      bounds.max.x = Math.max(bounds.max.x, x);
      bounds.min.y = Math.min(bounds.min.y, y);
      bounds.max.y = Math.max(bounds.max.y, y);
    }
    return { positions, indices, bounds };
  }
}

/**
 * Tile each rectangle-minus-circle using convex radial quadrilaterals. The
 * rectangle's corner angle is an explicit sample, so no corner can disappear
 * when a circle touches one or both periods. Fan triangles use the same inner
 * edge for the hole fill. This is a rendering tessellation, not solver input.
 *
 * Every quadrant is wholly inside or outside the inspection cut, because the
 * cut planes run through the center row/column. Removing polygons before
 * extrusion produces closed real cut faces, rather than renderer clipping.
 */
export function buildCircularHoleMeshRegions2D(
  options: CircularHoleMeshOptions,
): PhysicalMeshRegion[] {
  const {
    periodX,
    periodY,
    diameter,
    bottom,
    top,
    layerIndex,
    material,
    background,
    cutaway,
  } = options;
  if (diameter === 0 || top === bottom) return [];
  const halfX = periodX / 2;
  const halfY = periodY / 2;
  const radius = diameter / 2;
  const corner = Math.atan2(halfY, halfX);
  const angles = Array.from(
    { length: QUADRANT_SEGMENTS + 1 },
    (_, i) => (i * Math.PI) / (2 * QUADRANT_SEGMENTS),
  );
  // Avoid duplicate/nearly identical samples when the corner is already on a
  // standard ray. Keep the exact corner value to snap both outer coordinates.
  const existingCorner = angles.findIndex(
    (angle) => Math.abs(angle - corner) < 1e-14,
  );
  if (existingCorner >= 0) angles[existingCorner] = corner;
  else angles.push(corner);
  angles.sort((a, b) => a - b);
  const samples = angles.map((angle) => {
    const cosine = angle === Math.PI / 2 ? 0 : Math.cos(angle);
    const sine = angle === 0 ? 0 : Math.sin(angle);
    return {
      inner: { x: radius * cosine, y: radius * sine },
      outer:
        angle === corner
          ? { x: halfX, y: halfY }
          : angle < corner
            ? { x: halfX, y: halfX * (sine / cosine) }
            : { x: halfY * (cosine / sine), y: halfY },
    };
  });
  const fill = new PlanarPartition();
  const host = new PlanarPartition();
  for (const cellX of [-1, 0, 1]) {
    for (const cellY of [-1, 0, 1]) {
      const center = { x: cellX * periodX, y: cellY * periodY };
      for (const [signX, signY] of [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ]) {
        const positiveX = cellX > 0 || (cellX === 0 && signX > 0);
        const positiveY = cellY > 0 || (cellY === 0 && signY > 0);
        if (cutaway && positiveX && positiveY) continue;
        const quadrant = signX * signY > 0 ? samples : [...samples].reverse();
        const translate = ({ x, y }: Point2D): Point2D => ({
          x: center.x + signX * x,
          y: center.y + signY * y,
        });
        for (let i = 0; i + 1 < quadrant.length; i++) {
          const a = translate(quadrant[i].inner);
          const b = translate(quadrant[i + 1].inner);
          fill.addPolygon([center, a, b]);
          host.addPolygon([
            a,
            translate(quadrant[i].outer),
            translate(quadrant[i + 1].outer),
            b,
          ]);
        }
      }
    }
  }
  const fraction = cutaway ? 0.75 : 1;
  const thickness = top - bottom;
  const holeArea = 9 * Math.PI * radius * radius;
  return (
    [
      ["background", host, background, 9 * periodX * periodY - holeArea],
      ["material", fill, material, holeArea],
    ] as const
  ).map(([role, partition, identity, analyticArea]) => ({
    geometry: "circular_hole_2d",
    layerIndex,
    role,
    material: identity,
    ...partition.extrude(bottom, top),
    diameterNm: diameter,
    radialSegments: (samples.length - 1) * 4,
    analyticVolumeNm3: analyticArea * fraction * thickness,
    meshVolumeNm3: partition.area * thickness,
  }));
}

/** Physical xyz -> scene x,z,-y; one scale, no cylinder-specific distortion. */
export function meshRegionGeometry2D(
  region: PhysicalMeshRegion,
  scale = 1,
  height = 0,
): BufferGeometry {
  const positions: number[] = [];
  for (let i = 0; i < region.positions.length; i += 3)
    positions.push(
      region.positions[i] * scale,
      (region.positions[i + 2] - height / 2) * scale,
      -region.positions[i + 1] * scale,
    );
  const indexed = new BufferGeometry();
  indexed.setAttribute("position", new Float32BufferAttribute(positions, 3));
  indexed.setIndex([...region.indices]);
  // Preserve planar top/cut faces instead of averaging their normals with the
  // cylindrical walls. The side tessellation is fine enough to look round.
  const result = indexed.toNonIndexed();
  indexed.dispose();
  result.computeVertexNormals();
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}
