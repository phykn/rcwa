import { describe, expect, it } from "vitest";
import reference from "../public/reference-example.json";
import geometryCases from "../../backend/tests/fixtures/geometry-preview-cases.json";
import { defaultProject, parseProjectFile } from "./model";
import type {
  ForwardResult,
  Project,
  LegacyProject,
  RectangleLayer,
} from "./model";
import {
  applyGeometryChanges,
  cloneProject,
  comparisonCompatibilityError,
  createHistory,
  createRunRecord,
  geometryDiff,
  HISTORY_LIMIT,
  localPreflight,
  normalizeProject,
  parseChangeProposal,
  parseGeometryChanges,
  proposalApplyError,
  PROPOSAL_MAX_BYTES,
  resultCompatibilityError,
  semanticEqual,
  workspaceReducer,
} from "./workflow";
import type {
  LegacyChangeProposal as ChangeProposal,
  GeometryChanges,
  RunRecord,
  Workspace,
} from "./workflow";

function project(width = rectangle(defaultProject).cd_nm): LegacyProject {
  const value = cloneProject(defaultProject);
  rectangle(value).cd_nm = width;
  return value;
}
function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return createRunRecord({
    inputProject: reference.project as Project,
    result: reference.result as unknown as ForwardResult,
    origin: "reference",
    ...overrides,
  });
}
function workspace(
  width = 180,
  displayedRun: RunRecord | null = null,
): Workspace {
  return { project: project(width), displayedRun };
}
function proposal(
  changes: GeometryChanges = { cd_nm: 140 },
  base = project(),
): ChangeProposal {
  const candidate = applyGeometryChanges(base, changes);
  const diagnostics = localPreflight(candidate);
  return {
    schema_version: "rcwa-change-proposal/1.0",
    base_project: base,
    candidate_project: candidate,
    changes,
    base_input_hash: "a".repeat(64),
    candidate_input_hash: "b".repeat(64),
    diff: geometryDiff(base, candidate),
    diagnostics,
    valid: !diagnostics.some((item) => item.severity === "error"),
  };
}
function parse(value: unknown) {
  const result = parseChangeProposal(JSON.stringify(value));
  if (result.schema_version !== "rcwa-change-proposal/1.0")
    throw new Error("Expected a legacy proposal fixture.");
  return result;
}
function rectangle(project: Project): RectangleLayer {
  const layer = project.layers[0];
  if (layer.geometry !== "rectangle_1d")
    throw new Error("Expected a rectangle fixture.");
  return layer;
}

describe("complete semantic equality", () => {
  it("ignores object key order recursively, but no input fields or array order", () => {
    expect(
      semanticEqual(
        { a: [{ b: 1, c: 2 }], d: 3 },
        { d: 3, a: [{ c: 2, b: 1 }] },
      ),
    ).toBe(true);
    expect(semanticEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(semanticEqual([1, 2], [2, 1])).toBe(false);
    expect(semanticEqual([], {})).toBe(false);
    expect(semanticEqual([], Array(1))).toBe(false);
    expect(semanticEqual(null, {})).toBe(false);
    const changed = project();
    changed.ambient.source = "Different source";
    expect(semanticEqual(changed, project())).toBe(false);
  });
  it("normalizes only optional material defaults explicitly", () => {
    const sparse = project();
    delete sparse.ambient.source;
    delete sparse.ambient.wavelengths_nm;
    delete sparse.ambient.n_values;
    delete sparse.ambient.k_values;
    expect(semanticEqual(sparse, project())).toBe(false);
    expect(
      semanticEqual(normalizeProject(sparse), normalizeProject(project())),
    ).toBe(true);
    expect(sparse.ambient).not.toHaveProperty("source");
  });
});

describe("immutable browser-session workspace history", () => {
  it("records input changes and restores the whole run pairing and origin", () => {
    const first = run({
      origin: "computed",
      sourceJobId: "job-1",
      inputHash: "a".repeat(64),
    });
    const second = run({
      origin: "server",
      sourceJobId: "job-2",
      snapshotId: "saved-2",
    });
    let state = createHistory(workspace(180, first));
    state = workspaceReducer(state, {
      type: "replace-workspace",
      workspace: workspace(150, second),
    });
    expect(state.past).toHaveLength(1);
    expect(state.present.displayedRun).toBe(second);
    state = workspaceReducer(state, { type: "undo" });
    expect(rectangle(state.present.project).cd_nm).toBe(180);
    expect(state.present.displayedRun).toBe(first);
    expect(state.present.displayedRun?.origin).toBe("computed");
    expect(state.present.displayedRun?.sourceJobId).toBe("job-1");
    state = workspaceReducer(state, { type: "redo" });
    expect(state.present.displayedRun).toBe(second);
    expect(state.present.displayedRun?.snapshotId).toBe("saved-2");
    expect(state.revision).toBe(3);
  });
  it("does not mutate callers, old frames, tables or spectrum arrays", () => {
    const supplied = workspace();
    let state = createHistory(supplied);
    supplied.project.ambient.n = 2;
    expect(state.present.project.ambient.n).toBe(1);
    const raw: RunRecord = {
      inputProject: cloneProject(reference.project as Project),
      result: structuredClone(reference.result) as unknown as ForwardResult,
      origin: "imported",
    };
    const record = createRunRecord(raw);
    const firstValue = record.result.spectra.s!.R[0];
    raw.result.spectra.s!.R[0] = 123;
    raw.inputProject.name = "Mutated source";
    expect(record.result.spectra.s!.R[0]).toBe(firstValue);
    expect(record.inputProject.name).not.toBe("Mutated source");
    expect(createRunRecord(raw).inputProject.name).toBe("Mutated source");
    expect(Object.isFrozen(record.result.spectra.s!.R)).toBe(true);
    state = workspaceReducer(state, { type: "set-displayed-run", run: record });
    const old = state;
    state = workspaceReducer(state, {
      type: "replace-project",
      project: project(160),
    });
    expect(rectangle(old.present.project).cd_nm).toBe(180);
    expect(state.present.displayedRun).toBe(record);
    expect(state.past[0].displayedRun).toBe(record);
    expect(state.present.displayedRun?.result).toBe(record.result);
    expect(Object.isFrozen(state.present.project.layers[0])).toBe(true);
    const mutable = cloneProject(state.present.project);
    rectangle(mutable).cd_nm = 190;
    expect(rectangle(state.present.project).cd_nm).toBe(160);
  });
  it("does not invent history or revisions for semantic no-ops", () => {
    const state = createHistory(workspace());
    const reordered = Object.fromEntries(
      Object.entries(project()).reverse(),
    ) as unknown as Project;
    expect(
      workspaceReducer(state, { type: "replace-project", project: reordered }),
    ).toBe(state);
    expect(
      workspaceReducer(state, { type: "set-displayed-run", run: null }),
    ).toBe(state);
    expect(workspaceReducer(state, { type: "undo" })).toBe(state);
    expect(workspaceReducer(state, { type: "redo" })).toBe(state);
    expect(workspaceReducer(state, { type: "reset" })).toBe(state);
  });
  it("updates a displayed run without creating an input edit", () => {
    let state = createHistory(workspace());
    const record = run();
    state = workspaceReducer(state, { type: "set-displayed-run", run: record });
    expect(state.past).toEqual([]);
    expect(state.revision).toBe(1);
    expect(
      workspaceReducer(state, { type: "set-displayed-run", run: record }),
    ).toBe(state);
    expect(workspaceReducer(state, { type: "undo" })).toBe(state);
  });
  it("bounds committed undo steps to 30 and truncates redo after a new edit", () => {
    let state = createHistory(workspace());
    for (let i = 1; i <= 35; i++)
      state = workspaceReducer(state, {
        type: "replace-project",
        project: project(180 + i),
      });
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    for (let i = 0; i < 30; i++)
      state = workspaceReducer(state, { type: "undo" });
    expect(rectangle(state.present.project).cd_nm).toBe(185);
    expect(state.future).toHaveLength(30);
    expect(workspaceReducer(state, { type: "undo" })).toBe(state);
    expect(
      workspaceReducer(state, {
        type: "replace-project",
        project: project(185),
      }),
    ).toBe(state);
    state = workspaceReducer(state, {
      type: "replace-project",
      project: project(100),
    });
    expect(state.future).toEqual([]);
    expect(state.revision).toBe(66);
  });
  it.each(["pointer drag", "focused numeric field", "held keyboard handle"])(
    "groups one %s using explicit boundaries",
    () => {
      let state = createHistory(workspace());
      state = workspaceReducer(state, { type: "begin-edit" });
      expect(workspaceReducer(state, { type: "begin-edit" })).toBe(state);
      for (const width of [181, 190, 200])
        state = workspaceReducer(state, {
          type: "replace-project",
          project: project(width),
        });
      expect(state.past).toHaveLength(0);
      expect(state.revision).toBe(3);
      state = workspaceReducer(state, { type: "end-edit" });
      expect(state.past).toHaveLength(1);
      expect(state.editTransaction).toBeUndefined();
      expect(workspaceReducer(state, { type: "end-edit" })).toBe(state);
      state = workspaceReducer(state, { type: "undo" });
      expect(rectangle(state.present.project).cd_nm).toBe(180);
    },
  );
  it("settles an interrupted edit at its last valid value exactly once", () => {
    let state = createHistory(workspace());
    state = workspaceReducer(state, { type: "begin-edit" });
    state = workspaceReducer(state, {
      type: "replace-project",
      project: project(190),
    });
    // Pointer cancel, lost capture, context loss or blur all dispatch end-edit.
    for (let i = 0; i < 3; i++)
      state = workspaceReducer(state, { type: "end-edit" });
    expect(state.past).toHaveLength(1);
    expect(rectangle(state.present.project).cd_nm).toBe(190);
    state = workspaceReducer(state, { type: "begin-edit" });
    state = workspaceReducer(state, {
      type: "replace-project",
      project: project(200),
    });
    state = workspaceReducer(state, { type: "undo" });
    expect(rectangle(state.present.project).cd_nm).toBe(190);
    expect(state.editTransaction).toBeUndefined();
  });
  it("retains monotonic revision but no history for a transaction returning to its base", () => {
    let state = createHistory(workspace());
    state = workspaceReducer(state, {
      type: "replace-project",
      project: project(160),
    });
    state = workspaceReducer(state, { type: "undo" });
    state = workspaceReducer(state, { type: "begin-edit" });
    state = workspaceReducer(state, {
      type: "replace-project",
      project: project(190),
    });
    state = workspaceReducer(state, {
      type: "replace-project",
      project: project(180),
    });
    state = workspaceReducer(state, { type: "end-edit" });
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(1);
    expect(state.revision).toBe(4);
    state = workspaceReducer(state, { type: "redo" });
    expect(rectangle(state.present.project).cd_nm).toBe(160);
  });
  it("does not create an edit for opening and closing a field, or a run update", () => {
    let state = createHistory(workspace());
    state = workspaceReducer(state, { type: "begin-edit" });
    state = workspaceReducer(state, { type: "set-displayed-run", run: run() });
    state = workspaceReducer(state, { type: "end-edit" });
    expect(state.past).toHaveLength(0);
    expect(state.revision).toBe(1);
  });
  it("resets to the initial complete workspace without resetting its revision", () => {
    const initialRun = run();
    let state = createHistory(workspace(180, initialRun));
    state = workspaceReducer(state, {
      type: "replace-project",
      project: project(190),
    });
    state = workspaceReducer(state, { type: "reset" });
    expect(state.present.displayedRun).toBe(initialRun);
    expect(rectangle(state.present.project).cd_nm).toBe(180);
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
    expect(state.revision).toBe(2);
    state = workspaceReducer(state, {
      type: "reset",
      workspace: workspace(200),
    });
    expect(state.revision).toBe(3);
    expect(rectangle(state.initial.project).cd_nm).toBe(200);
  });
});

describe("shared backend/browser atomic geometry cases", () => {
  it.each(geometryCases)("$name", (testCase) => {
    const changes = testCase.changes as GeometryChanges;
    if (testCase.accepted) {
      const base = project();
      const candidate = applyGeometryChanges(base, changes);
      expect(geometryDiff(base, candidate)).toEqual(testCase.diff);
      expect(base).toEqual(defaultProject);
    } else expect(() => applyGeometryChanges(project(), changes)).toThrow();
  });
  it.each([NaN, Infinity, -Infinity, true, "180", null, undefined, [], {}])(
    "rejects nonnumeric patch value %s",
    (value) => {
      expect(() => parseGeometryChanges({ cd_nm: value })).toThrow();
    },
  );
});

describe("strict untrusted change proposal import", () => {
  it("reconstructs and freezes the exact candidate and canonical diff locally", () => {
    const value = proposal({ thickness_nm: 0, cd_nm: 90, period_nm: 100 });
    const result = parse(value);
    expect(result.candidate_project).toEqual(value.candidate_project);
    expect(result.diff.map((entry) => entry.field)).toEqual([
      "period_nm",
      "cd_nm",
      "thickness_nm",
    ]);
    expect(Object.isFrozen(result.candidate_project.layers[0])).toBe(true);
  });
  it.each([
    "schema_version",
    "base_project",
    "candidate_project",
    "changes",
    "base_input_hash",
    "candidate_input_hash",
    "diff",
    "diagnostics",
    "valid",
  ])("requires envelope field %s", (field) => {
    const value = proposal() as unknown as Record<string, unknown>;
    delete value[field];
    expect(() => parse(value)).toThrow("missing field");
  });
  it.each(["result", "provenance", "origin", "format", "sourceJobId"])(
    "rejects an extra envelope %s, including provenance claims",
    (field) => {
      expect(() =>
        parse({ ...proposal(), [field]: "server_computed" }),
      ).toThrow("unknown field");
    },
  );
  it.each([
    (p: Project) => Object.assign(p, { ignored: 1 }),
    (p: Project) => Object.assign(p.ambient, { ignored: 1 }),
    (p: Project) => Object.assign(p.substrate, { ignored: 1 }),
    (p: Project) => Object.assign(p.layers[0], { ignored: 1 }),
    (p: Project) => Object.assign(p.layers[0].material, { ignored: 1 }),
    (p: Project) => Object.assign(rectangle(p).background, { ignored: 1 }),
    (p: Project) => Object.assign(p.illumination, { ignored: 1 }),
    (p: Project) => Object.assign(p.solver, { ignored: 1 }),
  ])("rejects unknown keys at every nested Project boundary", (mutate) => {
    for (const field of ["base_project", "candidate_project"] as const) {
      const value = proposal();
      mutate(value[field]);
      expect(() => parse(value)).toThrow("unknown field");
    }
  });
  it.each([
    (p: Project) => {
      p.name = "Forged name";
    },
    (p: Project) => {
      p.illumination.angle_deg = 14;
    },
    (p: Project) => {
      p.layers[0].material.n = 2.2;
    },
    (p: Project) => {
      rectangle(p).background.source = "Forged source";
    },
    (p: Project) => {
      p.solver.harmonics = 8;
    },
    (p: Project) => {
      p.layers[0].thickness_nm = 170;
    },
  ])(
    "rejects additional candidate changes outside its explicit patch",
    (mutate) => {
      const value = proposal();
      mutate(value.candidate_project);
      expect(() => parse(value)).toThrow("outside the supplied geometry patch");
    },
  );
  it("normalizes omitted optional material defaults, but never ignores a different explicit source", () => {
    const value = proposal();
    delete value.base_project.ambient.source;
    delete value.base_project.ambient.wavelengths_nm;
    expect(parse(value).base_project.ambient.source).toBe(
      defaultProject.ambient.source,
    );
    value.candidate_project.ambient.source = "Other source";
    expect(() => parse(value)).toThrow("outside");
  });
  it("rejects forged, incomplete, duplicated or reordered diffs", () => {
    for (const mutate of [
      (p: ChangeProposal) => {
        p.diff[0].before += 1;
      },
      (p: ChangeProposal) => {
        p.diff[0].after += 1;
      },
      (p: ChangeProposal) => {
        p.diff = [];
      },
      (p: ChangeProposal) => {
        p.diff.push(p.diff[0]);
      },
      (p: ChangeProposal) => {
        Object.assign(p.diff[0], { extra: true });
      },
    ]) {
      const value = proposal();
      mutate(value);
      expect(() => parse(value)).toThrow();
    }
    const value = proposal({ cd_nm: 140, period_nm: 401 });
    value.diff.reverse();
    expect(() => parse(value)).toThrow("Supplied diff");
  });
  it("validates hashes as strings without trusting them as provenance", () => {
    for (const hash of ["bad", "A".repeat(64), 123, null]) {
      expect(() => parse({ ...proposal(), base_input_hash: hash })).toThrow(
        "SHA-256",
      );
    }
    const value = parse(proposal());
    expect(value.base_input_hash).toBe("a".repeat(64));
    expect(value).not.toHaveProperty("origin");
  });
  it("requires typed complete diagnostics and never trusts their supplied validity", () => {
    const bad = [
      { code: "bad", severity: "urgent", location: [], message: "bad" },
      { code: "bad", severity: "error", location: [true], message: "bad" },
      { code: "bad", severity: "error", location: [0.5], message: "bad" },
      { code: "bad", severity: "error", message: "bad" },
      {
        code: "bad",
        severity: "error",
        location: [],
        message: "bad",
        extra: true,
      },
    ];
    for (const diagnostic of bad)
      expect(() =>
        parse({ ...proposal(), diagnostics: [diagnostic] }),
      ).toThrow();
    expect(() => parse({ ...proposal(), valid: "true" })).toThrow("boolean");
    const valid = proposal();
    valid.valid = false;
    valid.diagnostics = [
      { code: "forged", severity: "error", location: [], message: "Forged" },
    ];
    expect(parse(valid).valid).toBe(true);
    expect(parse(valid).diagnostics).toEqual([]);
  });
  it("rejects invalid JSON, nonfinite numbers and files above the UTF-8 2 MB boundary", () => {
    expect(() => parseChangeProposal("NaN")).toThrow();
    expect(() => parseChangeProposal("{} trailing")).toThrow();
    expect(() =>
      parseChangeProposal(
        JSON.stringify(proposal()).replace(
          '"period_nm":400',
          '"period_nm":1e400',
        ),
      ),
    ).toThrow("finite");
    const text = JSON.stringify(proposal());
    expect(
      parseChangeProposal(
        text +
          " ".repeat(
            PROPOSAL_MAX_BYTES - new TextEncoder().encode(text).length,
          ),
      ).valid,
    ).toBe(true);
    expect(() =>
      parseChangeProposal(text + " ".repeat(PROPOSAL_MAX_BYTES)),
    ).toThrow("2 MB");
    expect(() =>
      parseChangeProposal("é".repeat(PROPOSAL_MAX_BYTES / 2 + 1)),
    ).toThrow("2 MB");
  });
  it("allows a structural no-op but disables applying it", () => {
    const value = parse(proposal({ cd_nm: 180 }));
    expect(value.valid).toBe(true);
    expect(value.diff).toEqual([]);
    expect(proposalApplyError(value, project(), 3, 3)).toContain("no changes");
  });
  it("rejects stale bases and edit-then-undo revision races", () => {
    const value = parse(proposal());
    expect(proposalApplyError(value, project(), 3, 3)).toBeNull();
    expect(proposalApplyError(value, project(190), 3, 3)).toContain(
      "project changed",
    );
    expect(proposalApplyError(value, project(), 3, 5)).toContain(
      "project changed",
    );
    const sourceChange = project();
    sourceChange.ambient.source = "Other";
    expect(proposalApplyError(value, sourceChange, 3, 3)).toContain(
      "project changed",
    );
    const sparse = project();
    delete sparse.ambient.source;
    expect(proposalApplyError(value, sparse, 3, 3)).toBeNull();
  });
  it("opening/canceling makes no history; apply is one edit and never changes the old run", () => {
    const displayedRun = run();
    let state = createHistory(workspace(180, displayedRun));
    const before = state;
    const preview = parse(proposal());
    expect(state).toBe(before);
    state = workspaceReducer(state, {
      type: "replace-project",
      project: preview.candidate_project,
    });
    expect(state.past).toHaveLength(1);
    expect(state.present.displayedRun).toBe(displayedRun);
    expect(
      workspaceReducer(state, {
        type: "replace-project",
        project: preview.candidate_project,
      }),
    ).toBe(state);
    state = workspaceReducer(state, { type: "undo" });
    expect(state.present).toBe(before.present);
  });
  it("keeps imported project results unverified even if their files claim server origin", () => {
    const file = parseProjectFile(
      JSON.stringify({
        ...reference,
        provenance: { source: "server_computed" },
        origin: "server",
        sourceJobId: "forged",
      }),
    );
    const imported = createRunRecord({
      inputProject: file.result_project || file.project,
      result: file.result!,
      origin: "imported",
    });
    expect(imported.origin).toBe("imported");
    expect(imported.sourceJobId).toBeUndefined();
    expect(imported.snapshotId).toBeUndefined();
  });
});

describe("engine-independent preflight parity", () => {
  it("accepts the default without requiring an engine", () => {
    expect(localPreflight(project())).toEqual([]);
  });
  it("recomputes an exact cutoff despite forged valid and diagnostics fields", () => {
    const base = project();
    base.illumination.angle_deg = 0;
    base.illumination.wavelengths_nm = [500];
    const value = proposal({ period_nm: 500 }, base);
    value.valid = true;
    value.diagnostics = [];
    const parsed = parse(value);
    expect(parsed.valid).toBe(false);
    expect(parsed.diagnostics).toEqual([
      {
        code: "rayleigh_cutoff",
        severity: "error",
        location: ["illumination", "wavelengths_nm", 0],
        message:
          "A diffraction order is exactly at a Rayleigh cutoff near 500 nm; move the sampled wavelength slightly",
      },
    ]);
    expect(proposalApplyError(parsed, base, 0, 0)).toContain(
      "validation errors",
    );
  });
  it("allows a proposal to repair a preflight-invalid base", () => {
    const base = project();
    base.illumination.angle_deg = 0;
    base.illumination.wavelengths_nm = [500];
    base.period_nm = 500;
    expect(localPreflight(base).some((d) => d.severity === "error")).toBe(true);
    expect(parse(proposal({ period_nm: 490 }, base)).valid).toBe(true);
  });
  it("preserves a near-cutoff warning as valid", () => {
    const base = project();
    base.illumination.angle_deg = 0;
    base.illumination.wavelengths_nm = [500];
    const parsed = parse(proposal({ period_nm: 500.005 }, base));
    expect(parsed.valid).toBe(true);
    expect(parsed.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["near_rayleigh_cutoff", "warning"],
    ]);
  });
  it("detects omitted propagating orders without claiming convergence", () => {
    const base = project();
    base.solver.harmonics = 1;
    base.illumination.wavelengths_nm = [450];
    const parsed = parse(proposal({ period_nm: 5000 }, base));
    expect(parsed.valid).toBe(false);
    expect(parsed.diagnostics[0]).toMatchObject({
      code: "insufficient_harmonics",
      severity: "error",
      location: ["solver", "harmonics"],
    });
  });
  it("uses the lossy substrate's full complex squared index", () => {
    const base = project();
    base.illumination.angle_deg = 0;
    base.illumination.wavelengths_nm = [500];
    base.period_nm = 500 / 1.5;
    expect(localPreflight(base).some((d) => d.code === "rayleigh_cutoff")).toBe(
      true,
    );
    base.substrate.k = 0.1;
    expect(localPreflight(base)).toEqual([]);
  });
  it("interpolates n/k independently and rejects material extrapolation", () => {
    const base = project();
    base.illumination.angle_deg = 0;
    base.illumination.wavelengths_nm = [500];
    base.period_nm = 500 / 1.5;
    base.ambient = {
      ...base.ambient,
      kind: "tabulated",
      wavelengths_nm: [400, 600],
      n_values: [1, 2],
      k_values: [0, 0],
    };
    expect(localPreflight(base).some((d) => d.code === "rayleigh_cutoff")).toBe(
      true,
    );
    base.illumination.wavelengths_nm = [700];
    expect(localPreflight(base)).toEqual([
      {
        code: "material_coverage",
        severity: "error",
        location: ["ambient", "wavelengths_nm"],
        message:
          "Air: wavelength outside material table; extrapolation is forbidden",
      },
    ]);
  });
});

describe("stored result and candidate comparison compatibility", () => {
  it("binds a result to exact wavelengths and exactly requested polarizations", () => {
    const record = run();
    expect(
      resultCompatibilityError(record.inputProject, record.result),
    ).toBeNull();
    expect(resultCompatibilityError(record.inputProject, null)).toContain(
      "missing or invalid",
    );
    const changed = cloneProject(record.inputProject);
    changed.illumination.wavelengths_nm[0] += 0.001;
    expect(resultCompatibilityError(changed, record.result)).toContain(
      "wavelengths",
    );
    changed.illumination.wavelengths_nm = [
      ...record.inputProject.illumination.wavelengths_nm,
    ];
    changed.illumination.polarization = "s";
    expect(resultCompatibilityError(changed, record.result)).toContain(
      "polarizations",
    );
  });
  it("compares two or three distinct stored identities, even with identical inputs", () => {
    const candidates = ["1", "2", "3"].map((snapshotId) =>
      workspace(180, run({ snapshotId, origin: "server" })),
    );
    expect(
      comparisonCompatibilityError(candidates.slice(0, 2), "s"),
    ).toBeNull();
    expect(comparisonCompatibilityError(candidates, "p")).toBeNull();
    expect(comparisonCompatibilityError(candidates.slice(0, 1), "s")).toContain(
      "two or three",
    );
    expect(
      comparisonCompatibilityError([...candidates, candidates[0]], "s"),
    ).toContain("two or three");
    expect(
      comparisonCompatibilityError([candidates[0], candidates[0]], "s"),
    ).toContain("distinct");
    expect(
      comparisonCompatibilityError(
        [candidates[0], workspace(180, run({ snapshotId: "1" }))],
        "s",
      ),
    ).toContain("distinct");
  });
  it("uses stored run inputs, never stale current editor geometry", () => {
    const candidates = [
      workspace(180, run({ snapshotId: "1" })),
      workspace(199, run({ snapshotId: "2" })),
    ];
    candidates[1].project.illumination.wavelengths_nm = [300];
    expect(comparisonCompatibilityError(candidates, "s")).toBeNull();
  });
  it("reports absent spectra and selected channels truthfully", () => {
    const full = run({ snapshotId: "1" });
    expect(
      comparisonCompatibilityError([workspace(180, full), workspace()], "s"),
    ).toContain("no stored spectrum");
    const inputs = cloneProject(full.inputProject);
    inputs.illumination.polarization = "p";
    const result = structuredClone(full.result);
    delete result.spectra.s;
    const pOnly = run({ inputProject: inputs, result, snapshotId: "2" });
    expect(
      comparisonCompatibilityError(
        [workspace(180, full), workspace(180, pOnly)],
        "s",
      ),
    ).toContain("no s-polarized");
    expect(
      comparisonCompatibilityError(
        [workspace(180, full), workspace(180, pOnly)],
        "p",
      ),
    ).toBeNull();
  });
  it("refuses nearby grids without interpolation and supports one stored wavelength", () => {
    const first = run({ snapshotId: "1" });
    const inputProject = cloneProject(first.inputProject),
      result = structuredClone(first.result);
    inputProject.illumination.wavelengths_nm[0] += 0.01;
    result.wavelengths_nm[0] += 0.01;
    const second = run({ inputProject, result, snapshotId: "2" });
    expect(
      comparisonCompatibilityError(
        [workspace(180, first), workspace(180, second)],
        "s",
      ),
    ).toContain("no interpolation");
    const singleInput = cloneProject(first.inputProject),
      singleResult = structuredClone(first.result);
    singleInput.illumination.wavelengths_nm =
      singleInput.illumination.wavelengths_nm.slice(0, 1);
    singleResult.wavelengths_nm = singleResult.wavelengths_nm.slice(0, 1);
    for (const spectrum of Object.values(singleResult.spectra))
      for (const key of [
        "R",
        "T",
        "R_specular",
        "T_specular",
        "A_balance",
      ] as const)
        spectrum[key] = spectrum[key].slice(0, 1);
    const a = run({
      inputProject: singleInput,
      result: singleResult,
      snapshotId: "a",
    });
    const b = run({
      inputProject: singleInput,
      result: singleResult,
      snapshotId: "b",
    });
    expect(
      comparisonCompatibilityError([workspace(180, a), workspace(180, b)], "p"),
    ).toBeNull();
  });
});
