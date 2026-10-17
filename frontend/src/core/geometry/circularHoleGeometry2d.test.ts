import { describe, expect, it } from "vitest";
import { Raycaster, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { meshRegionGeometry2D } from "./meshRegionGeometry2d";
import {
  buildStructureGeometry2D,
  physicalToScene2D,
  type PhysicalMeshRegion,
  type StructureGeometryLayer2D,
  type StructureGeometryProject2D,
  type StructureMaterial2D,
} from "./structureGeometry2d";

const fill: StructureMaterial2D = {
  name: "Low-index hole fill",
  kind: "constant",
  n: 1.1,
  k: 0,
};
const host: StructureMaterial2D = {
  name: "Host",
  kind: "constant",
  n: 2.1,
  k: 0.1,
};
const circle = (
  diameter: number,
  thickness = 90,
): StructureGeometryLayer2D => ({
  name: "Circular holes",
  geometry: "circular_hole_2d",
  diameter_nm: diameter,
  thickness_nm: thickness,
  material: fill,
  background: host,
});
const project = (
  layers: readonly StructureGeometryLayer2D[],
  periodX = 150,
  periodY = 140,
): StructureGeometryProject2D => ({
  period_nm: periodX,
  period_y_nm: periodY,
  layers,
});

function point(region: PhysicalMeshRegion, index: number) {
  return new Vector3().fromArray(region.positions, index * 3);
}

/** Independent divergence-theorem volume over the renderer's actual faces. */
function signedMeshVolume(region: PhysicalMeshRegion): number {
  let volume = 0;
  for (let i = 0; i < region.indices.length; i += 3) {
    const a = point(region, region.indices[i]);
    const b = point(region, region.indices[i + 1]);
    const c = point(region, region.indices[i + 2]);
    volume += a.dot(b.cross(c)) / 6;
  }
  return volume;
}

function expectClosed(region: PhysicalMeshRegion) {
  const edges = new Map<string, number>();
  const direction = new Map<string, number>();
  for (let i = 0; i < region.indices.length; i += 3) {
    const vertices = region.indices.slice(i, i + 3);
    const a = point(region, vertices[0]);
    const b = point(region, vertices[1]);
    const c = point(region, vertices[2]);
    expect(b.sub(a).cross(c.sub(a)).length()).toBeGreaterThan(0);
    for (let j = 0; j < 3; j++) {
      const a = vertices[j];
      const b = vertices[(j + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
      direction.set(key, (direction.get(key) ?? 0) + (a < b ? 1 : -1));
    }
  }
  // At maximum diameter neighboring cylinders may touch at an edge; that edge
  // has four faces. Every boundary must still close with opposite winding.
  expect(
    [...edges.values()].every((count) => count >= 2 && count % 2 === 0),
  ).toBe(true);
  expect([...direction.values()].every((sum) => sum === 0)).toBe(true);
}

/** Probe the actual returned BufferGeometry, including cutouts and winding. */
function occupancy(region: PhysicalMeshRegion, x: number, y: number) {
  const geometry = meshRegionGeometry2D(region);
  const material = new MeshBasicMaterial();
  const mesh = new Mesh(geometry, material);
  mesh.updateMatrixWorld();
  const ray = new Raycaster(
    new Vector3(x, region.bounds.max.z + 1, -y),
    new Vector3(0, -1, 0),
  );
  const result = ray.intersectObject(mesh).length > 0;
  geometry.dispose();
  material.dispose();
  return result;
}

describe("physical circular-hole mesh geometry", () => {
  it("partitions the 3-by-3 slab into true filled cylinders and the host complement", () => {
    const scene = buildStructureGeometry2D(project([circle(70)]));
    expect(scene.regions).toEqual([]);
    expect(scene.meshRegions.map((r) => r.role)).toEqual([
      "background",
      "material",
    ]);
    const [matrix, holes] = scene.meshRegions;
    expect(matrix.material).toBe(host);
    expect(holes.material).toBe(fill);
    expect(holes.analyticVolumeNm3).toBe(9 * Math.PI * 35 ** 2 * 90);
    expect(matrix.analyticVolumeNm3 + holes.analyticVolumeNm3).toBe(
      9 * 150 * 140 * 90,
    );
    let actual = 0;
    for (const region of scene.meshRegions) {
      expectClosed(region);
      const volume = signedMeshVolume(region);
      expect(volume).toBeGreaterThan(0);
      expect(volume / region.meshVolumeNm3).toBeCloseTo(1, 10);
      expect(Math.abs(volume / region.analyticVolumeNm3 - 1)).toBeLessThan(
        0.00011,
      );
      expect(region.radialSegments).toBeGreaterThanOrEqual(256);
      actual += volume;
    }
    expect(actual / (9 * 150 * 140 * 90)).toBeCloseTo(1, 11);
    for (const x of [-150, 0, 150]) {
      for (const y of [-140, 0, 140]) {
        expect(occupancy(holes, x + 1, y + 1)).toBe(true);
        expect(occupancy(matrix, x + 1, y + 1)).toBe(false);
        // Inside a diameter-wide square but outside the actual circle.
        expect(occupancy(holes, x + 28, y + 28)).toBe(false);
        expect(occupancy(matrix, x + 28, y + 28)).toBe(true);
      }
    }
  });

  it("retains host corners at maximum diameter for square and unequal periods", () => {
    for (const [periodX, periodY] of [
      [140, 140],
      [150, 140],
      [20, 5000],
      [5000, 20],
    ]) {
      const diameter = Math.min(periodX, periodY);
      const scene = buildStructureGeometry2D(
        project([circle(diameter)], periodX, periodY),
      );
      const [matrix, holes] = scene.meshRegions;
      expect(matrix.analyticVolumeNm3).toBeGreaterThan(0);
      expect(signedMeshVolume(matrix)).toBeGreaterThan(0);
      expectClosed(matrix);
      expectClosed(holes);
      expect(occupancy(matrix, periodX * 0.49, periodY * 0.49)).toBe(true);
      expect(occupancy(holes, periodX * 0.49, periodY * 0.49)).toBe(false);
      expect(occupancy(holes, diameter * 0.2, diameter * 0.2)).toBe(true);
      expect(occupancy(matrix, diameter * 0.2, diameter * 0.2)).toBe(false);
      const expected = 9 * periodX * periodY * 90;
      expect(
        (signedMeshVolume(matrix) + signedMeshVolume(holes)) / expected,
      ).toBeCloseTo(1, 10);
    }
  });

  it("uses identical hole/host interfaces without internal radial or tile walls", () => {
    const [matrix, holes] = buildStructureGeometry2D(
      project([circle(70)]),
    ).meshRegions;
    const wallEdges = (region: PhysicalMeshRegion) => {
      const edges: [Vector3, Vector3][] = [];
      for (let i = 0; i < region.indices.length; i += 3) {
        const triangle = region.indices
          .slice(i, i + 3)
          .map((index) => point(region, index));
        const bottom = triangle.filter((p) => p.z === region.bounds.min.z);
        const top = triangle.filter((p) => p.z === region.bounds.max.z);
        if (bottom.length === 2 && top.length === 1)
          edges.push([bottom[0], bottom[1]]);
      }
      return edges;
    };
    const key = (edge: [Vector3, Vector3]) =>
      edge
        .map((p) => `${p.x},${p.y}`)
        .sort()
        .join(":");
    const cavityEdges: [Vector3, Vector3][] = [];
    for (const edge of wallEdges(matrix)) {
      if (
        edge.every((p) => p.x === -225 || p.x === 225) ||
        edge.every((p) => p.y === -210 || p.y === 210)
      )
        continue;
      // Any non-exterior host wall must lie on a true circular boundary, never
      // at an internal radial partition or the edge of a repeated unit cell.
      const middle = edge[0].clone().add(edge[1]).multiplyScalar(0.5);
      const centerX = Math.round(middle.x / 150) * 150;
      const centerY = Math.round(middle.y / 140) * 140;
      for (const p of edge)
        expect(Math.hypot(p.x - centerX, p.y - centerY)).toBeCloseTo(35, 10);
      cavityEdges.push(edge);
    }
    expect(cavityEdges.map(key).sort()).toEqual(
      wallEdges(holes).map(key).sort(),
    );
  });

  it("removes actual front-quarter geometry and closes the exposed circular and host faces", () => {
    for (const diameter of [70, 140]) {
      const p = project([circle(diameter)]);
      const full = buildStructureGeometry2D(p);
      const cut = buildStructureGeometry2D(p, { cutaway: true });
      expect(cut.bounds).toEqual(full.bounds);
      expect(cut.layers).toEqual(full.layers);
      expect(cut.layerInterfaces).toEqual(full.layerInterfaces);
      for (const [index, region] of cut.meshRegions.entries()) {
        expectClosed(region);
        expect(
          signedMeshVolume(region) / signedMeshVolume(full.meshRegions[index]),
        ).toBeCloseTo(0.75, 10);
        for (let i = 0; i < region.indices.length; i += 3) {
          const triangle = region.indices
            .slice(i, i + 3)
            .map((index) => point(region, index));
          expect(
            triangle.every((p) => p.x <= 0) || triangle.every((p) => p.y <= 0),
          ).toBe(true);
        }
        expect(occupancy(region, 1, 1)).toBe(false);
        expect(occupancy(region, 151, 141)).toBe(false);
      }
      expect(occupancy(cut.meshRegions[1], -1, 1)).toBe(true);
      expect(occupancy(cut.meshRegions[1], 1, -1)).toBe(true);
      // Both vertical cut faces lie on the real diameter through the center.
      const geometry = meshRegionGeometry2D(cut.meshRegions[1]);
      const material = new MeshBasicMaterial();
      const mesh = new Mesh(geometry, material);
      const xRay = new Raycaster(new Vector3(1, 45, -1), new Vector3(-1, 0, 0));
      const yRay = new Raycaster(new Vector3(1, 45, -1), new Vector3(0, 0, 1));
      expect(xRay.intersectObject(mesh)[0].point.x).toBe(0);
      expect(yRay.intersectObject(mesh)[0].point.z).toBe(0);
      geometry.dispose();
      material.dispose();
    }
  });

  it("supports zero diameter, zero thickness, small dimensions and exact shared interfaces", () => {
    const source = project([
      circle(0, 0.1),
      circle(70, 0.2),
      circle(70, 0),
      circle(1e-4, 0.3),
    ]);
    const before = JSON.stringify(source);
    for (const cutaway of [false, true]) {
      const scene = buildStructureGeometry2D(source, { cutaway });
      expect(
        scene.regions.every((r) => r.layerIndex === 0 && r.material === host),
      ).toBe(true);
      expect(scene.meshRegions.map((r) => r.layerIndex)).toEqual([1, 1, 3, 3]);
      for (const mesh of scene.meshRegions) {
        expect(mesh.bounds.min.z).toBe(
          scene.layerInterfaces[mesh.layerIndex + 1],
        );
        expect(mesh.bounds.max.z).toBe(scene.layerInterfaces[mesh.layerIndex]);
        expectClosed(mesh);
        expect(signedMeshVolume(mesh)).toBeGreaterThan(0);
      }
      expect(scene.layerInterfaces.at(-1)).toBe(0);
    }
    expect(JSON.stringify(source)).toBe(before);
    expect(
      buildStructureGeometry2D(project([circle(0, 0)])).meshRegions,
    ).toEqual([]);
  });

  it("keeps tabulated and low-index hole materials intact", () => {
    const optical = Object.freeze({
      ...fill,
      kind: "tabulated" as const,
      wavelengths_nm: [450, 850],
      n_values: [1.1, 1.2],
      k_values: [0, 0],
    });
    const layer = Object.freeze({ ...circle(70), material: optical });
    const scene = buildStructureGeometry2D(
      Object.freeze(project(Object.freeze([layer]))),
    );
    expect(scene.meshRegions[1].material).toBe(optical);
    expect(signedMeshVolume(scene.meshRegions[1])).toBeGreaterThan(0);
  });

  it("maps every triangle to the common physical scale and retains its handedness", () => {
    const [region] = buildStructureGeometry2D(
      project([circle(70)]),
    ).meshRegions;
    const geometry = meshRegionGeometry2D(region, 0.0123, 180);
    const attribute = geometry.getAttribute("position");
    for (let i = 0; i < region.indices.length; i++) {
      const expected = physicalToScene2D(
        point(region, region.indices[i]),
        0.0123,
        180,
      );
      expect(attribute.getX(i)).toBeCloseTo(expected.x, 6);
      expect(attribute.getY(i)).toBeCloseTo(expected.y, 6);
      expect(attribute.getZ(i)).toBeCloseTo(expected.z, 6);
    }
    geometry.dispose();
  });

  it("rejects invalid circular diameters without clamping", () => {
    for (const diameter of [-1, 140.001, Infinity, NaN]) {
      expect(() =>
        buildStructureGeometry2D(project([circle(diameter)])),
      ).toThrow(RangeError);
      expect(() =>
        buildStructureGeometry2D(project([circle(diameter)]), {
          cutaway: true,
        }),
      ).toThrow(RangeError);
    }
  });
});
