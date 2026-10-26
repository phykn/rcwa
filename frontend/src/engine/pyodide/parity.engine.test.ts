/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import { beforeAll, describe, expect, it } from "vitest";
import { TEMPLATES } from "../../core/templates";
import { chunkDesign } from "../chunks";
import { MEENT_WHEEL, prepareRuntime, type BridgeResponse, type PyRuntime } from "./runtime";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const fixtures = resolve(root, "backend/tests/fixtures/true-2d");
let runtime: PyRuntime;

function call<T>(op: Parameters<PyRuntime["call"]>[0], ...args: (string | number)[]): T {
  const response = JSON.parse(runtime.call(op, ...args)) as BridgeResponse<T>;
  if (!response.ok) throw new Error(`${response.code}: ${response.message}`);
  return response.value;
}

type Result = {
  wavelengths_nm: number[];
  spectra: Record<string, Record<string, unknown[]>>;
  metadata: Record<string, unknown>;
};

function expectClose(actual: Result, expected: Result, tolerance: number) {
  expect(actual.wavelengths_nm).toEqual(expected.wavelengths_nm);
  let worst = 0;
  for (const pol of Object.keys(expected.spectra)) {
    for (const field of ["R", "T", "R_specular", "T_specular", "A_balance"]) {
      const a = actual.spectra[pol][field] as number[];
      const b = expected.spectra[pol][field] as number[];
      a.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - b[i]))));
    }
    const ao = actual.spectra[pol].orders as Record<string, number>[][];
    const bo = expected.spectra[pol].orders as Record<string, number>[][];
    ao.forEach((rows, wi) =>
      rows.forEach((row, oi) => {
        expect([row.m, row.n]).toEqual([bo[wi][oi].m, bo[wi][oi].n]);
        for (const f of ["R", "T", "R_s", "R_p", "T_s", "T_p"])
          worst = Math.max(worst, Math.abs(row[f] - bo[wi][oi][f]));
      }),
    );
  }
  expect(worst).toBeLessThan(tolerance);
}

beforeAll(async () => {
  const py = await loadPyodide();
  const dir = resolve(root, "backend/rcwa_core");
  const sources = Object.fromEntries(
    readdirSync(dir)
      .filter((f: string) => f.endsWith(".py"))
      .map((f: string) => [f, readFileSync(resolve(dir, f), "utf8")]),
  );
  runtime = await prepareRuntime(
    py,
    readFileSync(resolve(root, "frontend/public/py", MEENT_WHEEL)),
    { "__init__.py": "", ...sources },
    readFileSync(resolve(here, "bridge.py"), "utf8"),
  );
}, 600_000);

describe("browser engine parity with native CPython", () => {
  it("reproduces the adapter-1.4 circular-hole H5 result", () => {
    const project = readFileSync(resolve(fixtures, "circular-project.json"), "utf8");
    const expected = JSON.parse(gunzipSync(readFileSync(resolve(fixtures, "circular-result-H5-adapter-1.4.json.gz"))).toString());
    const actual = call<Result>("forward", project);
    expect(actual.metadata.input_hash).toBe(expected.metadata.input_hash);
    expectClose(actual, expected, 1e-10);
  }, 300_000);

  it("assembles sharded partials into the whole-spectrum result", () => {
    const data = JSON.parse(readFileSync(resolve(fixtures, "representative/lossy-mixed-eight-layer.json"), "utf8"));
    const project = JSON.stringify(data.project ?? data);
    const n = (JSON.parse(project).illumination.wavelengths_nm as number[]).length;
    const even = call<{ wavelength_nm: number }[]>("solve", project, JSON.stringify([...Array(n).keys()].filter((i) => i % 2 === 0)));
    const odd = call<{ wavelength_nm: number }[]>("solve", project, JSON.stringify([...Array(n).keys()].filter((i) => i % 2 === 1)));
    const partials = [...even, ...odd].sort((a, b) => a.wavelength_nm - b.wavelength_nm);
    const sharded = call<Result>("assemble", project, JSON.stringify(partials), 0);
    const whole = call<Result>("forward", project);
    delete sharded.metadata.elapsed_seconds;
    delete whole.metadata.elapsed_seconds;
    expect(sharded).toEqual(whole);
  }, 300_000);

  it("reports preflight errors as structured failures", () => {
    const project = JSON.parse(readFileSync(resolve(fixtures, "circular-project.json"), "utf8"));
    project.illumination.wavelengths_nm = [100];
    const response = JSON.parse(runtime.call("forward", JSON.stringify(project))) as BridgeResponse;
    expect(response.ok).toBe(false);
  });

  it("accepts every template without preflight errors", () => {
    for (const template of TEMPLATES)
      for (const chunk of chunkDesign(template.design)) {
        const value = call<{ diagnostics: { severity: string; message: string }[] }>("validate", JSON.stringify(chunk));
        expect(value.diagnostics.filter((d) => d.severity === "error"), template.id).toEqual([]);
      }
  });
});
