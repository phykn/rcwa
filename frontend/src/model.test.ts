import { describe, it, expect } from "vitest";
import {
  defaultProject,
  linspace,
  validateProject,
  parseProjectFile,
  sameProject,
  isForwardResult,
} from "./model";
describe("project boundary", () => {
  it("accepts the default and JSON round trip", () => {
    expect(validateProject(defaultProject)).toEqual([]);
    expect(
      parseProjectFile(JSON.stringify({ project: defaultProject })).project,
    ).toEqual(defaultProject);
    expect(parseProjectFile(JSON.stringify(defaultProject)).project).toEqual(
      defaultProject,
    );
  });
  it("rejects malformed projects and impossible geometries", () => {
    expect(() => parseProjectFile("{}")).toThrow();
    const project = structuredClone(defaultProject);
    project.layers[0].cd_nm = 999;
    expect(validateProject(project).join(" ")).toContain("CD");
  });
  it("rejects unphysical ambient and uncovered tables", () => {
    const project = structuredClone(defaultProject);
    project.ambient.k = 0.1;
    expect(validateProject(project).join(" ")).toContain("lossless");
    project.ambient.k = 0;
    project.layers[0].material = {
      name: "table",
      kind: "tabulated",
      n: 2,
      k: 0,
      wavelengths_nm: [500, 600],
      n_values: [2, 2],
      k_values: [0, 0],
    };
    expect(validateProject(project).join(" ")).toContain("No extrapolation");
  });
  it("keeps exact endpoints and clamps workload", () => {
    expect(linspace(400, 800, 3)).toEqual([400, 600, 800]);
    expect(linspace(400, 800, 10000)).toHaveLength(81);
  });
  it("detects stale outputs and rejects malformed spectra", () => {
    expect(sameProject(structuredClone(defaultProject), defaultProject)).toBe(
      true,
    );
    expect(sameProject(null, defaultProject)).toBe(false);
    expect(
      isForwardResult({ wavelengths_nm: [500], spectra: { s: { R: [0.1] } } }),
    ).toBe(false);
    expect(() =>
      parseProjectFile(
        JSON.stringify({ project: defaultProject, result: { fake: true } }),
      ),
    ).toThrow("Saved result");
  });
});

describe("import hardening", () => {
  it("discards claimed provenance and origin from imported envelopes", () => {
    const parsed = parseProjectFile(
      JSON.stringify({
        project: defaultProject,
        provenance: { source: "server_computed", job_id: "forged-job" },
        resultOrigin: "server",
        source: "server_computed",
      }),
    );
    expect(parsed.project).toEqual(defaultProject);
    expect(parsed).not.toHaveProperty("provenance");
    expect(parsed).not.toHaveProperty("resultOrigin");
    expect(parsed).not.toHaveProperty("source");
  });
  it("preserves original result inputs when edited projects are reimported", () => {
    const inputs = structuredClone(defaultProject);
    inputs.illumination.wavelengths_nm = [500];
    inputs.illumination.polarization = "s";
    const edited = structuredClone(inputs);
    edited.layers[0].cd_nm += 1;
    const result = {
      schema_version: "1.0",
      wavelengths_nm: [500],
      spectra: {
        s: {
          R: [0.1],
          T: [0.9],
          R_specular: [0.1],
          T_specular: [0.9],
          A_balance: [0],
        },
      },
      metadata: {},
      warnings: [],
    };
    const parsed = parseProjectFile(
      JSON.stringify({
        project: edited,
        result,
        result_project: inputs,
        provenance: { source: "server_computed" },
      }),
    );
    expect(parsed.result).toEqual(result);
    expect(parsed.result_project).toEqual(inputs);
    expect(sameProject(parsed.result_project ?? null, parsed.project)).toBe(
      false,
    );
    expect(parsed).not.toHaveProperty("provenance");
  });
  it("uses the validated backend default, avoiding a Rayleigh cutoff", () => {
    expect(defaultProject.period_nm).toBe(400);
    expect(defaultProject.layers[0].cd_nm).toBe(180);
    expect(defaultProject.illumination.angle_deg).toBe(15);
    expect(defaultProject.illumination.wavelengths_nm).toEqual(
      linspace(450, 850, 21),
    );
    expect(defaultProject.solver.harmonics).toBe(7);
  });
  it("rejects material names that would crash JSX rendering", () => {
    const project = structuredClone(defaultProject) as unknown as Record<
      string,
      unknown
    >;
    project.ambient = { ...defaultProject.ambient, name: { bad: true } };
    expect(() => parseProjectFile(JSON.stringify(project))).toThrow(
      "material name",
    );
  });
  it("requires string warnings, metadata and a result schema", () => {
    const channel = {
      R: [0.1],
      T: [0.9],
      R_specular: [0.1],
      T_specular: [0.9],
      A_balance: [0],
    };
    const good = {
      schema_version: "1.0",
      wavelengths_nm: [500],
      spectra: { s: channel },
      metadata: {},
      warnings: [],
    };
    expect(isForwardResult(good)).toBe(true);
    expect(isForwardResult({ ...good, warnings: "oops" })).toBe(false);
    expect(isForwardResult({ ...good, warnings: [{}] })).toBe(false);
    expect(isForwardResult({ ...good, metadata: [] })).toBe(false);
    expect(isForwardResult({ ...good, schema_version: undefined })).toBe(false);
  });
  it("enforces finite and bounded optical constants but accepts absorbing substrate", () => {
    const project = structuredClone(defaultProject);
    project.substrate.k = 0.1;
    expect(validateProject(project)).toEqual([]);
    project.layers[0].material.n = 11;
    expect(validateProject(project).join(" ")).toContain("≤ 10");
  });
});

describe("tabulated placeholders", () => {
  it("rejects malformed placeholders before material labels or API submission", () => {
    const project = structuredClone(defaultProject);
    project.layers[0].material = {
      name: "table",
      kind: "tabulated",
      n: 2,
      k: 0,
      wavelengths_nm: [200, 2500],
      n_values: [2, 2.2],
      k_values: [0, 0],
    };
    expect(validateProject(project)).toEqual([]);
    for (const n of ["bad", 999, null]) {
      const malformed = JSON.parse(JSON.stringify(project));
      malformed.layers[0].material.n = n;
      expect(() => parseProjectFile(JSON.stringify(malformed))).toThrow(
        "table placeholders",
      );
    }
  });
});
