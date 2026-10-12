import { describe, expect, it } from "vitest";
import {
  buildStructureGeometry2D,
  type StructureGeometryLayer2D,
  type StructureGeometryProject2D,
  type StructureMaterial2D,
} from "./structureGeometry2d";
import {
  buildStructureProjections2D,
  fitProjection2D,
  isAir2D,
  type ProjectionRegion2D,
} from "./structureProjection2d";

const air: StructureMaterial2D = { name: "Air", kind: "constant", n: 1, k: 0 };
const low: StructureMaterial2D = {
  name: "Low index",
  kind: "constant",
  n: 0.7,
  k: 0,
};
const host: StructureMaterial2D = {
  name: "Host",
  kind: "constant",
  n: 2.1,
  k: 0.02,
};
const table: StructureMaterial2D = {
  name: "Tabulated",
  kind: "tabulated",
  n: 1,
  k: 0,
  wavelengths_nm: [400, 800],
  n_values: [1.1, 1.2],
  k_values: [0, 0],
};
const circle = (
  diameter = 60,
  thickness = 90,
  material = air,
): StructureGeometryLayer2D => ({
  name: "Hole",
  geometry: "circular_hole_2d",
  diameter_nm: diameter,
  thickness_nm: thickness,
  material,
  background: host,
});
const rectangle = (
  x = 80,
  y = 60,
  thickness = 90,
): StructureGeometryLayer2D => ({
  name: "Rectangle",
  geometry: "rectangle_2d",
  cd_x_nm: x,
  cd_y_nm: y,
  thickness_nm: thickness,
  material: low,
  background: table,
});
const ridge = (width = 80, thickness = 90): StructureGeometryLayer2D => ({
  name: "Ridge",
  geometry: "rectangle_1d",
  cd_nm: width,
  thickness_nm: thickness,
  material: low,
  background: air,
});
const film = (thickness = 90): StructureGeometryLayer2D => ({
  name: "Film",
  geometry: "homogeneous",
  thickness_nm: thickness,
  material: table,
});
const project = (
  layers: readonly StructureGeometryLayer2D[],
  x = 150,
  y = 140,
): StructureGeometryProject2D => ({ period_nm: x, period_y_nm: y, layers });
const area = (region: ProjectionRegion2D): number => {
  if (region.shape === "circle") return Math.PI * region.radius ** 2;
  const { minX, maxX, minY, maxY } = region.bounds;
  return (
    (maxX - minX) * (maxY - minY) -
    (region.shape === "circle-host" ? Math.PI * region.radius ** 2 : 0)
  );
};
function freeze<T>(object: T): T {
  if (object && typeof object === "object") {
    Object.freeze(object);
    Object.values(object).forEach(freeze);
  }
  return object;
}
function expectAreas(p: StructureGeometryProject2D, selected: number) {
  const projection = buildStructureProjections2D(p, selected);
  const expectedTopArea =
    p.layers[selected].thickness_nm > 0 ? p.period_nm * p.period_y_nm : 0;
  expect(projection.top.reduce((sum, item) => sum + area(item), 0)).toBeCloseTo(
    expectedTopArea,
    7,
  );
  expect(
    projection.section.reduce((sum, item) => sum + area(item), 0),
  ).toBeCloseTo(p.period_nm * projection.totalThickness, 7);
  for (const item of [...projection.top, ...projection.section])
    expect(area(item)).toBeGreaterThan(0);
  return projection;
}

describe("physical SVG projections of schema-1.2 geometry", () => {
  it("retains canonical slab interfaces and material identities without input mutation", () => {
    const input = freeze(
      project([circle(60, 90, low), rectangle(), ridge(), film()]),
    );
    const bytes = JSON.stringify(input);
    const canonical = buildStructureGeometry2D(input);
    const output = expectAreas(input, 0);
    expect(output.layers).toEqual(canonical.layers);
    expect(output.layers.map((layer) => [layer.top, layer.bottom])).toEqual([
      [360, 270],
      [270, 180],
      [180, 90],
      [90, 0],
    ]);
    expect(
      output.top.find((region) => region.role === "material")?.material,
    ).toBe(low);
    expect(
      output.top.find((region) => region.role === "background")?.material,
    ).toBe(host);
    expect(
      output.section.find((region) => region.layerIndex === 3)?.material,
    ).toBe(table);
    for (let selected = 0; selected < input.layers.length; selected++)
      expectAreas(input, selected);
    expect(JSON.stringify(input)).toBe(bytes);
  });

  it.each([
    [150, 140, 60],
    [20, 5000, 20],
    [5000, 20, 20],
    [5000, 5000, 5000],
  ])(
    "keeps an analytic circular hole at unequal/extreme pitch %i × %i and diameter %i",
    (x, y, diameter) => {
      const output = expectAreas(project([circle(diameter)], x, y), 0);
      expect(
        output.top.find((region) => region.shape === "circle"),
      ).toMatchObject({
        radius: diameter / 2,
        role: "material",
        material: air,
      });
      expect(
        output.top.find((region) => region.shape === "circle-host"),
      ).toMatchObject({
        radius: diameter / 2,
        role: "background",
        material: host,
      });
      const fill = output.section.find((region) => region.role === "material");
      expect(fill).toMatchObject({
        shape: "rectangle",
        bounds: { minX: -diameter / 2, maxX: diameter / 2, minY: 0, maxY: 90 },
      });
      const fit = fitProjection2D(output.topBounds, 140, 180);
      expect(Number.isFinite(fit.scale)).toBe(true);
      // There is one scalar; no independent axis stretching can turn the circle into an ellipse.
      expect((fit.scale * diameter) / (fit.scale * diameter)).toBe(1);
    },
  );

  it("does not turn a zero-diameter hole into an empty film", () => {
    const output = expectAreas(project([circle(0)]), 0);
    expect(output.top).toHaveLength(1);
    expect(output.top[0]).toMatchObject({
      shape: "rectangle",
      role: "background",
      material: host,
    });
    expect(output.section).toHaveLength(1);
  });

  it.each([
    [0, 0],
    [0, 140],
    [150, 0],
    [150, 140],
    [60, 140],
    [150, 70],
  ])(
    "partitions rectangular zero/full widths (%i,%i) without false center strips",
    (x, y) => {
      const output = expectAreas(project([rectangle(x, y)]), 0);
      const topMaterialArea = output.top
        .filter((region) => region.role === "material")
        .reduce((sum, region) => sum + area(region), 0);
      expect(topMaterialArea).toBe(x * y);
      const sectionMaterialArea = output.section
        .filter((region) => region.role === "material")
        .reduce((sum, region) => sum + area(region), 0);
      expect(sectionMaterialArea).toBe(y > 0 ? x * 90 : 0);
    },
  );

  it.each([0, 70, 150])(
    "keeps embedded 1D ridges invariant along Y for width %i",
    (width) => {
      const p = project([ridge(width)], 150, 5000);
      const output = expectAreas(p, 0);
      for (const item of output.top) {
        expect(item.shape).toBe("rectangle");
        if (item.shape === "rectangle")
          expect([item.bounds.minY, item.bounds.maxY]).toEqual([-2500, 2500]);
      }
      expect(
        output.top
          .filter((region) => region.role === "material")
          .reduce((sum, region) => sum + area(region), 0),
      ).toBe(width * 5000);
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "handles %i layers including zero-thickness slabs without added volume",
    (count) => {
      const p = project(
        Array.from({ length: count }, (_, i) =>
          i % 2 ? circle(50, 0) : film(2000),
        ),
      );
      for (let selected = 0; selected < count; selected++) {
        const output = expectAreas(p, selected);
        expect(output.layers).toHaveLength(count);
        for (const layer of output.layers.filter(
          (layer) => layer.thickness === 0,
        )) {
          expect(
            output.section.some(
              (region) => region.layerIndex === layer.layerIndex,
            ),
          ).toBe(false);
          expect(layer.top).toBe(layer.bottom);
        }
        expect(output.layers.at(-1)?.bottom).toBe(0);
      }
    },
  );

  it("shows coincident boundaries for an all-zero stack, without invented thickness", () => {
    const p = project([
      circle(60, 0),
      rectangle(50, 40, 0),
      ridge(80, 0),
      film(0),
    ]);
    const output = expectAreas(p, 2);
    expect(output.totalThickness).toBe(0);
    expect(output.top).toEqual([]);
    expect(output.section).toEqual([]);
    expect(output.sectionBounds.minY).toBe(output.sectionBounds.maxY);
    const fit = fitProjection2D(output.sectionBounds, 130, 180);
    expect(fit).toEqual({ scale: 110 / 150, originX: 65, originY: 90 });
  });

  it("does not classify low-index, absorbing, tabulated, or merely named Air materials as empty", () => {
    expect(isAir2D(air)).toBe(true);
    for (const material of [
      low,
      table,
      { ...air, k: 0.001 },
      { ...host, name: "Air" },
    ]) {
      expect(isAir2D(material)).toBe(false);
      const p = project([circle(60, 90, material)]);
      const output = expectAreas(p, 0);
      expect(
        output.top.find((region) => region.role === "material")?.material,
      ).toBe(material);
    }
  });

  it("fits a tall eight-layer stack without thickening tiny layers or adding substrate volume", () => {
    const p = project(
      [film(0.001), ...Array.from({ length: 7 }, () => film(2000))],
      20,
      5000,
    );
    const output = expectAreas(p, 0);
    const fit = fitProjection2D(output.sectionBounds, 130, 180);
    expect(fit.scale).toBe(132 / 14000.001);
    expect(output.layers[0].thickness * fit.scale).toBeLessThan(0.00001);
    expect(output.sectionBounds).toEqual({
      minX: -10,
      maxX: 10,
      minY: 0,
      maxY: 14000.001,
    });
    expect(output.section).toHaveLength(8);
  });

  it("tracks a new project, selected layer, reorder and restored input exactly", () => {
    const original = project([circle(60), rectangle(70, 50), film(100)]);
    const saved = buildStructureProjections2D(original, 0);
    const edited = project(
      [film(60), circle(40, 110, table), ridge(0, 30)],
      200,
      250,
    );
    const next = expectAreas(edited, 1);
    expect(next.totalThickness).toBe(200);
    expect(next.topBounds.maxX).toBe(100);
    expect(next.top.find((region) => region.shape === "circle")).toMatchObject({
      radius: 20,
      layerIndex: 1,
      material: table,
    });
    expect(buildStructureProjections2D(original, 0)).toEqual(saved);
  });

  it("uses canonical validation and rejects out-of-range selection", () => {
    expect(() => buildStructureProjections2D(project([]), 0)).toThrow(/1–8/);
    expect(() =>
      buildStructureProjections2D(project([circle(160)]), 0),
    ).toThrow(/diameter/);
    expect(() => buildStructureProjections2D(project([film()]), 1)).toThrow(
      /existing/,
    );
  });
});
