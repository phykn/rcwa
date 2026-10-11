import { beforeAll, describe, expect, it } from "vitest";
import reference from "../public/reference-2d.json";
import legacyReference from "../public/reference-example.json";
import {
  defaultProject,
  editStack,
  isForwardResult,
  maximumPatternedCDX,
  maximumPatternedCDY,
  parseProjectFile,
  parseProjectFileAsync,
  sameProject,
  serializeProjectFile,
  stackSummary,
  supportsSyntheticFit,
  validateProject,
} from "./model";
import type { ForwardResult, Project, Project2D, ProjectFile } from "./model";
import { hashProject2D, stringify2DEnvelope } from "./project2d";
import {
  applyGeometryChanges,
  applyStackChanges,
  cloneProject,
  comparisonCompatibilityError,
  comparisonConditionsDiffer,
  createHistory,
  createRunRecord,
  createRunRecordAsync,
  exactSemanticEqual,
  localPreflight,
  normalizeProject,
  parseChangeProposal,
  projectInputsEqual,
  proposalApplyError,
  resultCompatibilityError,
  sameNormalizedProject,
  semanticEqual,
  workspaceReducer,
} from "./workflow";
import type { ChangeProposal, RunRecord } from "./workflow";

function project(): Project2D {
  return structuredClone(reference.project) as Project2D;
}
function rect(value: Project, index = 0) {
  const layer = value.layers[index];
  if (layer.geometry !== "rectangle_2d") throw new Error("2D fixture required");
  return layer;
}
let parsed: ProjectFile;
let referenceRun: RunRecord;
beforeAll(async () => {
  parsed = await parseProjectFileAsync(JSON.stringify(reference));
  referenceRun = createRunRecord({
    inputProject: parsed.project,
    result: parsed.result!,
    origin: "reference",
  });
});

describe("versioned project/result import and immutable ingress", () => {
  it("retains the canonical legacy default and missing-version legacy family", () => {
    expect(defaultProject).toEqual(legacyReference.project);
    const withoutVersion: Partial<typeof defaultProject> =
      cloneProject(defaultProject);
    delete withoutVersion.schema_version;
    expect(parseProjectFile(JSON.stringify(withoutVersion)).project).toEqual(
      defaultProject,
    );
    expect(parseProjectFile(JSON.stringify(legacyReference))).toEqual({
      format: undefined,
      project: legacyReference.project,
      result: legacyReference.result,
      result_project: undefined,
    });
  });
  it("round trips the complete bound 1.2 result without claiming file provenance", async () => {
    expect(parsed.project).toEqual(reference.project);
    expect(parsed.result).toEqual(reference.result);
    expect(isForwardResult(parsed.result)).toBe(true);
    const text = serializeProjectFile(
      parsed.project,
      parsed.result!,
      parsed.project,
    );
    const imported = await parseProjectFileAsync(text);
    expect(imported.result).toEqual(reference.result);
    expect(imported.result?.spectra.s?.orders).toHaveLength(21);
    expect(imported.result?.metadata.convergence_checked).toBe(false);
    expect(
      resultCompatibilityError(imported.project, imported.result),
    ).toBeNull();
    const forged = await parseProjectFileAsync(
      stringify2DEnvelope({
        ...reference,
        provenance: { source: "server_computed" },
        resultOrigin: "server",
      }),
    );
    expect(forged).not.toHaveProperty("provenance");
    expect(forged).not.toHaveProperty("resultOrigin");
    const run = await createRunRecordAsync({
      inputProject: forged.project,
      result: forged.result!,
      origin: "imported",
    });
    expect(run.origin).toBe("imported");
    expect(run.result).toBe(forged.result);
  });
  it("fails closed at synchronous and unbound result installation boundaries", () => {
    expect(() => parseProjectFile(JSON.stringify(reference))).toThrow(
      "asynchronous binding",
    );
    expect(() =>
      createRunRecord({
        inputProject: project(),
        result: reference.result as ForwardResult,
        origin: "imported",
      }),
    ).toThrow("bound");
    expect(() =>
      createRunRecord({
        ...referenceRun,
        result: structuredClone(referenceRun.result),
      }),
    ).toThrow("bound");
    expect(() =>
      createHistory({
        project: project(),
        displayedRun: {
          ...referenceRun,
          result: structuredClone(referenceRun.result),
        },
      }),
    ).toThrow("bound");
    expect(
      resultCompatibilityError(
        { ...project(), period_y_nm: 160 },
        referenceRun.result,
      ),
    ).toContain("different project");
  });
  it("shares the frozen checked result across rewrapped records and all history frames", async () => {
    const wrapped = createRunRecord({
      ...referenceRun,
      snapshotId: "stored-1",
      origin: "server",
    });
    expect(wrapped.result).toBe(referenceRun.result);
    expect(await createRunRecordAsync(wrapped)).toBe(wrapped);
    const asyncWrapped = await createRunRecordAsync({
      ...wrapped,
      snapshotId: "stored-2",
    });
    expect(asyncWrapped.result).toBe(wrapped.result);
    expect(Object.isFrozen(wrapped.inputProject)).toBe(true);
    expect(Object.isFrozen(wrapped.result.spectra.s!.orders![0])).toBe(true);
  });
  it("captures inputs before asynchronous verification and rejects forged hash pairs", async () => {
    const inputProject = project();
    const result = structuredClone(reference.result) as ForwardResult;
    const pending = createRunRecordAsync({
      inputProject,
      result,
      origin: "imported",
    });
    inputProject.period_y_nm = 160;
    result.spectra.s!.R[0] = 123;
    result.metadata.input_hash = "0".repeat(64);
    const record = await pending;
    expect(record.inputProject).toEqual(reference.project);
    expect(record.result).toEqual(reference.result);
    expect(record.origin).toBe("imported");
    await expect(
      createRunRecordAsync({
        inputProject,
        result: reference.result as ForwardResult,
        origin: "imported",
      }),
    ).rejects.toThrow();
    const forged = structuredClone(reference);
    forged.result.metadata.input_hash = "0".repeat(64);
    await expect(parseProjectFileAsync(JSON.stringify(forged))).rejects.toThrow(
      "hash mismatch",
    );
  });
  it("binds against result_project, preserving a deliberately stale edited project", async () => {
    const edited = project();
    rect(edited, 2).cd_y_nm = 90;
    const imported = await parseProjectFileAsync(
      stringify2DEnvelope({
        project: edited,
        result: reference.result,
        result_project: reference.project,
      }),
    );
    expect(imported.project).toEqual(edited);
    expect(sameProject(imported.result_project!, imported.project)).toBe(false);
    expect(
      resultCompatibilityError(imported.result_project!, imported.result),
    ).toBeNull();
    expect(
      resultCompatibilityError(imported.project, imported.result),
    ).toContain("different project");
  });
  it("checks result-input schema pairing, while legacy 1.0 requests may return 1.1", async () => {
    const legacy = {
      ...legacyReference,
      result: { ...legacyReference.result, schema_version: "1.1" },
    };
    expect(
      parseProjectFile(JSON.stringify(legacy)).result?.schema_version,
    ).toBe("1.1");
    expect(resultCompatibilityError(defaultProject, legacy.result)).toBeNull();
    await expect(
      parseProjectFileAsync(
        stringify2DEnvelope({ project: project(), result: legacy.result }),
      ),
    ).rejects.toThrow("schema");
    await expect(
      parseProjectFileAsync(
        stringify2DEnvelope({
          project: defaultProject,
          result: reference.result,
        }),
      ),
    ).rejects.toThrow("schema");
    // The result's own inputs determine pairing, not a separately edited workspace family.
    const mixed = await parseProjectFileAsync(
      stringify2DEnvelope({
        project: defaultProject,
        result: reference.result,
        result_project: project(),
      }),
    );
    expect(mixed.project.schema_version).toBe("1.0");
    expect(mixed.result_project?.schema_version).toBe("1.2");
  });
  it("preserves Python raw integer-zero versus float-zero identity through file ingress", async () => {
    const source = JSON.stringify(project());
    for (const [token, negative] of [
      ["-0", false],
      ["0", false],
      ["-0.0", true],
      ["-0e0", true],
      ["-1e-999", true],
    ] as const) {
      const raw = source.replace('"azimuth_deg":25', `"azimuth_deg":${token}`);
      const direct = parseProjectFile(raw).project;
      if (direct.schema_version !== "1.2") throw new Error("fixture");
      expect(Object.is(direct.illumination.azimuth_deg, -0)).toBe(negative);
      const envelope = await parseProjectFileAsync(
        `{"project":${JSON.stringify(defaultProject)},"result_project":${raw}}`,
      );
      const inputs = envelope.result_project;
      if (inputs?.schema_version !== "1.2") throw new Error("fixture");
      expect(Object.is(inputs.illumination.azimuth_deg, -0)).toBe(negative);
    }
  });
  it("keeps the legacy full export envelope byte-identical to the original serializer", () => {
    const timestamp = "2026-10-11T00:00:00.000Z";
    expect(
      serializeProjectFile(
        defaultProject,
        legacyReference.result as ForwardResult,
        defaultProject,
        timestamp,
      ),
    ).toBe(
      JSON.stringify(
        {
          format: "lattice-project/1.0",
          exported_at: timestamp,
          project: defaultProject,
          result: legacyReference.result,
          result_project: defaultProject,
        },
        null,
        2,
      ),
    );
  });
  it("applies raw integer token gates to project and result_project envelopes", async () => {
    for (const spelling of ["5.0", "5e0", "true", '"5"']) {
      const projectText = JSON.stringify(project()).replace(
        '"harmonics_x":5',
        `"harmonics_x":${spelling}`,
      );
      expect(() => parseProjectFile(projectText)).toThrow();
      await expect(
        parseProjectFileAsync(
          `{"project":${JSON.stringify(defaultProject)},"result_project":${projectText}}`,
        ),
      ).rejects.toThrow();
    }
    const resultText = JSON.stringify(reference).replace(
      '"basis_size":121',
      '"basis_size":121.0',
    );
    await expect(parseProjectFileAsync(resultText)).rejects.toThrow(
      "integer JSON token",
    );
  });
});

describe("schema 1.2 editing, signed-zero identity and one-step history", () => {
  it("retains exact signed-zero differences at every nested input path without changing legacy equality", () => {
    expect(semanticEqual({ x: -0 }, { x: 0 })).toBe(true);
    expect(exactSemanticEqual({ x: -0 }, { x: 0 })).toBe(false);
    const mutations: ((value: Project2D, zero: number) => void)[] = [
      (value, zero) => {
        value.illumination.angle_deg = zero;
      },
      (value, zero) => {
        value.illumination.azimuth_deg = zero;
      },
      (value, zero) => {
        value.ambient.k = zero;
      },
      (value, zero) => {
        value.substrate.k = zero;
      },
      (value, zero) => {
        value.layers[1].thickness_nm = zero;
      },
      (value, zero) => {
        rect(value).cd_x_nm = zero;
      },
      (value, zero) => {
        rect(value).cd_y_nm = zero;
      },
      (value, zero) => {
        rect(value).background.k = zero;
      },
    ];
    for (const mutate of mutations) {
      const positive = project(),
        negative = project();
      mutate(positive, 0);
      mutate(negative, -0);
      expect(validateProject(positive)).toEqual([]);
      expect(validateProject(negative)).toEqual([]);
      expect(projectInputsEqual(positive, negative)).toBe(false);
      expect(sameNormalizedProject(positive, negative)).toBe(false);
      expect(sameProject(positive, negative)).toBe(false);
      const exported = serializeProjectFile(negative, null, null);
      expect(
        exactSemanticEqual(parseProjectFile(exported).project, negative),
      ).toBe(true);
      let state = createHistory({
        project: positive,
        displayedRun: referenceRun,
        selectedLayer: 2,
      });
      state = workspaceReducer(state, { type: "begin-edit" });
      state = workspaceReducer(state, {
        type: "replace-project",
        project: negative,
      });
      state = workspaceReducer(state, { type: "end-edit" });
      expect(state.past).toHaveLength(1);
      expect(state.revision).toBe(1);
      expect(state.present.displayedRun).toBe(referenceRun);
      expect(state.present.selectedLayer).toBe(2);
      state = workspaceReducer(state, { type: "undo" });
      expect(exactSemanticEqual(state.present.project, positive)).toBe(true);
      expect(state.present.displayedRun).toBe(referenceRun);
      state = workspaceReducer(state, { type: "redo" });
      expect(exactSemanticEqual(state.present.project, negative)).toBe(true);
      expect(state.present.displayedRun?.origin).toBe("reference");
      expect(state.present.displayedRun?.result).toBe(referenceRun.result);
    }
    const legacyZero = cloneProject(defaultProject);
    legacyZero.illumination.angle_deg = 0;
    const legacyNegative = cloneProject(legacyZero);
    legacyNegative.illumination.angle_deg = -0;
    expect(projectInputsEqual(legacyZero, legacyNegative)).toBe(true);
    const state = createHistory({ project: legacyZero, displayedRun: null });
    expect(
      workspaceReducer(state, {
        type: "replace-project",
        project: legacyNegative,
      }),
    ).toBe(state);
  });
  it("restores exact separately bound +0/-0 inputs, result and origin in one Undo/Redo", async () => {
    const negative = project();
    negative.ambient.k = -0;
    // Signed zero changes the canonical input identity but not these physical
    // powers. Rebind the existing immutable fixture; this never runs a solver.
    const result = structuredClone(reference.result);
    result.metadata.input_hash = await hashProject2D(negative);
    const negativeRun = await createRunRecordAsync({
      inputProject: negative,
      result: result as ForwardResult,
      origin: "imported",
    });
    expect(negativeRun.result.metadata.input_hash).not.toBe(
      referenceRun.result.metadata.input_hash,
    );
    expect(resultCompatibilityError(negative, negativeRun.result)).toBeNull();
    expect(resultCompatibilityError(project(), negativeRun.result)).toContain(
      "different project",
    );
    let state = createHistory({
      project: project(),
      displayedRun: referenceRun,
      selectedLayer: 0,
    });
    state = workspaceReducer(state, {
      type: "replace-workspace",
      workspace: {
        project: negative,
        displayedRun: negativeRun,
        selectedLayer: 2,
      },
    });
    expect(state.past).toHaveLength(1);
    state = workspaceReducer(state, { type: "undo" });
    expect(Object.is(state.present.project.ambient.k, 0)).toBe(true);
    expect(state.present.displayedRun).toBe(referenceRun);
    expect(state.present.displayedRun?.origin).toBe("reference");
    expect(state.present.selectedLayer).toBe(0);
    state = workspaceReducer(state, { type: "redo" });
    expect(Object.is(state.present.project.ambient.k, -0)).toBe(true);
    expect(state.present.displayedRun).toBe(negativeRun);
    expect(state.present.displayedRun?.origin).toBe("imported");
    expect(state.present.selectedLayer).toBe(2);
  });
  it("normalizes only valid 1.2 schema defaults while editing equality accepts invalid drafts", () => {
    const sparse = project();
    delete sparse.ambient.source;
    expect(projectInputsEqual(sparse, project())).toBe(false);
    expect(sameNormalizedProject(sparse, project())).toBe(true);
    expect(normalizeProject(sparse)).toEqual(project());
    const invalid = { ...project(), period_y_nm: 1 };
    expect(projectInputsEqual(invalid, structuredClone(invalid))).toBe(true);
    expect(sameNormalizedProject(invalid, invalid)).toBe(false);
    const state = createHistory({
      project: invalid,
      displayedRun: referenceRun,
    });
    expect(
      workspaceReducer(state, {
        type: "replace-project",
        project: structuredClone(invalid),
      }),
    ).toBe(state);
  });
  it("preserves only the selected width axis, retains the stale result, and undoes once", () => {
    const before = project(),
      edited = project();
    rect(edited, 2).cd_y_nm = 90;
    let state = createHistory({
      project: before,
      displayedRun: referenceRun,
      selectedLayer: 2,
    });
    state = workspaceReducer(state, {
      type: "replace-project",
      project: edited,
    });
    expect(rect(state.present.project, 2).cd_x_nm).toBe(95);
    expect(rect(state.present.project, 2).thickness_nm).toBe(130);
    expect(
      projectInputsEqual(
        state.present.displayedRun!.inputProject,
        state.present.project,
      ),
    ).toBe(false);
    state = workspaceReducer(state, { type: "undo" });
    expect(state.present.project).toEqual(before);
    expect(state.present.displayedRun).toBe(referenceRun);
    state = workspaceReducer(state, { type: "redo" });
    expect(state.present.project).toEqual(edited);
    expect(state.present.selectedLayer).toBe(2);
  });
  it("records action revisions across an edit followed by undo, while selection stays view-only", () => {
    let state = createHistory({
      project: project(),
      displayedRun: referenceRun,
      selectedLayer: 0,
    });
    const readRevision = state.revision;
    state = workspaceReducer(state, { type: "select-layer", index: 2 });
    expect(state.revision).toBe(readRevision);
    const edited = project();
    rect(edited, 2).cd_y_nm = 90;
    state = workspaceReducer(state, {
      type: "replace-project",
      project: edited,
    });
    state = workspaceReducer(state, { type: "undo" });
    expect(projectInputsEqual(state.present.project, project())).toBe(true);
    expect(state.revision).toBeGreaterThan(readRevision);
    expect(state.present.selectedLayer).toBe(2);
  });
  it("keeps schema 1.2 for films, ridges, duplicates, reorder and remove", () => {
    let current: Project = project();
    for (let index = 0; index < current.layers.length; index++)
      current = editStack(current, index, {
        type: "geometry",
        geometry: "homogeneous",
      }).project;
    expect(current.schema_version).toBe("1.2");
    expect(
      current.layers.every((layer) => layer.geometry === "homogeneous"),
    ).toBe(true);
    while (current.layers.length > 1)
      current = editStack(current, 0, { type: "remove" }).project;
    current = editStack(current, 0, {
      type: "geometry",
      geometry: "rectangle_1d",
    }).project;
    expect(current.schema_version).toBe("1.2");
    expect(supportsSyntheticFit(current)).toBe(false);
    current = editStack(current, 0, {
      type: "add",
      geometry: "rectangle_2d",
    }).project;
    expect(current.layers[1].geometry).toBe("rectangle_2d");
    current = editStack(current, 1, { type: "duplicate" }).project;
    current = editStack(current, 2, { type: "move", direction: -1 }).project;
    expect(current.schema_version).toBe("1.2");
    expect(validateProject(current)).toEqual([]);
    expect(() =>
      editStack(defaultProject, 0, { type: "add", geometry: "rectangle_2d" }),
    ).toThrow("not silently converted");
  });
  it("preserves existing X width and materials in explicit 2D/ridge conversion", () => {
    const initial = project();
    const ridge = editStack(initial, 2, {
      type: "geometry",
      geometry: "rectangle_1d",
    }).project;
    expect(ridge.layers[2]).toMatchObject({
      cd_nm: 95,
      thickness_nm: 130,
      material: initial.layers[2].material,
    });
    expect(ridge.layers[2]).not.toHaveProperty("cd_x_nm");
    expect(ridge.layers[2]).not.toHaveProperty("cd_y_nm");
    const converted = editStack(ridge, 2, {
      type: "geometry",
      geometry: "rectangle_2d",
    }).project;
    expect(rect(converted, 2).cd_x_nm).toBe(95);
    expect(rect(converted, 2).background).toEqual(rect(initial, 2).background);
    expect(initial).toEqual(reference.project);
  });
  it("finds independent maximum widths across mixed stacks without resizing or changing family", () => {
    const mixed = project();
    mixed.layers.push({
      ...structuredClone(defaultProject.layers[0]),
      cd_nm: 130,
    });
    expect(maximumPatternedCDX(mixed)).toBe(130);
    expect(maximumPatternedCDY(mixed)).toBe(80);
    const tooSmall = { ...mixed, period_y_nm: 79 };
    expect(validateProject(tooSmall).length).toBeGreaterThan(0);
    expect(rect(tooSmall, 2).cd_y_nm).toBe(80);
    expect(mixed.period_y_nm).toBe(140);
    expect(stackSummary(mixed)).toContain("Width X 95 nm · Y 80 nm");
  });
});

describe("unsupported 1.2 proposals and comparison contracts", () => {
  it("rejects both proposal routes and their apply paths without mutation, even all-film/ridge projects", () => {
    for (const geometry of [
      "rectangle_2d",
      "rectangle_1d",
      "homogeneous",
    ] as const) {
      const value = editStack(project(), 0, {
        type: "geometry",
        geometry,
      }).project;
      value.layers = [value.layers[0]];
      const before = cloneProject(value);
      expect(supportsSyntheticFit(value)).toBe(false);
      expect(() => applyGeometryChanges(value, { cd_nm: 20 })).toThrow(
        "1.2 change proposals are unsupported",
      );
      expect(() => applyStackChanges(value, { period_nm: 160 })).toThrow(
        "1.2 change proposals are unsupported",
      );
      for (const schema_version of [
        "rcwa-change-proposal/1.0",
        "rcwa-change-proposal/1.1",
      ]) {
        const proposal = {
          schema_version,
          base_project: value,
          candidate_project: value,
        };
        expect(() => parseChangeProposal(JSON.stringify(proposal))).toThrow(
          "1.2 change proposals are unsupported",
        );
        expect(
          proposalApplyError(
            proposal as unknown as ChangeProposal,
            value,
            0,
            0,
          ),
        ).toContain("unsupported");
      }
      expect(value).toEqual(before);
    }
  });
  it("limits client 1.2 preflight to schema checks and leaves physical preflight authoritative to the backend", () => {
    expect(localPreflight(project())).toEqual([]);
    const invalid = project();
    invalid.solver.harmonics_y = 6;
    expect(localPreflight(invalid)[0].code).toBe("project_validation");
  });
  it("flags both pitches, Y width, azimuth, harmonics, schema and signed-zero conditions", () => {
    const mutations: ((value: Project2D) => void)[] = [
      (value) => {
        value.period_nm++;
      },
      (value) => {
        value.period_y_nm++;
      },
      (value) => {
        rect(value).cd_y_nm++;
      },
      (value) => {
        value.illumination.azimuth_deg++;
      },
      (value) => {
        value.solver.harmonics_y--;
      },
      (value) => {
        value.ambient.k = -0;
      },
    ];
    for (const mutate of mutations) {
      const next = project();
      mutate(next);
      expect(comparisonConditionsDiffer(project(), next)).toBe(true);
    }
    expect(comparisonConditionsDiffer(project(), project())).toBe(false);
    expect(comparisonConditionsDiffer(project(), defaultProject)).toBe(true);
    const names = project();
    names.name = "Renamed";
    names.layers[0].name = "Renamed layer";
    expect(comparisonConditionsDiffer(project(), names)).toBe(false);
  });
  it("compares bound distinct spectra only on an exact shared grid", () => {
    const saved = createRunRecord({ ...referenceRun, snapshotId: "saved-2" });
    expect(
      comparisonCompatibilityError(
        [
          { project: project(), displayedRun: referenceRun },
          { project: project(), displayedRun: saved },
        ],
        "s",
      ),
    ).toBeNull();
    const forged = { ...saved, result: structuredClone(saved.result) };
    expect(
      comparisonCompatibilityError(
        [
          { project: project(), displayedRun: referenceRun },
          { project: project(), displayedRun: forged },
        ],
        "s",
      ),
    ).toContain("bound");
  });
});
