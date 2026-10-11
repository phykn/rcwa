import { describe, expect, it } from "vitest";
import exactDefault from "../../../backend/tests/fixtures/true-2d/default-project.json";
import {
  buildPrototypeGeometry,
  type PhysicalBounds,
  type PhysicalRegion,
  type PrototypeGeometry,
  type PrototypeGeometryLayer,
  type PrototypeGeometryProject,
  type PrototypeMaterial,
} from "./geometry";

const defaultProject = exactDefault as PrototypeGeometryProject;
const inclusion: PrototypeMaterial = {
  name: "Low-index inclusion, not empty space",
  kind: "constant",
  n: 1.1,
  k: 0,
};
const background: PrototypeMaterial = {
  name: "Filled high-index background",
  kind: "constant",
  n: 2.1,
  k: 0.1,
};
const rectangle = (
  x: number,
  y: number,
  thickness = 90,
): PrototypeGeometryLayer => ({
  name: "2D pattern",
  geometry: "rectangle_2d",
  cd_x_nm: x,
  cd_y_nm: y,
  thickness_nm: thickness,
  material: inclusion,
  background,
});
const ridge = (x: number, thickness = 20): PrototypeGeometryLayer => ({
  name: "Invariant-y pattern",
  geometry: "rectangle_1d",
  cd_nm: x,
  thickness_nm: thickness,
  material: inclusion,
  background,
});
const film = (thickness = 180): PrototypeGeometryLayer => ({
  name: "Uniform film",
  geometry: "homogeneous",
  thickness_nm: thickness,
  material: background,
});
const project = (
  layers: readonly PrototypeGeometryLayer[],
  x = 150,
  y = 140,
): PrototypeGeometryProject => ({ period_nm: x, period_y_nm: y, layers });
const volume = (box: PhysicalBounds) =>
  (box.max.x - box.min.x) * (box.max.y - box.min.y) * (box.max.z - box.min.z);
const totalVolume = (regions: readonly PhysicalRegion[]) =>
  regions.reduce((sum, region) => sum + volume(region.bounds), 0);
const overlapVolume = (a: PhysicalBounds, b: PhysicalBounds) =>
  Math.max(0, Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x)) *
  Math.max(0, Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y)) *
  Math.max(0, Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z));

/** Positive disjoint boxes inside a slab, with equal volume, exactly partition it. */
function expectPartition(scene: PrototypeGeometry) {
  const collisions: [number, number][] = [];
  for (const [index, region] of scene.regions.entries()) {
    const slab = scene.layers[region.layerIndex];
    expect(volume(region.bounds)).toBeGreaterThan(0);
    for (const axis of ["x", "y", "z"] as const) {
      expect(region.bounds.min[axis]).toBeGreaterThanOrEqual(
        slab.bounds.min[axis],
      );
      expect(region.bounds.max[axis]).toBeLessThanOrEqual(
        slab.bounds.max[axis],
      );
      expect(region.size[axis]).toBe(
        region.bounds.max[axis] - region.bounds.min[axis],
      );
      expect(region.center[axis]).toBe(
        (region.bounds.max[axis] + region.bounds.min[axis]) / 2,
      );
    }
    if (scene.cutawayBounds)
      expect(overlapVolume(region.bounds, scene.cutawayBounds)).toBe(0);
    for (let other = index + 1; other < scene.regions.length; other++) {
      if (overlapVolume(region.bounds, scene.regions[other].bounds) > 0)
        collisions.push([index, other]);
    }
  }
  expect(collisions).toEqual([]);
  for (const slab of scene.layers) {
    const actual = totalVolume(
      scene.regions.filter((region) => region.layerIndex === slab.layerIndex),
    );
    const removed = scene.cutawayBounds
      ? overlapVolume(slab.bounds, scene.cutawayBounds)
      : 0;
    const expected = volume(slab.bounds) - removed;
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
      Math.max(1, expected) * 1e-12,
    );
  }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const member of Object.values(value)) freezeDeep(member);
  }
  return value;
}

describe("prototype-only physical 2D geometry", () => {
  it("partitions the exact approved fixture with its unequal periods and interfaces", () => {
    const scene = buildPrototypeGeometry(defaultProject);
    expect(scene.bounds).toEqual({
      min: { x: -225, y: -210, z: 0 },
      max: { x: 225, y: 210, z: 400 },
    });
    expect(scene.layerInterfaces).toEqual([400, 310, 130, 0]);
    expect(scene.layers.map(({ bottom, top }) => [bottom, top])).toEqual([
      [310, 400],
      [130, 310],
      [0, 130],
    ]);
    expect(scene.cutawayBounds).toBeNull();
    expectPartition(scene);
    for (const [layerIndex, dimensions] of [
      [0, [70, 60, 90]],
      [2, [95, 80, 130]],
    ] as const) {
      const regions = scene.regions.filter(
        (region) =>
          region.layerIndex === layerIndex && region.role === "material",
      );
      expect(regions).toHaveLength(9);
      expect([...new Set(regions.map((region) => region.center.x))]).toEqual([
        -150, 0, 150,
      ]);
      expect([...new Set(regions.map((region) => region.center.y))]).toEqual([
        -140, 0, 140,
      ]);
      for (const region of regions)
        expect(region.size).toEqual({
          x: dimensions[0],
          y: dimensions[1],
          z: dimensions[2],
        });
      expect(totalVolume(regions)).toBe(
        9 * dimensions[0] * dimensions[1] * dimensions[2],
      );
    }
    expect(
      scene.regions.filter((region) => region.layerIndex === 1),
    ).toHaveLength(1);
  });

  it("preserves every material identity and treats low-index inclusions as matter", () => {
    const scene = buildPrototypeGeometry(defaultProject);
    for (const region of scene.regions) {
      const layer = defaultProject.layers[region.layerIndex];
      expect(region.material).toBe(
        region.role === "material"
          ? layer.material
          : layer.geometry !== "homogeneous" && layer.background,
      );
    }
    const lowIndex = scene.regions.filter(
      (region) => region.layerIndex === 2 && region.role === "material",
    );
    expect(lowIndex).toHaveLength(9);
    expect(lowIndex.every((region) => region.material.n === 1.45)).toBe(true);
    expect(
      scene.regions.some(
        (region) => region.layerIndex === 2 && region.material.n === 1.6,
      ),
    ).toBe(true);
  });

  it("does not interpret optical data or split invariant-y ridges into cells", () => {
    const tabulated = freezeDeep({
      ...inclusion,
      kind: "tabulated" as const,
      wavelengths_nm: [450, 850],
      n_values: [1.1, 1.2],
      k_values: [0.1, 0.2],
      source: "Synthetic test table",
    });
    const source = project([
      { ...rectangle(70, 60), material: tabulated },
      ridge(45),
      film(),
    ]);
    const scene = buildPrototypeGeometry(source);
    expectPartition(scene);
    expect(
      scene.regions
        .filter(
          (region) => region.layerIndex === 0 && region.role === "material",
        )
        .every((region) => region.material === tabulated),
    ).toBe(true);
    const ridges = scene.regions.filter(
      (region) => region.layerIndex === 1 && region.role === "material",
    );
    expect(ridges).toHaveLength(3);
    for (const region of ridges) {
      expect(region.size).toEqual({ x: 45, y: 420, z: 20 });
      expect(region.center.y).toBe(0);
    }
  });

  it("covers zero, partial and full widths and zero/full thickness without degenerate boxes", () => {
    for (const widthX of [0, 70, 150]) {
      for (const widthY of [0, 60, 140]) {
        for (const thickness of [0, 90, 2000]) {
          const source = project([rectangle(widthX, widthY, thickness)]);
          for (const cutaway of [false, true]) {
            const scene = buildPrototypeGeometry(source, { cutaway });
            expectPartition(scene);
            const material = scene.regions.filter((r) => r.role === "material");
            expect(totalVolume(material)).toBe(
              widthX * widthY * thickness * 9 * (cutaway ? 0.75 : 1),
            );
            if (thickness === 0) expect(scene.regions).toEqual([]);
            if (widthX === 0 || widthY === 0) expect(material).toEqual([]);
            if (widthX === 150 && widthY === 140)
              expect(scene.regions.every((r) => r.role === "material")).toBe(
                true,
              );
          }
        }
      }
    }
    for (const width of [0, 70, 150]) {
      for (const thickness of [0, 20, 2000]) {
        for (const cutaway of [false, true]) {
          const scene = buildPrototypeGeometry(
            project([ridge(width, thickness)]),
            {
              cutaway,
            },
          );
          expectPartition(scene);
          expect(
            totalVolume(scene.regions.filter((r) => r.role === "material")),
          ).toBe(width * 3 * 140 * 3 * thickness * (cutaway ? 0.75 : 1));
        }
      }
    }
  });

  it("supports every stack length with shared exact decimal and zero interfaces", () => {
    const candidates = [
      rectangle(71.25, 0.05, 0.1),
      film(0.2),
      ridge(42.5, 0),
      rectangle(0, 140, 0.3),
      film(0),
      rectangle(150, 140, 2000),
      ridge(150, 0.4),
      film(0.5),
    ];
    for (let length = 1; length <= 8; length++) {
      for (const cutaway of [false, true]) {
        const scene = buildPrototypeGeometry(
          project(candidates.slice(0, length)),
          {
            cutaway,
          },
        );
        expectPartition(scene);
        expect(scene.layerInterfaces).toHaveLength(length + 1);
        expect(scene.layers.at(-1)?.bottom).toBe(0);
        for (const [index, slab] of scene.layers.entries()) {
          expect(slab.top).toBe(scene.layerInterfaces[index]);
          expect(slab.bottom).toBe(scene.layerInterfaces[index + 1]);
          expect(slab.top).toBeGreaterThanOrEqual(slab.bottom);
          if (index > 0) expect(slab.top).toBe(scene.layers[index - 1].bottom);
        }
      }
    }
  });

  it("uses each axis's own period even at the extreme aspect ratios", () => {
    for (const [x, y] of [
      [20, 5000],
      [5000, 20],
      [123.5, 456.75],
    ]) {
      const scene = buildPrototypeGeometry(
        project([rectangle(x / 4, y / 5)], x, y),
      );
      expectPartition(scene);
      expect(scene.bounds.max.x - scene.bounds.min.x).toBe(3 * x);
      expect(scene.bounds.max.y - scene.bounds.min.y).toBe(3 * y);
      const material = scene.regions.filter(
        (region) => region.role === "material",
      );
      expect(material).toHaveLength(9);
      for (const region of material) {
        expect(region.size.x).toBeCloseTo(x / 4, 10);
        expect(region.size.y).toBeCloseTo(y / 5, 10);
        expect(region.size.z).toBe(90);
      }
    }
  });

  it("really removes the front quarter and exposes both center-cell default inclusions", () => {
    const full = buildPrototypeGeometry(defaultProject);
    const cut = buildPrototypeGeometry(defaultProject, { cutaway: true });
    expect(cut.bounds).toEqual(full.bounds);
    expect(cut.layers).toEqual(full.layers);
    expect(cut.layerInterfaces).toEqual(full.layerInterfaces);
    expect(cut.cutawayBounds).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 225, y: 210, z: 400 },
    });
    expectPartition(cut);
    expect(totalVolume(cut.regions)).toBe(totalVolume(full.regions) * 0.75);
    for (const layerIndex of [0, 2]) {
      const remaining = cut.regions.filter(
        (region) =>
          region.layerIndex === layerIndex && region.role === "material",
      );
      expect(totalVolume(remaining)).toBe(
        totalVolume(
          full.regions.filter(
            (region) =>
              region.layerIndex === layerIndex && region.role === "material",
          ),
        ) * 0.75,
      );
      // Cut faces go through the actual center inclusion, not only its surround.
      expect(
        remaining.some(
          ({ bounds }) =>
            bounds.max.x === 0 && bounds.min.y < 0 && bounds.max.y > 0,
        ),
      ).toBe(true);
      expect(
        remaining.some(
          ({ bounds }) =>
            bounds.max.y === 0 && bounds.min.x === 0 && bounds.max.x > 0,
        ),
      ).toBe(true);
      expect(
        remaining.every(({ bounds }) => bounds.max.x <= 0 || bounds.max.y <= 0),
      ).toBe(true);
    }
  });

  it("leaves all inputs untouched and restores the identical full stack after cutaway", () => {
    const source = freezeDeep(structuredClone(defaultProject));
    const before = JSON.stringify(source);
    const options = freezeDeep({ cutaway: true });
    const full = buildPrototypeGeometry(source);
    buildPrototypeGeometry(source, options);
    expect(buildPrototypeGeometry(source)).toEqual(full);
    expect(JSON.stringify(source)).toBe(before);
    expect(options).toEqual({ cutaway: true });
    expect(source).toEqual(defaultProject);
  });

  it("represents an entirely zero-thickness stack without inventing display thickness", () => {
    for (const cutaway of [false, true]) {
      const scene = buildPrototypeGeometry(
        project([rectangle(70, 60, 0), film(0)]),
        {
          cutaway,
        },
      );
      expect(scene.regions).toEqual([]);
      expect(scene.layerInterfaces).toEqual([0, 0, 0]);
      expect(scene.bounds.min.z).toBe(0);
      expect(scene.bounds.max.z).toBe(0);
      expectPartition(scene);
    }
  });

  it("rejects invalid geometry instead of silently clamping or changing its family", () => {
    const invalid: PrototypeGeometryProject[] = [
      project([]),
      project(Array.from({ length: 9 }, () => film())),
      project([film()], 19),
      project([film()], 5001),
      project([film()], 150, NaN),
      project([film()], 150, Infinity),
      project([rectangle(151, 60)]),
      project([rectangle(70, 141)]),
      project([rectangle(-1, 60)]),
      project([rectangle(70, NaN)]),
      project([ridge(151)]),
      project([film(-1)]),
      project([film(2001)]),
      project([film(Infinity)]),
      project([
        { ...film(), geometry: "ellipse" } as unknown as PrototypeGeometryLayer,
      ]),
    ];
    for (const source of invalid) {
      expect(() => buildPrototypeGeometry(source)).toThrow(RangeError);
      expect(() => buildPrototypeGeometry(source, { cutaway: true })).toThrow(
        RangeError,
      );
    }
  });
});
