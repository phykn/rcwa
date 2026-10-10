import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LayerActions, LayerStack } from "./LayerStack";
import { defaultProject } from "./model";
import type { Project } from "./model";

function project(count = 1): Project {
  return {
    ...structuredClone(defaultProject),
    schema_version: count > 1 ? "1.1" : "1.0",
    layers: Array.from({ length: count }, (_, index) => ({
      ...structuredClone(defaultProject.layers[0]),
      name: `Layer ${index + 1}`,
    })),
  };
}
function picker(value = project(), selected = 0, disabled = false) {
  return renderToStaticMarkup(
    createElement(LayerStack, {
      project: value,
      selected,
      disabled,
      onSelect: () => {},
      onChange: () => {},
    }),
  );
}

describe("progressive layer controls", () => {
  it("shows layer choices immediately and keeps only Add closed", () => {
    const html = picker();
    expect(html.match(/<details\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<details[^>]*\bopen=/);
    expect(html).toContain('aria-label="Choose a layer"');
    expect(html).toContain(
      'aria-label="Select layer 1: Layer 1" aria-pressed="true"',
    );
    expect(html).toContain('aria-label="Add layer"');
    expect(html).toContain("Repeating ridges and gaps");
    expect(html).not.toContain("Edit selected layer");
    expect(html).not.toContain("Layer actions");
  });
  it("lists every bounded layer and attributes the current selection without persistent IDs", () => {
    const value = project(8),
      before = JSON.stringify(value),
      html = picker(value, 7);
    expect(html.match(/data-layer-index=/g)).toHaveLength(8);
    expect(html).toContain(
      'aria-label="Select layer 8: Layer 8" aria-pressed="true"',
    );
    expect(html).toContain(
      'aria-label="Add layer" aria-describedby="layer-limit-reason" aria-disabled="true"',
    );
    expect(html).toContain("8-layer limit");
    expect(html).toContain(
      "Maximum of 8 layers. Remove a layer before adding another.",
    );
    expect(html).toContain('disabled="" aria-label="Add patterned layer"');
    expect(html).toContain('disabled="" aria-label="Add uniform layer"');
    expect(JSON.stringify(value)).toBe(before);
  });
  it("locks the picker during work and retains explicit selectable uniform rows", () => {
    const value = project(2);
    value.layers[1] = {
      name: "Film",
      geometry: "homogeneous",
      thickness_nm: 40,
      material: structuredClone(defaultProject.substrate),
    };
    const html = picker(value, 1, true);
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain('aria-label="Select layer 2: Film"');
    expect(html).toContain("Uniform");
  });
  it("keeps structural actions in a closed inspector disclosure with full text and bounds", () => {
    const single = renderToStaticMarkup(
      createElement(LayerActions, {
        selected: 0,
        count: 1,
        disabled: false,
        onChange: () => {},
      }),
    );
    expect(single).not.toMatch(/<details[^>]*\bopen=/);
    expect(single).toContain('aria-label="Layer actions"');
    expect(single).toContain('disabled="" aria-label="Move layer 1 up"');
    expect(single).toContain('disabled="" aria-label="Move layer 1 down"');
    expect(single).toContain('disabled="" aria-label="Remove layer 1"');
    expect(single).toContain(">Move up</button>");
    expect(single).toContain(">Move down</button>");
    expect(single).not.toContain(">↑</button>");
    const full = renderToStaticMarkup(
      createElement(LayerActions, {
        selected: 7,
        count: 8,
        disabled: false,
        onChange: () => {},
      }),
    );
    expect(full).toContain('disabled="" aria-label="Duplicate layer 8"');
    expect(full).toContain('disabled="" aria-label="Move layer 8 down"');
  });
});
