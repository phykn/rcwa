import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreeStructure } from "./ThreeStructure";
import { ThreeStructure2D, DimensionCards2D } from "./ThreeStructure2D";
import { StructureFallback2D } from "./StructureFallback2D";
import { buildStructureProjections2D } from "./structureProjection2d";
import { normalizeProject2D } from "./project2d";
import circular from "./fixtures/default-project-circular.json";
import { defaultProject } from "./model";

// Synchronous UI/projection imports must work even when no renderer is usable.
// This catches a transitive leak through the physical circular mesh generator.
vi.mock("three", () => {
  throw new Error("Three must remain deferred");
});
vi.mock("./StructureCanvas2D", () => {
  throw new Error("2D renderer must remain deferred");
});
vi.mock("./threeStructureRenderer", () => {
  throw new Error("Legacy renderer must remain deferred");
});

describe("renderer-independent initial UI", () => {
  it("renders exact circular projections and dimension controls without loading Three", () => {
    const project = normalizeProject2D(circular);
    const before = JSON.stringify(project);
    const onSelectLayer = vi.fn(),
      onEdit = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ThreeStructure2D, {
        project,
        selectedLayer: 0,
        onSelectLayer,
      }),
    );
    expect(html).toContain('data-renderer-state="loading"');
    expect(html).toContain("2D view · 3D loading.");
    expect(html).not.toContain("3D unavailable");
    expect(html).toContain('data-projection="xy"');
    expect(html).toContain('data-projection="xz"');
    expect(html).toContain('fill-rule="evenodd"');
    expect(html).toContain('aria-label="Structure view"');
    expect(html).not.toContain("<canvas");
    const cards = renderToStaticMarkup(
      createElement(DimensionCards2D, { project, selectedLayer: 0, onEdit }),
    );
    expect(cards).toContain("Edit Layer 1 diameter: 65 nanometers");
    expect(cards).toContain("Edit Layer 1 thickness: 90 nanometers");
    expect(cards).toContain(
      "Edit shared pitch: X 150 nanometers, Y 140 nanometers",
    );
    expect(cards).not.toContain("disabled");
    expect(
      buildStructureProjections2D(project, 0).top.some(
        (region) => region.shape === "circle",
      ),
    ).toBe(true);
    expect(JSON.stringify(project)).toBe(before);
    expect(onSelectLayer).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });
  it("distinguishes an unavailable renderer from an initial loading projection", () => {
    const html = renderToStaticMarkup(
      createElement(StructureFallback2D, {
        project: normalizeProject2D(circular),
        selected: 0,
        disabled: false,
        onSelect: vi.fn(),
      }),
    );
    expect(html).toContain("2D view · 3D unavailable.");
    expect(html).not.toContain("3D loading");
  });
  it("keeps legacy exact editing controls synchronous with truthful loading text", () => {
    const onChange = vi.fn(),
      onOpen = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ThreeStructure, {
        project: defaultProject,
        onChange,
        onOpen,
      }),
    );
    expect(html).toContain('data-loading="true"');
    expect(html).toContain("Loading 3D view…");
    expect(html).not.toContain("3D view is unavailable");
    expect(html).toContain(
      'aria-label="Set layer width, currently 180 nanometers"',
    );
    expect(html).toContain(
      'aria-label="Set layer thickness, currently 160 nanometers"',
    );
    expect(html).toContain(
      'aria-label="Set shared pitch, currently 400 nanometers"',
    );
    expect(html).not.toMatch(/<button[^>]*\sdisabled=/);
    expect(onChange).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
