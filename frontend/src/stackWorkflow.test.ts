import { describe, expect, it } from "vitest";
import proposals from "./fixtures/stack-proposals.json";
import reference from "../public/reference-example.json";
import {
  defaultProject,
  editStack,
  isForwardResult,
  maximumPatternedCD,
  parseProjectFile,
  stackSummary,
  supportsSyntheticFit,
  totalThickness,
  validLayerIndex,
  validateProject,
} from "./model";
import type { Layer, Material, Project } from "./model";
import {
  applyGeometryChanges,
  applyStackChanges,
  createHistory,
  comparisonConditionsDiffer,
  localPreflight,
  normalizeProject,
  parseChangeProposal,
  parseStackChanges,
  proposalApplyError,
  stackDiff,
  summarizeMaterial,
  workspaceReducer,
  STACK_PROPOSAL_MAX_BYTES,
} from "./workflow";

function stack(): Project {
  return {
    ...structuredClone(defaultProject),
    schema_version: "1.1",
    layers: [
      { ...structuredClone(defaultProject.layers[0]), name: "Top" },
      {
        name: "Spacer",
        geometry: "homogeneous",
        thickness_nm: 80,
        material: structuredClone(defaultProject.substrate),
      },
      {
        ...structuredClone(defaultProject.layers[0]),
        name: "Bottom",
        cd_nm: 300,
        thickness_nm: 60,
      },
    ],
  };
}
function table(): Material {
  return {
    name: "table",
    kind: "tabulated",
    n: 2,
    k: 0,
    wavelengths_nm: [200, 2500],
    n_values: [2, 2.1],
    k_values: [0, 0.01],
  };
}
function proposal(index = 1) {
  return structuredClone(proposals[index]);
}

describe("versioned stack project boundary", () => {
  it("preserves the legacy default and fixture project shape without migration", () => {
    expect(defaultProject).toEqual(reference.project);
    expect(
      parseProjectFile(JSON.stringify(reference)).project.schema_version,
    ).toBe("1.0");
    expect(normalizeProject(defaultProject)).toEqual(defaultProject);
    expect(JSON.stringify(defaultProject)).not.toContain("homogeneous");
    expect(isForwardResult(reference.result)).toBe(true);
    expect(
      isForwardResult({
        ...reference.result,
        schema_version: "1.1",
        metadata: {
          ...reference.result.metadata,
          adapter_version: "1.1.0",
          layer_count: 1,
          active_slab_count: 1,
          total_thickness_nm: 160,
          stack_order: "top_to_bottom",
        },
      }),
    ).toBe(true);
  });
  it("validates 1–8 ordered layers and the shared period against every patterned CD", () => {
    const value = stack();
    expect(validateProject(value)).toEqual([]);
    expect(maximumPatternedCD(value)).toBe(300);
    expect(totalThickness(value)).toBe(300);
    expect(stackSummary(value)).toContain("3. Bottom");
    value.period_nm = 299;
    expect(validateProject(value).join(" ")).toContain("Layer 3: CD");
    value.period_nm = 400;
    for (const size of [0, 9]) {
      value.layers = Array.from({ length: size }, () =>
        structuredClone(defaultProject.layers[0]),
      );
      expect(validateProject(value).join(" ")).toContain("1–8");
    }
  });
  it("does not allow schema1.0 topology expansion or homogeneous CD/background/IDs", () => {
    expect(
      validateProject({ ...stack(), schema_version: "1.0" }).join(" "),
    ).toContain("exactly one");
    for (const extra of [
      { cd_nm: 0 },
      { background: defaultProject.ambient },
      { id: "persisted" },
    ]) {
      const value = stack();
      Object.assign(value.layers[1], extra);
      expect(validateProject(value).length).toBeGreaterThan(0);
    }
  });
  it("normalizes optional material defaults without inventing a uniform background or rewriting inputs", () => {
    const value = stack();
    delete value.layers[1].material.source;
    const normalized = normalizeProject(value);
    expect(normalized.layers[1]).not.toHaveProperty("background");
    expect(normalized.layers[1]).not.toHaveProperty("cd_nm");
    expect(value.layers[1].material.source).toBeUndefined();
    expect(normalized.schema_version).toBe("1.1");
  });
  it("checks lower-layer tables, optical bounds, zero thickness, and no extrapolation", () => {
    const value = stack();
    value.layers[2].material = table();
    expect(validateProject(value)).toEqual([]);
    value.layers[2].material.wavelengths_nm = [500, 700];
    expect(validateProject(value).join(" ")).toContain("Layer 3 material");
    expect(localPreflight(value)[0].location).toEqual([
      "layers",
      2,
      "material",
      "wavelengths_nm",
    ]);
    value.layers[2].material = structuredClone(
      defaultProject.layers[0].material,
    );
    const bottom = value.layers[2];
    if (bottom.geometry !== "rectangle_1d") throw new Error("fixture");
    bottom.background = table();
    bottom.background.wavelengths_nm = [500, 700];
    expect(localPreflight(value)[0].location).toEqual([
      "layers",
      2,
      "background",
      "wavelengths_nm",
    ]);
    bottom.background = structuredClone(defaultProject.ambient);
    value.layers.forEach((layer) => (layer.thickness_nm = 0));
    expect(validateProject(value)).toEqual([]);
    value.layers[2].thickness_nm = 2000.1;
    expect(validateProject(value).join(" ")).toContain("Layer 3: thickness");
  });
  it("guards synthetic fit by topology, independent of selected layer or version", () => {
    expect(supportsSyntheticFit(defaultProject)).toBe(true);
    expect(
      supportsSyntheticFit({ ...defaultProject, schema_version: "1.1" }),
    ).toBe(true);
    expect(supportsSyntheticFit(stack())).toBe(false);
    expect(
      supportsSyntheticFit({ ...stack(), layers: [stack().layers[1]] }),
    ).toBe(false);
  });
});

describe("whole-stack comparison conditions", () => {
  it("detects lower-layer optical and geometry-kind differences", () => {
    const base = stack(),
      next = structuredClone(base);
    expect(comparisonConditionsDiffer(base, next)).toBe(false);
    next.layers[2].material.n += 0.01;
    expect(comparisonConditionsDiffer(base, next)).toBe(true);
    next.layers[2] = structuredClone(base.layers[2]);
    next.layers[1] = {
      ...structuredClone(defaultProject.layers[0]),
      thickness_nm: 80,
    };
    expect(comparisonConditionsDiffer(base, next)).toBe(true);
    expect(
      comparisonConditionsDiffer(base, {
        ...base,
        layers: base.layers.slice(0, 2),
      }),
    ).toBe(true);
  });
});

describe("bounded explicit stack operations and history", () => {
  it("promotes only explicit structural changes and creates independent duplicates", () => {
    const added = editStack(defaultProject, 0, {
      type: "add",
      geometry: "homogeneous",
    });
    expect(added.project.schema_version).toBe("1.1");
    expect(defaultProject.schema_version).toBe("1.0");
    expect(added.selectedLayer).toBe(1);
    expect(added.project.layers[1]).not.toHaveProperty("background");
    const copied = editStack(added.project, 1, { type: "duplicate" });
    copied.project.layers[2].material.n = 3;
    expect(copied.project.layers[1].material.n).toBe(2.1);
    expect(added.project.layers).toHaveLength(2);
    expect(
      editStack(defaultProject, 0, { type: "move", direction: -1 }).project,
    ).toBe(defaultProject);
  });
  it("converts types without lingering geometry fields", () => {
    const uniform = editStack(defaultProject, 0, {
      type: "geometry",
      geometry: "homogeneous",
    }).project;
    expect(Object.keys(uniform.layers[0]).sort()).toEqual([
      "geometry",
      "material",
      "name",
      "thickness_nm",
    ]);
    const patterned = editStack(uniform, 0, {
      type: "geometry",
      geometry: "rectangle_1d",
    }).project;
    expect(validateProject(patterned)).toEqual([]);
    expect(patterned.schema_version).toBe("1.1");
  });
  it("enforces layer bounds and keeps selection valid after deletion and reorder", () => {
    let current: Project = structuredClone(defaultProject);
    for (let i = 1; i < 8; i++)
      current = editStack(current, i - 1, { type: "duplicate" }).project;
    expect(() =>
      editStack(current, 7, { type: "add", geometry: "rectangle_1d" }),
    ).toThrow("eight");
    expect(() => editStack(defaultProject, 0, { type: "remove" })).toThrow(
      "at least one",
    );
    const moved = editStack(stack(), 2, { type: "move", direction: -1 });
    expect(moved.project.layers.map((layer) => layer.name)).toEqual([
      "Top",
      "Bottom",
      "Spacer",
    ]);
    expect(moved.selectedLayer).toBe(1);
    expect(editStack(stack(), 2, { type: "remove" }).selectedLayer).toBe(1);
    for (const index of [-1, NaN, Infinity, 99])
      expect(validLayerIndex(stack(), index)).toBeGreaterThanOrEqual(0);
  });
  it("treats each list operation as one edit and restores selection through undo/redo/import", () => {
    let state = createHistory({
      project: stack(),
      displayedRun: null,
      selectedLayer: 2,
    });
    const initial = state.present;
    const moved = editStack(state.present.project, 2, {
      type: "move",
      direction: -1,
    });
    state = workspaceReducer(state, { type: "replace-project", ...moved });
    expect(state.past).toHaveLength(1);
    expect(state.present.selectedLayer).toBe(1);
    state = workspaceReducer(state, { type: "undo" });
    expect(state.present).toEqual(initial);
    state = workspaceReducer(state, { type: "redo" });
    expect(state.present.selectedLayer).toBe(1);
    state = workspaceReducer(state, {
      type: "replace-project",
      project: defaultProject,
    });
    expect(state.present.selectedLayer).toBe(0);
    const revision = state.revision;
    state = workspaceReducer(state, { type: "select-layer", index: 99 });
    expect(state.revision).toBe(revision);
    expect(state.present.selectedLayer).toBe(0);
  });
});

describe("backend/browser stack proposal parity and trust boundary", () => {
  it.each(proposals.map((value, index) => ({ value, index })))(
    "reconstructs backend proposal $index exactly including table fingerprints",
    ({ value }) => {
      const parsed = parseChangeProposal(JSON.stringify(value));
      expect(parsed).toEqual(value);
      expect(Object.isFrozen(parsed.candidate_project.layers[0])).toBe(true);
      expect(parsed.diff.length).toBeLessThanOrEqual(64);
    },
  );
  it("supports atomic period and full layer replacement, including invalid-period repair", () => {
    const value = stack();
    const layers = value.layers.map((layer): Layer =>
      layer.geometry === "rectangle_1d" ? { ...layer, cd_nm: 100 } : layer,
    );
    expect(applyStackChanges(value, { period_nm: 100, layers }).period_nm).toBe(
      100,
    );
    expect(() => applyStackChanges(value, { period_nm: 100 })).toThrow(
      "Layer 1: CD",
    );
    expect(() => applyGeometryChanges(value, { cd_nm: 100 })).toThrow("Legacy");
  });
  it.each([
    {},
    null,
    [],
    { layers: [] },
    { layers: Array(9).fill(defaultProject.layers[0]) },
    { period_nm: null },
    { period_nm: "400" },
    { layers: [...stack().layers], ambient: defaultProject.ambient },
  ])("rejects malformed or out-of-scope patch %s", (patch) => {
    expect(() => parseStackChanges(patch)).toThrow();
  });
  it("rejects nested layer IDs, uniform leftovers and off-patch candidate changes", () => {
    for (const mutate of [
      (value: ReturnType<typeof proposal>) => {
        value.candidate_project.ambient.n = 1.1;
      },
      (value: ReturnType<typeof proposal>) => {
        Object.assign(value.candidate_project.layers[0], { id: "fake" });
      },
      (value: ReturnType<typeof proposal>) => {
        Object.assign(value.changes.layers![1], {
          background: defaultProject.ambient,
        });
      },
      (value: ReturnType<typeof proposal>) => {
        value.diff = [];
      },
      (value: ReturnType<typeof proposal>) => {
        value.diff.reverse();
      },
      (value: ReturnType<typeof proposal>) => {
        Object.assign(value, { provenance: { source: "server_computed" } });
      },
    ]) {
      const value = proposal();
      mutate(value);
      expect(() => parseChangeProposal(JSON.stringify(value))).toThrow();
    }
  });
  it("does not trust imported validity, diagnostics, hashes or origin claims", () => {
    const value = proposal(0);
    value.valid = false;
    value.diagnostics = [];
    value.base_input_hash = "f".repeat(64);
    const parsed = parseChangeProposal(JSON.stringify(value));
    expect(parsed.valid).toBe(true);
    expect(parsed).not.toHaveProperty("origin");
    expect(proposalApplyError(parsed, parsed.base_project, 2, 3)).toContain(
      "changed",
    );
    expect(proposalApplyError(parsed, stack(), 2, 2)).toContain("changed");
  });
  it("summarizes a material table atomically and detects internal row-only edits", () => {
    const value = stack();
    value.layers[2].material = table();
    const next = structuredClone(value);
    next.layers[2].material.n_values![1] += 0.1;
    const diff = stackDiff(normalizeProject(value), normalizeProject(next));
    expect(diff).toHaveLength(1);
    expect(diff[0].kind).toBe("material");
    expect(JSON.stringify(diff).length).toBeLessThan(1000);
    expect(
      summarizeMaterial(value.layers[2].material).table?.checksum,
    ).not.toBe(summarizeMaterial(next.layers[2].material).table?.checksum);
  });
  it("accepts new format over 2 MB, enforces 8 MB UTF-8 limit, and applies a proposal as one edit", () => {
    const text = JSON.stringify(proposal());
    expect(
      parseChangeProposal(text + " ".repeat(2_000_001)).schema_version,
    ).toBe("rcwa-change-proposal/1.1");
    expect(() =>
      parseChangeProposal(text + " ".repeat(STACK_PROPOSAL_MAX_BYTES)),
    ).toThrow("8 MB");
    const value = parseChangeProposal(text);
    let state = createHistory({
      project: value.base_project,
      displayedRun: null,
      selectedLayer: 0,
    });
    expect(
      proposalApplyError(
        value,
        state.present.project,
        state.revision,
        state.revision,
      ),
    ).toBeNull();
    state = workspaceReducer(state, {
      type: "replace-project",
      project: value.candidate_project,
    });
    expect(state.past).toHaveLength(1);
    state = workspaceReducer(state, { type: "undo" });
    expect(state.present.project).toEqual(value.base_project);
  });
});
