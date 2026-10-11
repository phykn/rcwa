import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  normalizeProject2D,
  canonicalProject2D,
  stringify2DEnvelope,
  validateProject2D,
} from "./project2d";
import {
  editStack,
  defaultProject,
  maximumPatternedCDX,
  maximumPatternedCDY,
  stackSummary,
  parseProjectFile,
} from "./model";
import { DimensionCards2D } from "./ThreeStructure2D";
import { DimensionEditor2D, dimensionFields2D } from "./DimensionEditor2D";
import { reviewInputChanges } from "./reviewChanges";

const circle = () =>
  normalizeProject2D({
    schema_version: "1.2",
    name: "Circle editor contract fixture",
    period_nm: 150,
    period_y_nm: 140,
    layers: [
      {
        geometry: "circular_hole_2d",
        name: "Hole",
        thickness_nm: 90,
        diameter_nm: 70,
        material: { name: "Air", n: 1 },
        background: { name: "Host", n: 2 },
      },
    ],
    illumination: { wavelengths_nm: [600] },
  });

describe("additive circular-hole input and editor", () => {
  it("round-trips the explicit geometry without rectangular width fields", () => {
    const project = circle();
    const restored = parseProjectFile(stringify2DEnvelope({ project })).project;
    expect(canonicalProject2D(restored)).toBe(canonicalProject2D(project));
    expect(project.layers[0]).toMatchObject({
      geometry: "circular_hole_2d",
      diameter_nm: 70,
    });
    expect(project.layers[0]).not.toHaveProperty("cd_x_nm");
    expect(project.layers[0]).not.toHaveProperty("cd_y_nm");
    expect(stackSummary(project)).toContain("Diameter 70 nm");
  });
  it("rejects coercion, invalid diameters and foreign dimensions without clamping", () => {
    for (const diameter_nm of [
      -1,
      140.001,
      150,
      "70",
      true,
      null,
      Infinity,
      NaN,
    ]) {
      const p = circle();
      Object.assign(p.layers[0], { diameter_nm });
      expect(validateProject2D(p)).not.toEqual([]);
    }
    for (const diameter_nm of [0, -0, 140]) {
      const p = circle();
      Object.assign(p.layers[0], { diameter_nm });
      expect(validateProject2D(p)).toEqual([]);
      expect(
        Object.is(
          (normalizeProject2D(p).layers[0] as { diameter_nm: number })
            .diameter_nm,
          diameter_nm,
        ),
      ).toBe(true);
    }
    const p = circle();
    Object.assign(p.layers[0], { cd_x_nm: 70 });
    expect(validateProject2D(p)).not.toEqual([]);
  });
  it("exposes a single diameter with both shared pitch bounds", () => {
    const p = circle();
    expect(dimensionFields2D(p, 0, "width")).toEqual([
      { axis: "x", label: "Diameter", value: 70, min: 0, max: 140 },
    ]);
    expect(dimensionFields2D(p, 0, "pitch").map((f) => f.min)).toEqual([
      70, 70,
    ]);
    expect(maximumPatternedCDX(p)).toBe(70);
    expect(maximumPatternedCDY(p)).toBe(70);
    const html = renderToStaticMarkup(
      createElement(DimensionCards2D, {
        project: p,
        selectedLayer: 0,
        onEdit: () => {},
      }),
    );
    expect(html).toContain('aria-label="Edit Layer 1 diameter: 70 nanometers"');
    expect(html).toContain(
      'aria-label="Edit Layer 1 thickness: 90 nanometers"',
    );
    expect(html).not.toContain(">Width<");
    const sheet = renderToStaticMarkup(
      createElement(DimensionEditor2D, {
        project: p,
        selectedLayer: 0,
        kind: "width",
        onChange: () => {},
        onBeginEdit: () => {},
        onEndEdit: () => {},
        onDone: () => {},
      }),
    );
    expect(sheet.match(/<input /g)).toHaveLength(1);
    expect(sheet).toContain("Diameter");
    expect(sheet).not.toContain("Width X");
    expect(sheet).not.toContain("Width Y");
  });
  it("preserves explicit legacy projects and supports bounded shape edits", () => {
    expect(() =>
      editStack(defaultProject, 0, {
        type: "add",
        geometry: "circular_hole_2d",
      }),
    ).toThrow(/not silently converted/);
    const p = circle();
    const rectangle = editStack(p, 0, {
      type: "geometry",
      geometry: "rectangle_2d",
    }).project;
    expect(rectangle.layers[0]).toMatchObject({
      geometry: "rectangle_2d",
      cd_x_nm: 70,
      cd_y_nm: 70,
    });
    expect(rectangle.layers[0]).not.toHaveProperty("diameter_nm");
    const restored = editStack(rectangle, 0, {
      type: "geometry",
      geometry: "circular_hole_2d",
    }).project;
    expect(restored.layers[0]).toMatchObject({
      geometry: "circular_hole_2d",
      diameter_nm: 70,
    });
    expect(restored.layers[0]).not.toHaveProperty("cd_x_nm");
    expect(
      validateProject2D(
        editStack(p, 0, { type: "add", geometry: "circular_hole_2d" }).project,
      ),
    ).toEqual([]);
    expect(editStack(p, 0, { type: "duplicate" }).project.layers).toHaveLength(
      2,
    );
    expect(p.layers).toHaveLength(1);
  });
  it("reports diameter changes as diameter, preserving exact input values", () => {
    const before = circle(),
      after = circle();
    Object.assign(after.layers[0], { diameter_nm: 71.125 });
    expect(reviewInputChanges(before, after)).toEqual([
      expect.objectContaining({
        label: expect.stringContaining("Diameter"),
        before: "70 nm",
        after: "71.125 nm",
      }),
    ]);
  });
});
