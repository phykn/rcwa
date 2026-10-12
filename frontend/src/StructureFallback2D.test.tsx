import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import circular from "./fixtures/default-project-circular.json";
import { normalizeProject2D } from "./project2d";
import { StructureFallback2D } from "./StructureFallback2D";

describe("SVG fallback semantics", () => {
  it("provides labeled projections and a short notice without 3D-only controls or extra tab stops", () => {
    const p = normalizeProject2D(circular);
    const before = JSON.stringify(p);
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(
      createElement(StructureFallback2D, {
        project: p,
        selected: 0,
        onSelect,
        disabled: false,
      }),
    );
    expect(html).toContain('role="status">2D view · 3D unavailable.');
    expect(html).toContain('aria-label="Selected layer top view, X–Y"');
    expect(html).toContain('aria-label="Stack center section, X–Z at Y=0"');
    expect(html).toContain('data-projection="xy"');
    expect(html).toContain('data-projection="xz"');
    expect(html).toContain('data-air="true"');
    expect(html).toContain('fill-rule="evenodd"');
    expect(html).toContain("<circle");
    expect(html).toContain('data-boundary="ambient"');
    expect(html).toContain('data-boundary="substrate"');
    expect(html).not.toContain("tabindex=");
    expect(html).not.toContain("Reset view");
    expect(html).not.toContain("Cutaway");
    expect(html).not.toContain("<button");
    expect(html).toContain('data-layer-pick="0"');
    expect(JSON.stringify(p)).toBe(before);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps exact layer dimensions and disables diagram selection when busy", () => {
    const p = normalizeProject2D(circular);
    p.layers[1].thickness_nm = 0;
    const html = renderToStaticMarkup(
      createElement(StructureFallback2D, {
        project: p,
        selected: 1,
        onSelect: vi.fn(),
        disabled: true,
      }),
    );
    expect(html).toContain('data-thickness-nm="0"');
    expect(html).toContain("Zero thickness");
    expect(html).not.toContain("data-layer-pick=");
    expect(html).toContain("thin or zero-thickness layers");
  });
});
