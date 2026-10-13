import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import exactDefault from "../../backend/tests/fixtures/true-2d/default-project.json";
import {
  DimensionEditor2D,
  dimensionFields2D,
  exactDimensionText2D,
  formatDimension2D,
  parseDimensionDraft2D,
} from "./DimensionEditor2D";
import { DimensionCards2D, ThreeStructure2D } from "./ThreeStructure2D";
import type { StructureViewProject2D } from "./ThreeStructure2D";
import type {
  StructureGeometryLayer2D,
  StructureGeometryProject2D,
} from "./structureGeometry2d";

const source = exactDefault as StructureViewProject2D;
const cards = (project = source, selectedLayer = 0, disabled = false) =>
  renderToStaticMarkup(
    createElement(DimensionCards2D, {
      project,
      selectedLayer,
      disabled,
      onEdit: () => {},
    }),
  );
const editor = (
  project: StructureGeometryProject2D = source,
  selectedLayer = 0,
  kind: "width" | "pitch" = "width",
  disabled = false,
) =>
  renderToStaticMarkup(
    createElement(DimensionEditor2D, {
      project,
      selectedLayer,
      kind,
      disabled,
      onChange: () => {},
      onBeginEdit: () => {},
      onEndEdit: () => {},
      onDone: () => {},
    }),
  );

describe("2D numeric dimension contracts", () => {
  it("provides persistent Width X/Y fields with each axis's own bound", () => {
    expect(dimensionFields2D(source, 2, "width")).toEqual([
      { axis: "x", label: "Width X", value: 95, min: 0, max: 150 },
      { axis: "y", label: "Width Y", value: 80, min: 0, max: 140 },
    ]);
    const html = editor(source, 2);
    expect(html.match(/type="number"/g)).toHaveLength(2);
    expect(html.match(/<span>nm<\/span>/g)).toHaveLength(2);
    expect(html).toContain(
      'data-axis="x" type="number" inputMode="decimal" step="any" min="0" max="150"',
    );
    expect(html).toContain(
      'data-axis="y" type="number" inputMode="decimal" step="any" min="0" max="140"',
    );
    expect(html).toContain("Width X");
    expect(html).toContain("Width Y");
    expect(html).toContain('value="95"');
    expect(html).toContain('value="80"');
    expect(html.match(/type="range"/g)).toHaveLength(2);
    expect(html).not.toContain("<dialog");
    expect(html).toContain(">Done</button>");
  });

  it("sets shared minima from the correct axis and names the limiting layer", () => {
    expect(dimensionFields2D(source, 0, "pitch")).toEqual([
      {
        axis: "x",
        label: "Pitch X",
        value: 150,
        min: 95,
        max: 5000,
        minimumReason: "Pitch X must be at least 95 nm because of Layer 3.",
      },
      {
        axis: "y",
        label: "Pitch Y",
        value: 140,
        min: 80,
        max: 5000,
        minimumReason: "Pitch Y must be at least 80 nm because of Layer 3.",
      },
    ]);
    const html = editor(source, 0, "pitch");
    expect(html).toContain("Repeat spacing for all layers.");
    expect(html).toContain("Pitch X");
    expect(html).toContain("Pitch Y");
    expect(html).toContain('min="95" max="5000"');
    expect(html).toContain('min="80" max="5000"');
  });

  it("keeps mixed 1D width X-only, paired shared pitch, and no invented film width", () => {
    const ridge: StructureGeometryLayer2D = {
      name: "Ridge",
      geometry: "rectangle_1d",
      cd_nm: 125,
      thickness_nm: 20,
      material: source.layers[0].material,
      background: source.layers[0].material,
    };
    const mixed = {
      ...source,
      layers: [source.layers[0], ridge, source.layers[1]],
    };
    expect(dimensionFields2D(mixed, 1, "width")).toEqual([
      { axis: "x", label: "Width X", value: 125, min: 0, max: 150 },
    ]);
    const pitch = dimensionFields2D(mixed, 1, "pitch");
    expect(pitch[0].min).toBe(125);
    expect(pitch[0].minimumReason).toContain("Layer 2");
    expect(pitch[1].min).toBe(60);
    expect(pitch[1].minimumReason).toContain("Layer 1");
    expect(editor(mixed, 1).match(/type="number"/g)).toHaveLength(1);
    expect(editor(mixed, 1)).not.toContain("Width Y");
    expect(editor(mixed, 1, "pitch").match(/type="number"/g)).toHaveLength(2);
    expect(dimensionFields2D(mixed, 2, "width")).toEqual([]);
    expect(
      dimensionFields2D(
        { ...source, layers: [source.layers[1]] },
        0,
        "pitch",
      ).map(({ min }) => min),
    ).toEqual([20, 20]);
  });

  it("never clamps, coerces empty input to zero, or parses non-decimal drafts", () => {
    for (const text of [
      "",
      " ",
      "-",
      "+",
      ".",
      "1e",
      "NaN",
      "Infinity",
      "1e999",
      "0x40",
      "0b10",
      "1,000",
      "abc",
      "-0.001",
      "150.000001",
    ])
      expect(parseDimensionDraft2D(text, 0, 150), text).toBeNull();
    for (const text of ["0", "0.0", ".1", "1.25", "1e2", "+2", "150", " 70.5 "])
      expect(parseDimensionDraft2D(text, 0, 150), text).toBe(Number(text));
    expect(parseDimensionDraft2D("89", 90, 5000)).toBeNull();
    expect(parseDimensionDraft2D("5001", 90, 5000)).toBeNull();
    expect(parseDimensionDraft2D("160", 90, 5000)).toBe(160);
    expect(Object.is(parseDimensionDraft2D("-0", 0, 150), -0)).toBe(true);
    expect(exactDimensionText2D(-0)).toBe("-0");
  });

  it("retains every input unchanged while deriving controls", () => {
    const original = structuredClone(source),
      before = JSON.stringify(original);
    for (let i = 0; i < original.layers.length; i++) {
      dimensionFields2D(original, i, "width");
      dimensionFields2D(original, i, "pitch");
      cards(original, i);
      editor(original, i);
    }
    expect(JSON.stringify(original)).toBe(before);
  });

  it("locks numeric fields during a run while keeping Done available", () => {
    const html = editor(source, 2, "width", true);
    expect(html.match(/disabled=""/g)).toHaveLength(4);
    expect(html).toContain(
      '<button type="button" class="s2-done">Done</button>',
    );
  });
});

describe("accepted 2D first-use controls", () => {
  it("keeps three cards with separate X/Y labels and exact accessible values", () => {
    const html = cards(source, 2);
    expect(html.match(/<button /g)).toHaveLength(3);
    expect(html).toContain(
      'aria-label="Edit Layer 3 width: X 95 nanometers, Y 80 nanometers"',
    );
    expect(html).toContain(
      'aria-label="Edit Layer 3 thickness: 130 nanometers"',
    );
    expect(html).toContain(
      'aria-label="Edit shared pitch: X 150 nanometers, Y 140 nanometers"',
    );
    expect(html.match(/<small>X<\/small>/g)).toHaveLength(2);
    expect(html.match(/<small>Y<\/small>/g)).toHaveLength(2);
    expect(html.match(/Edit ↗/g)).toHaveLength(3);
    expect(cards(source, 2, true).match(/disabled=""/g)).toHaveLength(3);
  });

  it("uses two cards for a film and describes zero dimensions without fake volume", () => {
    const film = cards(source, 1);
    expect(film.match(/<button /g)).toHaveLength(2);
    expect(film).toContain('data-uniform="true"');
    expect(film).not.toContain(">Width</span>");
    const zero = {
      ...source,
      layers: source.layers.map((layer) => ({ ...layer, thickness_nm: 0 })),
    };
    expect(cards(zero, 0)).toContain("zero thickness and no visible volume");
    const layer = source.layers[0];
    if (layer.geometry !== "rectangle_2d")
      throw new Error("Expected 2D fixture");
    expect(
      cards({ ...source, layers: [{ ...layer, cd_y_nm: 0 }] }, 0),
    ).toContain("zero pattern width; its background fills the layer");
  });

  it("keeps compact labels while preserving exact tiny, decimal and extreme values", () => {
    for (const value of [
      0,
      -0,
      70,
      0.0001,
      1e-20,
      1e-308,
      Number.MIN_VALUE,
      12.123456789,
      4999.99999999,
      5000,
    ]) {
      const display = formatDimension2D(value);
      expect(display.length).toBeLessThanOrEqual(8);
      if (value > 0) expect(Number(display)).toBeGreaterThan(0);
      const layer = source.layers[0];
      if (layer.geometry !== "rectangle_2d")
        throw new Error("Expected 2D fixture");
      const project = {
        ...source,
        period_nm: 5000,
        layers: [{ ...layer, cd_x_nm: value }],
      };
      expect(cards(project)).toContain(
        `X ${exactDimensionText2D(value)} nanometers`,
      );
      expect(editor(project)).toContain(
        `value="${exactDimensionText2D(value)}"`,
      );
    }
    expect(formatDimension2D(70)).toBe("70");
    expect(formatDimension2D(60)).toBe("60");
    expect(formatDimension2D(150)).toBe("150");
  });

  it("exposes native Full stack/Cutaway while exact SVG loads the renderer", () => {
    const html = renderToStaticMarkup(
      createElement(ThreeStructure2D, {
        project: source,
        selectedLayer: 2,
        onSelectLayer: () => {},
      }),
    );
    expect(html).toContain('aria-label="Structure view"');
    expect(html).toContain('<option value="full">Full stack</option>');
    expect(html).toContain(
      '<option value="cutaway" selected="">Cutaway</option>',
    );
    expect(html).toContain("2D view · 3D loading.");
    expect(html).not.toContain("Corner hidden");
    expect(html.indexOf("<select")).toBeLessThan(html.indexOf("<details"));
    expect(html).toContain('aria-label="View guide"');
    expect(html).not.toContain(">Reset view</button>");
    expect(html).toContain(
      'tabindex="0" role="region" aria-label="View guide details"',
    );
    expect(html).toContain("Each projection has equal");
    expect(html).toContain(
      "Exact dimensions and materials remain editable below",
    );
    expect(html).toContain("Selected: Layer 3");
    expect(html).not.toContain("drag to resize");
  });
});
