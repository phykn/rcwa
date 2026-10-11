import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import input from "./fixtures/default-project-2d.json";
import reference from "../public/reference-2d.json";
import { LayerStack } from "./LayerStack";
import { SyntheticFit } from "./SyntheticFit";
import { ComparisonPanel, ReviewPanel } from "./WorkflowPanels";
import { defaultProject } from "./model";
import type { Project, Project2D, SavedProject } from "./model";
import type { PublicForwardResult2D } from "./result2d";
import { stringify2DEnvelope } from "./project2d";
import { reviewInputChanges } from "./reviewChanges";

const project2D = (): Project2D => structuredClone(input) as Project2D;
const result2D = (): PublicForwardResult2D =>
  structuredClone(reference.result) as PublicForwardResult2D;
function picker(project: Project, selected = 0, disabled = false) {
  return renderToStaticMarkup(
    createElement(LayerStack, {
      project,
      selected,
      disabled,
      onSelect: () => {},
      onChange: () => {},
    }),
  );
}
function fit(project: Project, staticPreview = false) {
  return renderToStaticMarkup(
    createElement(SyntheticFit, {
      project,
      staticPreview,
      locked: false,
      onBusyChange: () => {},
      onApply: () => {},
    }),
  );
}
function review(baseProject: Project, candidateProject: Project) {
  return renderToStaticMarkup(
    createElement(ReviewPanel, {
      title: "Review saved candidate",
      baseProject,
      candidateProject,
      note: "Inspect the saved inputs.",
      warnings: [],
      blockedReason: "",
      onApply: () => {},
      onClose: () => {},
    }),
  );
}
function saved(id = "candidate-2d"): SavedProject {
  return {
    id,
    name: id,
    created_at: "2026-10-11",
    updated_at: "2026-10-11",
    project: project2D(),
    result: result2D(),
  };
}
function compare(candidates: SavedProject[]) {
  return renderToStaticMarkup(
    createElement(ComparisonPanel, {
      candidates,
      onUse: () => {},
      onClose: () => {},
    }),
  );
}

describe("schema 1.2 secondary layer and fit controls", () => {
  it("shortens only canonical example layer names and retains exact accessible names", () => {
    const project = project2D();
    const before = stringify2DEnvelope(project);
    const html = picker(project, 2);
    expect(html.match(/class="stack-name">Pattern</g)).toHaveLength(2);
    expect(html).toContain('class="stack-name">Film</span>');
    for (const [index, layer] of project.layers.entries())
      expect(html).toContain(
        `aria-label="Select layer ${index + 1}: ${layer.name}"`,
      );
    expect(html).toContain(
      `aria-label="Select layer 3: ${project.layers[2].name}" aria-pressed="true"`,
    );
    expect(html).toContain("Rectangles repeating in X and Y");
    expect(html).not.toContain("Repeating ridges and gaps");
    expect(stringify2DEnvelope(project)).toBe(before);

    project.layers[2] = {
      ...structuredClone(defaultProject.layers[0]),
      name: project.layers[2].name,
      cd_nm: 90,
    };
    expect(picker(project, 2)).toContain('class="stack-name">Ridge</span>');
    project.layers[2].name = "My deliberately long imported bottom layer name";
    expect(picker(project, 2)).toContain(
      `class="stack-name">${project.layers[2].name}</span>`,
    );
    const legacy = structuredClone(defaultProject);
    legacy.layers[0].name = input.layers[0].name;
    expect(picker(legacy)).toContain(
      `class="stack-name">${legacy.layers[0].name}</span>`,
    );
  });

  it("retains all eight chips, bounds, selection and disabled state for mixed stacks", () => {
    const project = project2D();
    project.layers = Array.from({ length: 8 }, (_, i) =>
      structuredClone(project.layers[i % 3]),
    );
    const html = picker(project, 7, true);
    expect(html.match(/data-layer-index=/g)).toHaveLength(8);
    expect(html).toContain(
      `aria-label="Select layer 8: ${project.layers[7].name}" aria-pressed="true"`,
    );
    expect(html).toContain(
      'aria-describedby="layer-limit-reason" aria-disabled="true"',
    );
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain('disabled="" aria-label="Add patterned layer"');
    expect(html).toContain('disabled="" aria-label="Add uniform layer"');
  });

  it("hides every fit action and field for 1.2, including a lone 1D ridge", () => {
    const project = project2D();
    const variants = [
      project,
      {
        ...project,
        layers: [{ ...structuredClone(defaultProject.layers[0]), cd_nm: 90 }],
      },
    ];
    for (const value of variants)
      for (const staticPreview of [false, true]) {
        const html = fit(value, staticPreview);
        expect(html).toContain("not supported for schema 1.2 projects");
        expect(html).not.toContain("<input");
        expect(html).not.toContain("<button");
        expect(html).not.toContain("Run synthetic recovery");
        expect(html).not.toMatch(/<details[^>]*\bopen=/);
      }
    const legacy = fit(defaultProject);
    expect(legacy).toContain('aria-label="Synthetic target CD"');
    expect(legacy).toContain("Run synthetic recovery");
    expect(legacy).not.toContain("not supported for schema 1.2");
  });
});

describe("schema 1.2 human input review", () => {
  it("describes both pitches, widths, azimuth and Fourier axes independently", () => {
    const base = project2D(),
      next = project2D();
    next.period_nm = 180;
    next.period_y_nm = 160;
    if (next.layers[2].geometry !== "rectangle_2d") throw Error("fixture");
    next.layers[2].cd_x_nm = 100;
    next.layers[2].cd_y_nm = 90;
    next.illumination.azimuth_deg = 35;
    next.solver = { harmonics_x: 4, harmonics_y: 3 };
    const changes = reviewInputChanges(base, next);
    expect(changes.map(({ label }) => label)).toEqual([
      "Pitch X",
      "Pitch Y",
      `Layer 3 · ${next.layers[2].name} · Width X (CD)`,
      `Layer 3 · ${next.layers[2].name} · Width Y (CD)`,
      "Azimuth angle",
      "Fourier order Hx",
      "Fourier order Hy",
    ]);
    expect(changes.map(({ after }) => after)).toEqual([
      "180 nm",
      "160 nm",
      "100 nm",
      "90 nm",
      "35°",
      "4",
      "3",
    ]);
    expect(reviewInputChanges(base, project2D())).toEqual([]);
    expect(reviewInputChanges(defaultProject, base)).toContainEqual({
      key: "schema_version",
      label: "Project format",
      before: "1.0",
      after: "1.2",
    });
  });

  it("keeps signed-zero-only changes and complete exact input text visible", () => {
    const base = project2D(),
      next = project2D();
    base.illumination.azimuth_deg = 0;
    next.illumination.azimuth_deg = -0;
    next.layers[0].material.k = -0;
    const changes = reviewInputChanges(base, next);
    expect(changes).toContainEqual({
      key: "illumination.azimuth_deg",
      label: "Azimuth angle",
      before: "0°",
      after: "-0°",
    });
    expect(changes).toContainEqual(
      expect.objectContaining({
        key: "layers[0].material.k",
        before: "0",
        after: "-0",
      }),
    );
    const html = review(base, next);
    expect(html).toContain("&quot;azimuth_deg&quot;:-0.0");
    expect(html).toContain("&quot;k&quot;:-0.0");
    expect(html).toContain("Cancel");
    expect(html).toContain("Apply changes");
    expect(html).toContain('aria-label="Review saved candidate"');
  });

  it("describes mixed ridge and film changes without inventing a Y width", () => {
    const base = project2D();
    base.layers[0] = {
      ...structuredClone(defaultProject.layers[0]),
      name: "Invariant-Y ridge",
      cd_nm: 70,
    };
    const next = structuredClone(base);
    if (next.layers[0].geometry !== "rectangle_1d") throw Error("fixture");
    next.layers[0].cd_nm = 75;
    next.layers[1].thickness_nm = 185;
    expect(reviewInputChanges(base, next)).toEqual([
      {
        key: "layers[0].cd_nm",
        label: "Layer 1 · Invariant-Y ridge · Width X (CD)",
        before: "70 nm",
        after: "75 nm",
      },
      {
        key: "layers[1].thickness_nm",
        label: `Layer 2 · ${base.layers[1].name} · Thickness`,
        before: "180 nm",
        after: "185 nm",
      },
    ]);
    const removed = structuredClone(base);
    removed.layers.splice(2, 1);
    expect(reviewInputChanges(base, removed)).toContainEqual(
      expect.objectContaining({
        key: "layers[2]",
        before: "2D rectangular pattern",
        after: "Removed",
      }),
    );
  });

  it("labels honest center cross-sections and removes zero-Y inclusions", () => {
    const base = project2D(),
      next = project2D();
    if (next.layers[0].geometry !== "rectangle_2d") throw Error("fixture");
    next.layers[0].cd_y_nm = 0;
    const html = review(base, next);
    expect(html).toContain(
      "X–Z section through the cell center. Y extent is not shown.",
    );
    expect(html).toContain(
      "X–Z cross-section through the cell center; Y extent is not shown",
    );
    expect(html).toContain("<dt>Pitch Y</dt><dd>140 nm</dd>");
    const previews = [...html.matchAll(/<svg\b[^>]*>(.*?)<\/svg>/g)].map(
      (match) => match[1],
    );
    expect(previews).toHaveLength(2);
    expect((previews[0].match(/<rect /g) ?? []).length).toBe(
      (previews[1].match(/<rect /g) ?? []).length + 1,
    );
    expect(reviewInputChanges(base, next)).toContainEqual(
      expect.objectContaining({ key: "layers[0].cd_y_nm", after: "0 nm" }),
    );
  });
});

describe("schema 1.2 saved spectrum comparison", () => {
  it("retains full order arrays while labeling schema and both axes", () => {
    const candidate = saved();
    const before = stringify2DEnvelope(candidate);
    const html = compare([candidate]);
    expect(html).toContain("Schema 1.2 · Pitch X 150 nm · Pitch Y 140 nm");
    expect(html).toContain("Azimuth 25°");
    expect(html).toContain("Hx = 5 · Hy = 5");
    expect(html).toContain("Width X");
    expect(html).toContain("Width X 70 nm · Y 60 nm");
    expect(html).toContain('aria-describedby="comparison-sample-description"');
    expect(html).toContain(
      `${candidate.result!.wavelengths_nm[0]} nanometers. Total reflectance, s polarization. candidate-2d:`,
    );
    expect(html).toContain('aria-live="polite" aria-atomic="true"');
    if (candidate.result!.schema_version !== "1.2") throw Error("fixture");
    expect(candidate.result!.spectra.s!.orders).toHaveLength(21);
    expect(candidate.result!.spectra.s!.orders[0]).toHaveLength(121);
    expect(stringify2DEnvelope(candidate)).toBe(before);
  });

  it("warns about Y-only geometry differences", () => {
    const first = saved("first"),
      next = saved("next");
    if (
      next.project.schema_version !== "1.2" ||
      next.project.layers[2].geometry !== "rectangle_2d"
    )
      throw Error("fixture");
    next.project.layers[2].cd_y_nm += 1;
    const html = compare([first, next]);
    expect(html).toContain(
      "Schema, geometry, illumination, Fourier orders or optical materials differ.",
    );
    expect(html).toContain('aria-label="Compare exact wavelength sample"');
  });

  it("keeps exact nonuniform grids and blocks mismatched samples without interpolation", () => {
    const first = saved("first"),
      second = saved("second");
    for (const value of [first, second]) {
      const result = value.result!;
      if (result.schema_version !== "1.2") throw Error("fixture");
      result.wavelengths_nm = [431.25, 537.5, 809.75];
      for (const spectrum of Object.values(result.spectra)) {
        for (const key of [
          "R",
          "T",
          "R_specular",
          "T_specular",
          "A_balance",
        ] as const)
          spectrum[key] = spectrum[key].slice(0, 3);
        spectrum.orders = spectrum.orders.slice(0, 3);
      }
    }
    const exact = compare([first, second]);
    expect(exact).toContain('aria-valuetext="431.25 nanometers"');
    expect(exact).toContain("Wavelengths: 431.25, 537.5, 809.75 nm");
    expect(exact).not.toContain("Wavelength grids differ");
    second.result!.wavelengths_nm[1] += 0.001;
    const mismatch = compare([first, second]);
    expect(mismatch).toContain("Wavelength grids differ");
    expect(mismatch).toContain("no interpolation is applied");
    expect(mismatch).not.toContain(
      'aria-label="Compare exact wavelength sample"',
    );
    expect(mismatch).not.toContain('id="comparison-sample-description"');
  });
});
