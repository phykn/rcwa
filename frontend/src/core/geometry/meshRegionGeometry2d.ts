import { BufferGeometry, Float32BufferAttribute } from "three";
import type { PhysicalMeshRegion } from "./structureGeometry2d";

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
