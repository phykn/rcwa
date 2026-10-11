import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreeStructure } from "./ThreeStructure";
import { defaultProject } from "./model";
import type { Layer1D as Layer, Project1D as Project } from "./model";
import {
  dimensionRange,
  materialSummary,
  structureGeometry,
  structureLayerIndex,
  structureMaterialAppearance,
  visibleStructureDimensions,
  StructurePickGesture,
  structureValues,
} from "./structureGeometry";

describe("canonical 3D structure", () => {
  it("derives every physical dimension and angle from the project", () => {
    expect(structureValues(defaultProject)).toMatchObject({
      width: 180,
      height: 160,
      pitch: 400,
      angle: 15,
    });
  });

  it("preserves physical proportions throughout the admissible range", () => {
    for (const pitch of [20, 21, 400, 4999, 5000]) {
      for (const width of [0, pitch / 2, pitch]) {
        for (const height of [0, 1, 160, 1999, 2000]) {
          const scene = structureGeometry({ width, height, pitch, angle: 75 });
          expect(scene.scale).toBeGreaterThan(0);
          expect(scene.width / scene.scale).toBeCloseTo(width, 8);
          expect(scene.height / scene.scale).toBeCloseTo(height, 8);
          expect(scene.pitch / scene.scale).toBeCloseTo(pitch, 8);
          expect(Math.max(scene.span, scene.height)).toBeCloseTo(5.1, 8);
          expect(scene.width / scene.pitch).toBeCloseTo(width / pitch, 8);
        }
      }
    }
  });

  it("uses absent ridges at both zero endpoints and a continuous full-fill layer", () => {
    const values = structureValues(defaultProject);
    expect(structureGeometry({ ...values, width: 0 }).ridgeMode).toBe("none");
    expect(structureGeometry({ ...values, height: 0 }).ridgeMode).toBe("none");
    expect(
      structureGeometry({ ...values, width: values.pitch }).ridgeMode,
    ).toBe("continuous");
    expect(structureGeometry(values).ridgeMode).toBe("patterned");
  });

  it("exposes the complete canonical edit ranges", () => {
    const values = structureValues(defaultProject);
    expect(dimensionRange("width", values)).toEqual([0, 400]);
    expect(dimensionRange("height", values)).toEqual([0, 2000]);
    expect(dimensionRange("pitch", values)).toEqual([180, 5000]);
    expect(dimensionRange("pitch", { ...values, width: 0 })).toEqual([
      20, 5000,
    ]);
  });

  it("never labels tabulated data with the unused constant fields", () => {
    expect(
      materialSummary({
        ...defaultProject.ambient,
        kind: "tabulated",
        n: 9.99,
      }),
    ).toBe("Tabulated n/k");
    expect(materialSummary(defaultProject.ambient)).toBe("n 1 · k 0");
  });
});

const rectangle = (height: number, width: number): Layer => ({
  name: "Patterned layer",
  geometry: "rectangle_1d",
  thickness_nm: height,
  cd_nm: width,
  material: defaultProject.layers[0].material,
  background: defaultProject.ambient,
});
const film = (height: number): Layer => ({
  name: "Uniform film",
  geometry: "homogeneous",
  thickness_nm: height,
  material: defaultProject.substrate,
});
const stack = (...layers: Layer[]): Project => ({
  ...defaultProject,
  schema_version: "1.1",
  layers,
});

describe("multilayer stack geometry", () => {
  it("places top-to-bottom layers at cumulative interfaces above the substrate", () => {
    const project = stack(rectangle(160, 180), film(90), rectangle(50, 100));
    const scene = structureGeometry(structureValues(project));
    expect(scene.totalHeight / scene.scale).toBeCloseTo(300);
    expect(scene.layers.map((layer) => layer.index)).toEqual([0, 1, 2]);
    const expected = [
      [140, 300],
      [50, 140],
      [0, 50],
    ];
    scene.layers.forEach((layer, index) => {
      expect(layer.bottom / scene.scale).toBeCloseTo(expected[index][0]);
      expect(layer.top / scene.scale).toBeCloseTo(expected[index][1]);
      expect(layer.center).toBeCloseTo((layer.top + layer.bottom) / 2);
      expect(layer.top - layer.bottom).toBeCloseTo(layer.height);
      if (index > 0) expect(layer.top).toBe(scene.layers[index - 1].bottom);
    });
    expect(scene.layers[2].bottom).toBe(0);
  });

  it("keeps exact shared interfaces and substrate contact for decimal thicknesses", () => {
    const scene = structureGeometry(
      structureValues(stack(film(0.1), film(0.2), film(0.3))),
    );
    expect(scene.layers[2].bottom).toBe(0);
    expect(scene.layers[0].bottom).toBe(scene.layers[1].top);
    expect(scene.layers[1].bottom).toBe(scene.layers[2].top);
    expect(scene.layers.every((layer) => layer.bottom >= 0)).toBe(true);
  });

  it("fills the complete cell with groove material at zero CD, but no volume at zero thickness", () => {
    const scene = structureGeometry(
      structureValues(stack(rectangle(80, 0), rectangle(0, 100), film(0))),
    );
    expect(scene.layers[0].ridgeMode).toBe("none");
    expect(scene.layers[0].regions).toEqual([
      { kind: "groove", width: scene.span, x: 0 },
    ]);
    expect(scene.layers[1].regions).toEqual([]);
    expect(scene.layers[2].regions).toEqual([]);
    expect(scene.layers[1].top).toBe(scene.layers[1].bottom);
    expect(scene.layers[2].top).toBe(scene.layers[2].bottom);
  });

  it("uses one continuous volume for full CD and homogeneous films", () => {
    const scene = structureGeometry(
      structureValues(stack(rectangle(80, 400), film(30))),
    );
    for (const layer of scene.layers) {
      expect(layer.ridgeMode).toBe("continuous");
      expect(layer.regions).toEqual([
        { kind: "ridge", width: scene.span, x: 0 },
      ]);
    }
  });

  it("partitions patterned ridge and groove volumes without gaps or overlap", () => {
    for (const width of [0.01, 1, 180, 399.99]) {
      const scene = structureGeometry(
        structureValues(stack(rectangle(160, width))),
      );
      const regions = scene.layers[0].regions;
      expect(regions.filter((region) => region.kind === "ridge")).toHaveLength(
        3,
      );
      expect(regions.filter((region) => region.kind === "groove")).toHaveLength(
        4,
      );
      expect(
        regions.reduce((total, region) => total + region.width, 0),
      ).toBeCloseTo(scene.span, 10);
      let right = -scene.span / 2;
      for (const region of regions) {
        expect(region.width).toBeGreaterThan(0);
        expect(region.x - region.width / 2).toBeCloseTo(right, 10);
        right = region.x + region.width / 2;
      }
      expect(right).toBeCloseTo(scene.span / 2, 10);
      for (const region of regions.filter((region) => region.kind === "ridge"))
        expect(region.width / scene.scale).toBeCloseTo(width, 10);
    }
  });

  it("uses one scale for every layer and scales from the total stack height", () => {
    const project = stack(
      ...Array.from({ length: 8 }, (_, index) =>
        index % 2 ? film(2000) : rectangle(2000, 100),
      ),
    );
    const scene = structureGeometry(structureValues(project, 3));
    expect(scene.totalHeight).toBeCloseTo(5.1);
    expect(scene.scale).toBeCloseTo(5.1 / 16000);
    expect(scene.layers).toHaveLength(8);
    for (const layer of scene.layers)
      expect(layer.height / scene.scale).toBeCloseTo(2000);
    expect(scene.pitch / scene.scale).toBeCloseTo(400);
    expect(scene.depth).toBe(3.3);
    expect(scene.substrateDepth).toBe(0.25);
    const fixed = structureGeometry(structureValues(project, 3), 0.01);
    expect(fixed.scale).toBe(0.01);
    expect(fixed.totalHeight).toBe(160);
    expect(fixed.layers[0].width).toBe(1);
    expect(fixed.layers[7].height).toBe(20);
  });

  it("keeps all-zero-thickness stacks finite and selectable", () => {
    const scene = structureGeometry(
      structureValues(stack(film(0), rectangle(0, 400))),
    );
    expect(scene.scale).toBeGreaterThan(0);
    expect(scene.totalHeight).toBe(0);
    expect(
      scene.layers.every(
        (layer) =>
          layer.regions.length === 0 && layer.top === 0 && layer.bottom === 0,
      ),
    ).toBe(true);
  });

  it("selects only the chosen layer's dimensions and omits uniform-film CD controls", () => {
    const project = stack(rectangle(160, 180), film(90), rectangle(50, 100));
    const values = structureValues(project, 2);
    expect(values).toMatchObject({
      selectedLayer: 2,
      width: 100,
      height: 50,
      pitch: 400,
    });
    const scene = structureGeometry(values);
    expect(scene.selectedLayer).toBe(2);
    expect(scene.top).toBe(scene.layers[2].top);
    expect(scene.bottom).toBe(0);
    expect(visibleStructureDimensions(values)).toEqual([
      "width",
      "height",
      "pitch",
    ]);
    expect(visibleStructureDimensions(structureValues(project, 1))).toEqual([
      "height",
      "pitch",
    ]);
    expect(structureValues(project, 1).height).toBe(90);
    expect(structureValues(project, -5).selectedLayer).toBe(0);
    expect(structureValues(project, 9).selectedLayer).toBe(2);
    expect(structureLayerIndex(3, NaN)).toBe(0);
    expect(structureLayerIndex(3, 1.8)).toBe(1);
  });

  it("guards shared pitch with the largest patterned CD, independent of selection", () => {
    const project = stack(rectangle(160, 360), film(90), rectangle(50, 100));
    const original = JSON.stringify(project);
    for (let selected = 0; selected < project.layers.length; selected++)
      expect(
        dimensionRange("pitch", structureValues(project, selected)),
      ).toEqual([360, 5000]);
    expect(
      dimensionRange("pitch", structureValues(stack(film(80), film(40)))),
    ).toEqual([20, 5000]);
    expect(JSON.stringify(project)).toBe(original);
  });

  it("shows a truthful selected-layer geometry when a drag overrides its values", () => {
    const values = structureValues(
      stack(rectangle(100, 200), rectangle(50, 100)),
      1,
    );
    const scene = structureGeometry(
      { ...values, width: 130, height: 70 },
      0.01,
    );
    expect(scene.layers[0].width).toBe(2);
    expect(scene.layers[0].height).toBe(1);
    expect(scene.layers[1].width).toBe(1.3);
    expect(scene.layers[1].height).toBeCloseTo(0.7);
    expect(scene.totalHeight).toBe(1.7);
    expect(scene.layers[0].bottom).toBe(scene.layers[1].top);
  });

  it("uses stable optical-material colors and opaque non-air backgrounds", () => {
    const material = defaultProject.layers[0].material;
    expect(structureMaterialAppearance(material)).toEqual(
      structureMaterialAppearance({
        ...material,
        name: "Renamed material",
        source: "Other source",
      }),
    );
    expect(
      structureMaterialAppearance(defaultProject.ambient).opacity,
    ).toBeLessThan(1);
    expect(
      structureMaterialAppearance({ ...defaultProject.ambient, n: 1.33 })
        .opacity,
    ).toBe(1);
    expect(
      structureMaterialAppearance({ ...defaultProject.ambient, k: 0.1 })
        .opacity,
    ).toBe(1);
    const tabulated = {
      ...material,
      kind: "tabulated" as const,
      wavelengths_nm: [400, 800],
      n_values: [2, 2],
      k_values: [0, 0],
    };
    expect(structureMaterialAppearance(tabulated)).toEqual(
      structureMaterialAppearance({ ...tabulated, n: 9, k: 9 }),
    );
  });
});

describe("selected-layer scene controls", () => {
  const render = (project: Project, selectedLayer: number) =>
    renderToStaticMarkup(
      createElement(ThreeStructure, {
        project,
        selectedLayer,
        onChange: () => undefined,
        onOpen: () => undefined,
      }),
    );

  it("renders only film thickness and global pitch controls for a homogeneous selection", () => {
    const markup = render(stack(rectangle(160, 180), film(90)), 1);
    expect(markup.match(/aria-label="Set /g)).toHaveLength(2);
    expect(markup).not.toContain('aria-label="Drag width"');
    expect(markup).not.toContain('role="slider"');
    expect(markup).toContain(
      'aria-label="Set layer thickness, currently 90 nanometers"',
    );
    expect(markup).toContain("Layer settings");
    expect(markup).toContain("<span>Thickness</span>");
    expect(markup).not.toContain('class="scene-model-note"');
  });

  it("renders the selected patterned layer rather than implicitly editing the top layer", () => {
    const markup = render(
      stack(rectangle(160, 340), film(90), rectangle(50, 100)),
      2,
    );
    expect(markup.match(/aria-label="Set /g)).toHaveLength(3);
    expect(markup).toContain(
      'aria-label="Set layer width, currently 100 nanometers"',
    );
    expect(markup).toContain(
      'aria-label="Set layer thickness, currently 50 nanometers"',
    );
    expect(markup).toContain("Shared pitch");
    expect(markup).toContain("Selected: Layer 3");
    expect(markup).toContain("<span>Thickness</span>");
  });

  it("keeps a stale selection usable after removing the previous last layer", () => {
    const markup = render(stack(rectangle(160, 180), film(90)), 7);
    expect(markup.match(/aria-label="Set /g)).toHaveLength(2);
    expect(markup).toContain(
      'aria-label="Set layer thickness, currently 90 nanometers"',
    );
  });
});

describe("material picking", () => {
  it("accepts a stationary single-pointer tap", () => {
    const gesture = new StructurePickGesture();
    gesture.down(1, 10, 10, true);
    expect(gesture.up(1, 10, 10)).toBe(true);
  });

  it("rejects orbit even if the pointer ends at its starting position", () => {
    const gesture = new StructurePickGesture();
    gesture.down(1, 10, 10, true);
    gesture.move(1, 30, 10);
    expect(gesture.up(1, 10, 10)).toBe(false);
    gesture.down(1, 10, 10, true);
    gesture.cameraChanged();
    expect(gesture.up(1, 10, 10)).toBe(false);
  });

  it("rejects both fingers of a pinch and permits the next distinct tap", () => {
    const gesture = new StructurePickGesture();
    gesture.down(1, 10, 10, true);
    gesture.down(2, 20, 20, true);
    expect(gesture.up(1, 10, 10)).toBe(false);
    expect(gesture.up(2, 20, 20)).toBe(false);
    gesture.down(3, 10, 10, true);
    expect(gesture.up(3, 10, 10)).toBe(true);
  });

  it("rejects cancelled, suppressed and non-primary-button gestures", () => {
    const gesture = new StructurePickGesture();
    gesture.down(1, 10, 10, true);
    gesture.cancel(1);
    expect(gesture.up(1, 10, 10)).toBe(false);
    gesture.down(2, 10, 10, false);
    expect(gesture.up(2, 10, 10)).toBe(false);
    gesture.down(3, 10, 10, true);
    gesture.suppress();
    expect(gesture.up(3, 10, 10)).toBe(false);
  });
});
