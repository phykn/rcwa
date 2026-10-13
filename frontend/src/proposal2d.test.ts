import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/dimension-proposals-2d.json";
import reference from "../public/reference-circular.json";
import {
  apply2DDimensionChanges,
  dimensionDiff2D,
  parse2DChangeProposal,
  parse2DDimensionChanges,
} from "./proposal2d";
import type { DimensionChangeProposal } from "./proposal2d";
import {
  hashProject2D,
  normalizeProject2D,
  stringify2DEnvelope,
} from "./project2d";
import {
  createHistory,
  createRunRecord,
  exactSemanticEqual,
  parseChangeProposal,
  sameNormalizedProject,
  workspaceReducer,
} from "./workflow";
import { parseProjectFileAsync } from "./model";
import { reviewImportedDesign } from "./importReview";

const fixture = (name = "circle") =>
  structuredClone(
    fixtures.find((entry) => entry.name === name)!.proposal,
  ) as DimensionChangeProposal;
const parse = (value: unknown) =>
  parse2DChangeProposal(stringify2DEnvelope(value));
const base = () => fixture().base_project;

describe("strict exact-base schema-1.2 dimension proposals", () => {
  it.each(fixtures)(
    "parses the actual backend $name artifact and checks both hashes",
    async ({ proposal }) => {
      const parsed = await parse(proposal);
      expect(
        exactSemanticEqual(parsed.base_project, proposal.base_project),
      ).toBe(true);
      expect(
        exactSemanticEqual(
          parsed.candidate_project,
          proposal.candidate_project,
        ),
      ).toBe(true);
      expect(exactSemanticEqual(parsed.diff, proposal.diff)).toBe(true);
      expect(parsed.valid).toBe(proposal.valid);
      expect(parsed.diagnostics).toEqual([]);
      expect(Object.isFrozen(parsed.candidate_project.layers)).toBe(true);
      expect(await hashProject2D(parsed.base_project)).toBe(
        proposal.base_input_hash,
      );
      expect(await hashProject2D(parsed.candidate_project)).toBe(
        proposal.candidate_input_hash,
      );
    },
  );
  it("applies mixed geometry dimensions atomically and diffs in stable index/field order", () => {
    const p = fixture("mixed-atomic");
    const original = structuredClone(p.base_project);
    expect(() =>
      apply2DDimensionChanges(original, { period_nm: 60, period_y_nm: 60 }),
    ).toThrow();
    const candidate = apply2DDimensionChanges(original, p.changes);
    expect(exactSemanticEqual(candidate, p.candidate_project)).toBe(true);
    expect(original).toEqual(p.base_project);
    expect(dimensionDiff2D(original, candidate).map((d) => d.path)).toEqual([
      "period_nm",
      "period_y_nm",
      "layers[0].diameter_nm",
      "layers[1].cd_x_nm",
      "layers[1].cd_y_nm",
      "layers[2].cd_nm",
      "layers[3].thickness_nm",
    ]);
    expect(
      candidate.layers.map((layer) => [
        layer.name,
        layer.geometry,
        layer.material,
      ]),
    ).toEqual(
      original.layers.map((layer) => [
        layer.name,
        layer.geometry,
        layer.material,
      ]),
    );
    expect(candidate.illumination).toEqual(original.illumination);
    expect(candidate.solver).toEqual(original.solver);
  });
  it.each([
    {},
    null,
    [],
    { period_nm: null },
    { period_y_nm: true },
    { period_nm: "150" },
    { period_nm: Infinity },
    { period_nm: NaN },
    { period_nm: 19 },
    { period_y_nm: 5001 },
    { unknown: 1 },
    { layers: [] },
    { layers: null },
    { layers: true },
    { layers: [{ geometry: "circular_hole_2d", diameter_nm: 50 }] },
    { layers: [{ index: 0, diameter_nm: 50 }] },
    { layers: [{ index: 0, geometry: "circular_hole_2d" }] },
    {
      layers: [{ index: true, geometry: "circular_hole_2d", diameter_nm: 50 }],
    },
    { layers: [{ index: "0", geometry: "circular_hole_2d", diameter_nm: 50 }] },
    { layers: [{ index: 0.1, geometry: "circular_hole_2d", diameter_nm: 50 }] },
    { layers: [{ index: -1, geometry: "circular_hole_2d", diameter_nm: 50 }] },
    { layers: [{ index: 8, geometry: "circular_hole_2d", diameter_nm: 50 }] },
    { layers: [{ index: 0, geometry: "circular_hole_2d", cd_x_nm: 50 }] },
    { layers: [{ index: 0, geometry: "homogeneous", diameter_nm: 50 }] },
    { layers: [{ index: 0, geometry: "circular_hole_2d", diameter_nm: "50" }] },
    {
      layers: [{ index: 0, geometry: "circular_hole_2d", thickness_nm: null }],
    },
    {
      layers: [{ index: 0, geometry: "circular_hole_2d", thickness_nm: 2001 }],
    },
    {
      layers: [
        { index: 0, geometry: "circular_hole_2d", diameter_nm: 50 },
        { index: 0, geometry: "circular_hole_2d", diameter_nm: 60 },
      ],
    },
    {
      layers: Array.from({ length: 9 }, (_, index) => ({
        index,
        geometry: "homogeneous",
        thickness_nm: 4,
      })),
    },
  ])("rejects malformed dimensions %#", (changes) => {
    expect(() => parse2DDimensionChanges(changes)).toThrow();
  });
  it("rejects nonexistent/mismatched shapes, forbidden writes and prototype/accessor tricks", () => {
    for (const changes of [
      { layers: [{ index: 7, geometry: "homogeneous", thickness_nm: 30 }] },
      { layers: [{ index: 0, geometry: "rectangle_2d", cd_x_nm: 30 }] },
      {
        layers: [
          {
            index: 0,
            geometry: "circular_hole_2d",
            name: "Changed",
            thickness_nm: 30,
          },
        ],
      },
      {
        layers: [
          {
            index: 0,
            geometry: "circular_hole_2d",
            material: {},
            thickness_nm: 30,
          },
        ],
      },
      JSON.parse('{"__proto__":{},"period_nm":160}'),
      Object.create({ period_nm: 160 }),
      Object.defineProperty({}, "period_nm", {
        get() {
          throw new Error("must not access");
        },
      }),
    ])
      expect(() => apply2DDimensionChanges(base(), changes)).toThrow();
  });
  it("distinguishes signed zero and never loses untouched exact Unicode/material table inputs", async () => {
    const zero = await parse(fixture("signed-zero"));
    expect(Object.is(zero.diff[0].before, 0)).toBe(true);
    expect(Object.is(zero.diff[0].after, -0)).toBe(true);
    expect(zero.base_input_hash).not.toBe(zero.candidate_input_hash);
    expect(
      sameNormalizedProject(zero.base_project, zero.candidate_project),
    ).toBe(false);
    const project = base();
    project.name = "Exact 硅 🔬";
    project.ambient.k = -0;
    project.layers = Array.from({ length: 8 }, () =>
      structuredClone(project.layers[0]),
    );
    const material = {
      ...project.substrate,
      name: "Synthetic precise table",
      kind: "tabulated" as const,
      wavelengths_nm: Array.from({ length: 2000 }, (_, i) => 200 + i),
      n_values: Array.from(
        { length: 2000 },
        (_, i) => 1.432198765432101 + i * 0.000013579246813,
      ),
      k_values: Array.from({ length: 2000 }, (_, i) => i * 0.000001357924681),
    };
    for (const layer of project.layers) {
      layer.material = structuredClone(material);
      if (layer.geometry !== "homogeneous")
        layer.background = structuredClone(material);
    }
    const candidate = apply2DDimensionChanges(project, { period_y_nm: 160 });
    expect(exactSemanticEqual(candidate.layers, project.layers)).toBe(true);
    expect(Object.is(candidate.ambient.k, -0)).toBe(true);
    const payload: DimensionChangeProposal = {
      ...fixture(),
      base_project: project,
      candidate_project: candidate,
      changes: { period_y_nm: 160 },
      diff: dimensionDiff2D(project, candidate),
      base_input_hash: await hashProject2D(project),
      candidate_input_hash: await hashProject2D(candidate),
    };
    expect(stringify2DEnvelope(payload).length).toBeGreaterThan(2_000_000);
    expect(
      exactSemanticEqual((await parse(payload)).candidate_project, candidate),
    ).toBe(true);
  }, 20_000);
  it.each([
    (p: DimensionChangeProposal) => {
      p.base_input_hash = "0".repeat(64);
    },
    (p: DimensionChangeProposal) => {
      p.candidate_input_hash = "0".repeat(64);
    },
    (p: DimensionChangeProposal) => {
      p.candidate_project.name = "Extra edit";
    },
    (p: DimensionChangeProposal) => {
      p.candidate_project.layers.reverse();
    },
    (p: DimensionChangeProposal) => {
      p.candidate_project.ambient.k = -0;
    },
    (p: DimensionChangeProposal) => {
      p.base_project.ambient.k = -0;
    },
    (p: DimensionChangeProposal) => {
      delete p.base_project.ambient.source;
    },
    (p: DimensionChangeProposal) => {
      p.diff.pop();
    },
    (p: DimensionChangeProposal) => {
      p.diff[0].before++;
    },
    (p: DimensionChangeProposal) => {
      p.changes.period_y_nm = 146;
    },
    (p: DimensionChangeProposal) => {
      Object.assign(p, { extra: true });
    },
    (p: DimensionChangeProposal) => {
      Object.assign(p.changes, { illumination: {} });
    },
  ])("rejects corrupted complete canonical binding %#", async (mutate) => {
    const p = fixture();
    mutate(p);
    await expect(parse(p)).rejects.toThrow();
  });
  it("enforces raw integer tokens, duplicate members and finite JSON without changing ordinary gates", async () => {
    const text = stringify2DEnvelope(fixture());
    for (const invalid of [
      text.replace('"index":0', '"index":0.0'),
      text.replace('"index":0', '"index":0e0'),
      text.replace('"harmonics_x":5', '"harmonics_x":5.0'),
      text.replace('"period_nm":150', '"period_nm":150,"period_nm":150'),
      text.replace('"index":0', '"index":0,"index":0'),
      text.replace('"valid":true', '"valid":true,"valid":true'),
      text.replace('"period_nm":150', '"period_nm":1e999'),
    ]) {
      expect(invalid).not.toBe(text);
      await expect(parse2DChangeProposal(invalid)).rejects.toThrow();
    }
    expect(
      (await parse2DChangeProposal(text.replace('"index":0', '"index":-0')))
        .changes.layers![0].index,
    ).toBe(0);
    const zero = stringify2DEnvelope(fixture("signed-zero"));
    await expect(
      parse2DChangeProposal(zero.replaceAll("-0.0", "-0")),
    ).rejects.toThrow(/diff|hash/);
    await expect(parse2DChangeProposal("{")).rejects.toThrow();
    await expect(
      parse2DChangeProposal(text.padEnd(8_000_001, " ")),
    ).rejects.toThrow(/8 MB/);
  });
  it("treats imported scientific claims conservatively, never as verified diagnostics", async () => {
    const p = fixture("numerical-failure");
    expect(p.valid).toBe(false);
    const negative = await parse(p);
    expect(negative.valid).toBe(false);
    expect(negative.diagnostics).toEqual([]);
    p.valid = true;
    await expect(parse(p)).rejects.toThrow(/contradicts/);
    p.diagnostics = [];
    const forgedPositive = await parse(p);
    expect(forgedPositive.diagnostics).toEqual([]);
    // Schema-valid inputs may be edited, but input hashes cannot bypass the binding.
    p.candidate_project.layers[0].thickness_nm++;
    await expect(parse(p)).rejects.toThrow(/candidate/);
    for (const severity of [
      ["error"],
      ["warning"],
      {},
      true,
      null,
      1,
      "invalid",
    ]) {
      const bad = fixture();
      Object.assign(bad, {
        diagnostics: [
          {
            code: "fake",
            severity,
            location: [],
            message: "Forged scientific assurance",
          },
        ],
      });
      await expect(parse(bad)).rejects.toThrow(/diagnostic/);
    }
    const falseNoErrors = fixture();
    falseNoErrors.valid = false;
    await expect(parse(falseNoErrors)).rejects.toThrow(/contradicts/);
  });
  it("preserves displayed result/selection in one undo step, and leaves no-op/cancel untouched", async () => {
    const file = await parseProjectFileAsync(JSON.stringify(reference));
    const run = createRunRecord({
      inputProject: file.project,
      result: file.result!,
      origin: "reference",
    });
    const history = createHistory({
      project: file.project,
      displayedRun: run,
      selectedLayer: 2,
    });
    const p = await parse(fixture());
    expect(sameNormalizedProject(history.present.project, p.base_project)).toBe(
      true,
    );
    const stage = { ...history.present, project: p.candidate_project };
    expect(history.past).toHaveLength(0); // Staging and cancellation don't dispatch.
    const applied = workspaceReducer(history, {
      type: "replace-workspace",
      workspace: stage,
    });
    expect(applied.past).toHaveLength(1);
    expect(applied.present.selectedLayer).toBe(2);
    expect(applied.present.displayedRun).toBe(run);
    expect(
      sameNormalizedProject(run.inputProject, applied.present.project),
    ).toBe(false);
    const undone = workspaceReducer(applied, { type: "undo" });
    expect(undone.present).toBe(history.present);
    const redone = workspaceReducer(undone, { type: "redo" });
    expect(redone.present.project).toEqual(stage.project);
    expect(redone.present.displayedRun).toBe(run);
    const noop = await parse(fixture("noop"));
    expect(noop.diff).toEqual([]);
    expect(
      workspaceReducer(history, {
        type: "replace-workspace",
        workspace: { ...history.present, project: noop.candidate_project },
      }),
    ).toBe(history);
    expect(
      sameNormalizedProject(
        { ...history.present.project, name: "newer" },
        p.base_project,
      ),
    ).toBe(false);
    expect(
      sameNormalizedProject(
        { ...base(), ambient: { ...base().ambient, k: -0 } },
        p.base_project,
      ),
    ).toBe(false);
    // The ordinary full-input review stays non-base-bound; legacy APIs keep rejection.
    expect(
      reviewImportedDesign({ project: p.candidate_project }, history.present)!
        .workspace.project,
    ).toEqual(p.candidate_project);
    expect(() => parseChangeProposal(stringify2DEnvelope(p))).toThrow(
      /unsupported/i,
    );
    expect(normalizeProject2D(base())).toEqual(base());
  });
});
