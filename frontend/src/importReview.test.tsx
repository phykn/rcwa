import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import reference from "../public/reference-circular.json";
import {
  defaultProject,
  parseProjectFileAsync,
  serializeProjectFile,
} from "./model";
import type { Project2D, ProjectFile } from "./model";
import { reviewImportedDesign } from "./importReview";
import { stringify2DEnvelope } from "./project2d";
import { reviewInputChanges } from "./reviewChanges";
import { ReviewPanel } from "./WorkflowPanels";
import {
  createHistory,
  createRunRecord,
  exactSemanticEqual,
  sameNormalizedProject,
  workspaceReducer,
} from "./workflow";
import type { Workspace } from "./workflow";

let parsed: ProjectFile;
let base: Workspace;
beforeAll(async () => {
  parsed = await parseProjectFileAsync(JSON.stringify(reference));
  base = createHistory({
    project: parsed.project,
    displayedRun: createRunRecord({
      inputProject: parsed.project,
      result: parsed.result!,
      origin: "reference",
    }),
    selectedLayer: 2,
  }).present;
});
const input = () => structuredClone(parsed.project) as Project2D;
const parseInputs = (project: Project2D) =>
  parseProjectFileAsync(serializeProjectFile(project, null, null));

describe("input-only 1.2 import review", () => {
  it("stages exact inputs without touching inputs, result, origin or selection", async () => {
    const project = input();
    Object.assign(project.layers[0], { diameter_nm: 70 });
    project.period_y_nm = 145;
    const data = await parseInputs(project);
    const history = createHistory(base);
    const staged = reviewImportedDesign(data, history.present)!;
    expect(staged.unchanged).toBe(false);
    expect(staged.workspace.project).toBe(data.project);
    expect(staged.workspace.displayedRun).toBe(base.displayedRun);
    expect(staged.workspace.selectedLayer).toBe(2);
    // Staging (and discarding a stage on Cancel) is read-only.
    expect(history.past).toHaveLength(0);
    expect(history.present.project).toEqual(parsed.project);
    expect(history.present.displayedRun).toBe(base.displayedRun);
    expect(base.displayedRun?.origin).toBe("reference");
    expect(base.displayedRun?.inputProject).toEqual(parsed.project);

    const applied = workspaceReducer(history, {
      type: "replace-workspace",
      workspace: staged.workspace,
    });
    expect(applied.past).toHaveLength(1);
    expect(applied.present.project).toEqual(project);
    expect(applied.present.displayedRun).toBe(base.displayedRun);
    expect(
      sameNormalizedProject(base.displayedRun!.inputProject, project),
    ).toBe(false);
    const undone = workspaceReducer(applied, { type: "undo" });
    expect(undone.present).toBe(history.present);
    expect(undone.past).toHaveLength(0);
    expect(
      sameNormalizedProject(
        undone.present.displayedRun!.inputProject,
        undone.present.project,
      ),
    ).toBe(true);
    const redone = workspaceReducer(undone, { type: "redo" });
    expect(redone.present.project).toEqual(project);
    expect(redone.present.displayedRun).toBe(base.displayedRun);
    expect(
      workspaceReducer(redone, {
        type: "replace-workspace",
        workspace: staged.workspace,
      }),
    ).toBe(redone);
  });
  it("retains no-result and already-stale frames without inventing or rebinding spectra", async () => {
    const project = input();
    project.period_y_nm++;
    const data = await parseInputs(project);
    const empty = { ...base, displayedRun: null };
    expect(
      reviewImportedDesign(data, empty)!.workspace.displayedRun,
    ).toBeNull();
    const stale = { ...base, project: { ...input(), period_nm: 160 } };
    const staged = reviewImportedDesign(data, stale)!;
    expect(staged.workspace.displayedRun).toBe(base.displayedRun);
    expect(staged.workspace.displayedRun!.inputProject.period_nm).toBe(150);
    project.layers = [project.layers[0]];
    expect(
      reviewImportedDesign(await parseInputs(project), base)!.workspace
        .selectedLayer,
    ).toBe(0);
  });
  it("recognizes semantically unchanged inputs without removing the current spectrum", async () => {
    const project = input();
    delete project.ambient.source;
    const stage = reviewImportedDesign(await parseInputs(project), base)!;
    expect(stage.unchanged).toBe(true);
    expect(stage.workspace.displayedRun).toBe(base.displayedRun);
    project.ambient.k = -0;
    expect(
      reviewImportedDesign(await parseInputs(project), base)!.unchanged,
    ).toBe(false);
  });
  it("preserves legacy and result-bearing import routes", async () => {
    expect(reviewImportedDesign(parsed, base)).toBeNull();
    const legacy = await parseProjectFileAsync(JSON.stringify(defaultProject));
    expect(reviewImportedDesign(legacy, base)).toBeNull();
    const oneOne = await parseProjectFileAsync(
      JSON.stringify({ ...defaultProject, schema_version: "1.1" }),
    );
    expect(reviewImportedDesign(oneOne, base)).toBeNull();
  });
  it("reviews exact tables, every dimension, illumination and harmonics without substitutes", async () => {
    const project = input();
    project.name = "Imported design";
    project.period_nm = 160;
    project.period_y_nm = 145;
    Object.assign(project.layers[0], { diameter_nm: 70, thickness_nm: 95 });
    project.illumination.angle_deg = 15;
    project.illumination.azimuth_deg = 35;
    project.illumination.wavelengths_nm = [480, 535, 610];
    project.solver.harmonics_x = 3;
    project.solver.harmonics_y = 4;
    project.ambient.k = -0;
    project.layers[0].material = {
      name: "Exact imported table",
      kind: "tabulated",
      n: 1,
      k: 0,
      wavelengths_nm: Array.from({ length: 1000 }, (_, index) => 400 + index),
      n_values: Array.from(
        { length: 1000 },
        (_, index) => 1.123456789 + index / 10000,
      ),
      k_values: Array.from({ length: 1000 }, (_, index) => index / 100000),
      source: "Synthetic regression data",
    };
    const stage = reviewImportedDesign(await parseInputs(project), base)!;
    expect(exactSemanticEqual(stage.workspace.project, project)).toBe(true);
    const changes = reviewInputChanges(base.project, stage.workspace.project);
    for (const key of [
      "period_nm",
      "period_y_nm",
      "layers[0].diameter_nm",
      "layers[0].thickness_nm",
      "layers[0].material.table",
      "illumination.angle_deg",
      "illumination.azimuth_deg",
      "illumination.wavelengths_nm",
      "solver.harmonics_x",
      "solver.harmonics_y",
      "ambient.k",
    ])
      expect(
        changes.some((change) => change.key === key),
        key,
      ).toBe(true);
    expect(
      changes.find((change) => change.key === "layers[0].material.table")
        ?.detail,
    ).toContain("1000 rows changed");
    const html = renderToStaticMarkup(
      createElement(ReviewPanel, {
        title: "Review imported design",
        importedDesign: true,
        baseProject: base.project,
        candidateProject: stage.workspace.project,
        note: "Review input differences only.",
        blockedReason: "",
        warnings: [],
        onApply: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain('aria-label="Review imported design"');
    expect(html).toContain("Current</h3>");
    expect(html).toContain("Proposed</h3>");
    expect(html).toContain("Full inputs</summary>");
    expect(html).toContain("1.123456789");
    expect(html).toContain("1000 rows changed");
    expect(html).toContain("-0.0");
    expect(html).toContain("Cancel</button>");
    expect(html).toContain("Apply changes</button>");
    expect(html.match(/class="preview-scale-note"/g)).toHaveLength(1);
    expect(html).toContain(
      "X–Z center sections use the same scale; Y extent is not shown. No calculation or server save.",
    );
    // Each geometry retains its complete accessible cross-section description.
    expect(html.match(/Y extent is not shown/g)).toHaveLength(3);
  });
  it("can recover valid imported inputs from an invalid editor draft", async () => {
    const invalid = { ...base, project: { ...input(), period_y_nm: 0 } };
    const staged = reviewImportedDesign(await parseInputs(input()), invalid)!;
    expect(staged.unchanged).toBe(false);
    expect(staged.workspace.project.period_nm).toBe(150);
    expect(staged.workspace.displayedRun).toBe(base.displayedRun);
  });
  it("keeps invalid imports outside staging through the strict raw-token validator", async () => {
    await expect(parseInputs({ ...input(), period_y_nm: 0 })).rejects.toThrow();
    await expect(
      parseProjectFileAsync(
        stringify2DEnvelope(input()).replace(
          /"harmonics_x":\s*5/,
          '"harmonics_x": 5.0',
        ),
      ),
    ).rejects.toThrow();
    await expect(parseProjectFileAsync("{bad JSON")).rejects.toThrow();
    expect(base.project).toEqual(parsed.project);
  });
});
