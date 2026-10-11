import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultProject } from "./model";
import type { Material, Project, Project1D } from "./model";
import { reviewInputChanges } from "./reviewChanges";
import { ReviewPanel } from "./WorkflowPanels";
import { summarizeMaterial } from "./workflow";

function stack(): Project1D {
  return {
    ...structuredClone(defaultProject),
    schema_version: "1.1",
    layers: [
      { ...structuredClone(defaultProject.layers[0]), name: "Top grating" },
      {
        name: "Spacer",
        geometry: "homogeneous",
        thickness_nm: 95,
        material: { ...structuredClone(defaultProject.substrate), n: 1.45 },
      },
      { ...structuredClone(defaultProject.layers[0]), name: "Bottom grating" },
    ],
  };
}
function table(): Material {
  return {
    name: "Measured film",
    kind: "tabulated",
    n: 2,
    k: 0,
    wavelengths_nm: [200, 500, 800, 2500],
    n_values: [2, 2.1, 2.2, 2.3],
    k_values: [0, 0.01, 0.02, 0.03],
    source: "Local optical data",
  };
}
function render(base: Project, candidate: Project, blockedReason = "") {
  return renderToStaticMarkup(
    createElement(ReviewPanel, {
      title: "Review stack changes",
      baseProject: base,
      candidateProject: candidate,
      note: "Review before applying.",
      warnings: [],
      blockedReason,
      onApply: () => {},
      onClose: () => {},
    }),
  );
}

describe("readable proposal changes", () => {
  it("uses one-based names and units for every indexed dimension, including legacy inputs", () => {
    const base = stack(),
      next = structuredClone(base);
    next.period_nm = 420;
    next.layers[1].thickness_nm = 123;
    if (next.layers[2].geometry !== "rectangle_1d") throw Error("fixture");
    next.layers[2].cd_nm = 215;
    expect(reviewInputChanges(base, next)).toEqual([
      { key: "period_nm", label: "Pitch", before: "400 nm", after: "420 nm" },
      {
        key: "layers[1].thickness_nm",
        label: "Layer 2 · Spacer · Thickness",
        before: "95 nm",
        after: "123 nm",
      },
      {
        key: "layers[2].cd_nm",
        label: "Layer 3 · Bottom grating · Width (CD)",
        before: "180 nm",
        after: "215 nm",
      },
    ]);
    const legacy = structuredClone(defaultProject);
    legacy.layers[0].cd_nm = 220;
    legacy.layers[0].thickness_nm = 140;
    expect(
      reviewInputChanges(defaultProject, legacy).map((change) => change.label),
    ).toEqual(["Height", "Width"]);
  });
  it("shows only exact changed material scalars, names and source", () => {
    const base = stack(),
      next = structuredClone(base);
    Object.assign(next.layers[1].material, {
      n: 1.7,
      k: 0.02,
      name: "New film",
      source: "New source",
    });
    const changes = reviewInputChanges(base, next);
    expect(
      changes.map(({ label, before, after }) => ({ label, before, after })),
    ).toEqual([
      {
        label: "Layer 2 · Spacer · Material name",
        before: "Synthetic substrate",
        after: "New film",
      },
      {
        label: "Layer 2 · Spacer · Refractive index n",
        before: "1.45",
        after: "1.7",
      },
      {
        label: "Layer 2 · Spacer · Extinction coefficient k",
        before: "0",
        after: "0.02",
      },
      {
        label: "Layer 2 · Spacer · Source",
        before: "User-defined synthetic optical constants",
        after: "New source",
      },
    ]);
    expect(changes.some(({ label }) => label.includes("Optical model"))).toBe(
      false,
    );
  });
  it("distinguishes groove, ambient and substrate edits", () => {
    const base = stack(),
      next = structuredClone(base);
    if (next.layers[2].geometry !== "rectangle_1d") throw Error("fixture");
    next.layers[2].background.n = 1.1;
    next.ambient.name = "Vacuum";
    next.substrate.k = 0.1;
    expect(reviewInputChanges(base, next).map(({ label }) => label)).toEqual([
      "Layer 3 · Bottom grating · Groove · Refractive index n",
      "Ambient · Material name",
      "Substrate · Extinction coefficient k",
    ]);
  });
  it("keeps row-only n/k edits visible with exact range, row count and full fingerprints", () => {
    const base = stack();
    base.layers[1].material = table();
    const next = structuredClone(base);
    next.layers[1].material.n_values![1] = 2.125;
    next.layers[1].material.k_values![2] = 0.025;
    const changes = reviewInputChanges(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0].label).toBe("Layer 2 · Spacer · Optical table");
    expect(changes[0].detail).toBe(
      "2 rows changed (n, k). Exact samples are in Full inputs.",
    );
    expect(changes[0].before).toBe(
      `4 rows · 200–2500 nm · ${summarizeMaterial(base.layers[1].material).table!.checksum}`,
    );
    expect(changes[0].after).toBe(
      `4 rows · 200–2500 nm · ${summarizeMaterial(next.layers[1].material).table!.checksum}`,
    );
    expect(changes[0].before).not.toBe(changes[0].after);
    expect(changes[0].after).not.toContain("[");
  });
  it("displays model transitions, scalar placeholders and table row/range changes", () => {
    const base = stack(),
      next = structuredClone(base);
    next.layers[1].material = table();
    const added = reviewInputChanges(base, next);
    expect(added).toContainEqual(
      expect.objectContaining({
        label: "Layer 2 · Spacer · Optical model",
        before: "Constant n/k",
        after: "Tabulated n/k",
      }),
    );
    expect(added).toContainEqual(
      expect.objectContaining({
        label: "Layer 2 · Spacer · Scalar n (table placeholder)",
        after: "2",
      }),
    );
    expect(added).toContainEqual(
      expect.objectContaining({
        label: "Layer 2 · Spacer · Optical table",
        before: "No table",
        detail:
          "4 rows changed (wavelength, n, k). Exact samples are in Full inputs.",
      }),
    );
    const larger = structuredClone(next);
    larger.layers[1].material.wavelengths_nm!.push(2600);
    larger.layers[1].material.n_values!.push(2.4);
    larger.layers[1].material.k_values!.push(0.04);
    const changed = reviewInputChanges(next, larger);
    expect(changed[0].after).toContain("5 rows · 200–2600 nm");
    expect(changed[0].detail).toContain("1 row changed (wavelength, n, k)");
    const removed = reviewInputChanges(next, base);
    expect(removed.find(({ key }) => key.endsWith(".table"))!.after).toBe(
      "No table",
    );
  });
  it("preserves explicit versus omitted source and unused table fields", () => {
    const base = stack(),
      next = structuredClone(base);
    delete next.layers[1].material.source;
    delete next.layers[1].material.wavelengths_nm;
    delete next.layers[1].material.n_values;
    delete next.layers[1].material.k_values;
    const changes = reviewInputChanges(base, next);
    expect(changes).toHaveLength(4);
    expect(changes[0].label).toBe("Layer 2 · Spacer · Source");
    expect(
      changes
        .slice(1)
        .every(({ before, after }) => before === "None" && after === "Not set"),
    ).toBe(true);
  });
  it("recognizes exact middle insertions/removals and pure order changes without conflating duplicate names", () => {
    const base = stack(),
      added = structuredClone(base);
    added.layers.splice(1, 0, {
      name: "Inserted film",
      geometry: "homogeneous",
      thickness_nm: 30,
      material: table(),
    });
    const additions = reviewInputChanges(base, added);
    expect(additions[0].label).toBe("Layer order (top to bottom)");
    expect(additions[0].after).toBe(
      "1. Top grating · 2. Inserted film · 3. Spacer · 4. Bottom grating",
    );
    expect(additions[1]).toEqual({
      key: "layers[1]",
      label: "Layer 2 · Inserted film",
      before: "Not present",
      after: "Added uniform film",
    });
    expect(
      additions.slice(1).every(({ key }) => key.startsWith("layers[1]")),
    ).toBe(true);
    const removals = reviewInputChanges(added, base);
    expect(removals[1]).toEqual({
      key: "layers[1]",
      label: "Layer 2 · Inserted film",
      before: "Uniform film",
      after: "Removed",
    });
    const reordered = structuredClone(base);
    reordered.layers.reverse();
    expect(reviewInputChanges(base, reordered)).toEqual([
      {
        key: "layers.order",
        label: "Layer order (top to bottom)",
        before: "1. Top grating · 2. Spacer · 3. Bottom grating",
        after: "1. Bottom grating · 2. Spacer · 3. Top grating",
        detail: "Current positions in proposed order: 3 → 2 → 1.",
      },
    ]);
    base.layers[2].name = base.layers[0].name;
    base.layers[2].thickness_nm = 81;
    const sameNames = structuredClone(base);
    sameNames.layers.reverse();
    const order = reviewInputChanges(base, sameNames);
    expect(order).toHaveLength(1);
    expect(order[0].before).toBe(order[0].after);
    expect(order[0].detail).toBe(
      "Current positions in proposed order: 3 → 2 → 1.",
    );
    const duplicate = structuredClone(base);
    duplicate.layers.push(structuredClone(base.layers[0]));
    expect(reviewInputChanges(base, duplicate)).toContainEqual(
      expect.objectContaining({
        key: "layers[3]",
        after: "Added patterned grating",
      }),
    );
  });
  it("keeps type, names, dimensions and optical edits when layers are replaced", () => {
    const base = stack(),
      next = structuredClone(base);
    next.layers[1] = {
      ...structuredClone(defaultProject.layers[0]),
      name: "Replacement",
      thickness_nm: 120,
    };
    const changes = reviewInputChanges(base, next);
    expect(changes).toContainEqual(
      expect.objectContaining({
        label: "Layer 2 · Name",
        before: "Spacer",
        after: "Replacement",
      }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        label: "Layer 2 · Replacement · Type",
        before: "Uniform film",
        after: "Patterned grating",
      }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        label: "Layer 2 · Replacement · Thickness",
        before: "95 nm",
        after: "120 nm",
      }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        label: "Layer 2 · Replacement · Width (CD)",
        before: "Not set",
        after: "180 nm",
      }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        label: "Layer 2 · Replacement · Groove · Refractive index n",
        after: "1",
      }),
    );
  });
  it("keeps dense tables bounded and detects interior wavelength sampling changes", () => {
    const base = stack();
    base.layers[1].material = table();
    const next = structuredClone(base);
    Object.assign(next.layers[1].material, {
      wavelengths_nm: Array.from({ length: 2000 }, (_, i) => 200 + i),
      n_values: Array(2000).fill(2.1),
      k_values: Array(2000).fill(0.01),
    });
    next.illumination.wavelengths_nm[1] += 1;
    const changes = reviewInputChanges(base, next);
    expect(changes).toHaveLength(2);
    expect(JSON.stringify(changes).length).toBeLessThan(1000);
    expect(changes[0].after).toContain("2000 rows · 200–2199 nm");
    expect(changes[1].label).toBe("Wavelength sampling");
    expect(changes[1].detail).toBe(
      "1 sample changed. Exact wavelengths are in Full inputs.",
    );
    expect(changes[1].before).toBe(changes[1].after);
  });
  it("removes repetitive card prose but retains accessible stack summaries, exact full inputs and apply guard", () => {
    const base = stack(),
      next = structuredClone(base);
    next.layers[1].thickness_nm = 123;
    next.layers[1].material.n = 1.7;
    const original = JSON.stringify([base, next]);
    const html = render(base, next, "Project changed since review.");
    const review = html
      .split('aria-label="Input changes">')[1]
      .split("<details")[0];
    expect(review).toContain("Layer 2 · Spacer · Refractive index n");
    expect(review).not.toContain("layers[");
    expect(review).not.toContain("&quot;");
    expect(html).not.toContain("stack-preview-summary");
    expect(html).toContain('aria-label="Current:');
    expect(html).toContain('aria-label="Proposed:');
    const escape = (value: string) =>
      value
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#x27;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    expect(html).toContain(
      `<pre>${escape(JSON.stringify(base, null, 2))}</pre>`,
    );
    expect(html).toContain(
      `<pre>${escape(JSON.stringify(next, null, 2))}</pre>`,
    );
    expect(html).toContain('class="dialog-close" disabled=""');
    expect(JSON.stringify([base, next])).toBe(original);
    expect(reviewInputChanges(base, structuredClone(base))).toEqual([]);
  });
});
