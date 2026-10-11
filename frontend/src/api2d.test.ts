import { afterEach, describe, expect, it, vi } from "vitest";
import { api, projectRequestBody, solverSupportError } from "./api";
import { defaultProject } from "./model";
import { normalizeProject2D } from "./project2d";
import fixture from "./fixtures/default-project-2d.json";
const project = normalizeProject2D(fixture);
const capabilities = () => ({
  supported_project_schema_versions: ["1.0", "1.1", "1.2"],
  supported_result_schema_versions: ["1.0", "1.1", "1.2"],
  engine: {
    engine: "meent",
    installed_version: "0.13.2",
    required_version: "0.13.2",
    available: true,
    status: "available",
    message: "ready",
  },
  // Intentionally legacy top-level claims must never enable 2D fit/proposals.
  operations: ["synthetic_fit", "preview_changes"],
  limits: { harmonics_max: 20, wavelength_count: 81 },
  project_profiles: {
    "1.0": {
      operations: ["validate", "forward", "poll", "cancel"],
      geometry: ["rectangle_1d"],
      wavelength_count: 81,
      harmonics: { x: [1, 20] },
      basis_size_max: 41,
      adapter_version: "1.1.0",
    },
    "1.2": {
      operations: ["validate", "forward", "poll", "cancel"],
      geometry: ["rectangle_1d", "rectangle_2d", "homogeneous"],
      wavelength_count: 31,
      harmonics: { x: [1, 5], y: [1, 5] },
      basis_size_max: 121,
      adapter_version: "1.2.0",
    },
  },
});
afterEach(() => vi.unstubAllGlobals());
describe("version-specific local solver support", () => {
  it("accepts the exact released profile and retained legacy forward support", () => {
    expect(solverSupportError(capabilities(), project)).toBeNull();
    expect(solverSupportError(capabilities(), defaultProject)).toBeNull();
  });
  it.each([null, {}, { engine: { available: true } }])(
    "rejects malformed capability envelopes",
    (cap) => {
      expect(solverSupportError(cap, project)).toMatch(/capabilities/);
    },
  );
  it("does not infer 2D from top-level legacy limits or engine reachability", () => {
    const cap = capabilities();
    delete (cap.project_profiles as Record<string, unknown>)["1.2"];
    expect(solverSupportError(cap, project)).toMatch(/schema 1.2/);
  });
  it.each(["not_installed", "version_mismatch"])(
    "rejects unavailable %s engine",
    (status) => {
      const cap = capabilities();
      cap.engine.available = false;
      cap.engine.status = status;
      expect(solverSupportError(cap, project)).toMatch(/unavailable/);
    },
  );
  it("rejects version/profile mismatch rather than downgrading", () => {
    const cap = capabilities();
    cap.project_profiles["1.2"].adapter_version = "unknown";
    expect(solverSupportError(cap, project)).toMatch(/incompatible/);
    cap.project_profiles["1.2"].adapter_version = "1.2.0";
    cap.supported_result_schema_versions = ["1.1"];
    expect(solverSupportError(cap, project)).toMatch(
      /does not support schema 1.2/,
    );
  });
});
describe("2D HTTP serialization and raw response boundary", () => {
  it("preserves negative zero in all nested project requests", () => {
    const p = structuredClone(project);
    p.illumination.azimuth_deg = -0;
    const body = projectRequestBody(p, { kind: "forward", project: p });
    expect(body).toContain('"azimuth_deg":-0.0');
    expect(
      Object.is(JSON.parse(body).project.illumination.azimuth_deg, -0),
    ).toBe(true);
    expect(projectRequestBody(defaultProject)).toBe(
      JSON.stringify(defaultProject),
    );
  });
  it("measures UTF-8 bytes of the entire request, including multibyte envelope fields", () => {
    const payload = { project, note: "한".repeat(670_000) };
    expect(JSON.stringify(payload).length).toBeLessThan(2_000_000);
    expect(() => projectRequestBody(project, payload)).toThrow(/2 MB limit/);
    expect(project.name).toBe(fixture.name);
  });
  it("gates raw integer spellings in successful network responses before parsing", async () => {
    vi.stubGlobal("window", globalThis);
    const bad = JSON.stringify({
      valid: true,
      project,
      input_hash: "0".repeat(64),
      diagnostics: [],
    }).replace('"harmonics_x":5', '"harmonics_x":5.0');
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bad, { status: 200 })),
    );
    await expect(api.validate(project)).rejects.toThrow(/integer/);
  });
  it("retains signed zero from a normalized API project response", async () => {
    vi.stubGlobal("window", globalThis);
    const raw = JSON.stringify({
      valid: true,
      project,
      input_hash: "0".repeat(64),
      diagnostics: [],
    }).replace('"azimuth_deg":25', '"azimuth_deg":-0.0');
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(raw, { status: 200 })),
    );
    const data = await api.validate(project);
    expect(data.project.schema_version).toBe("1.2");
    if (data.project.schema_version === "1.2")
      expect(Object.is(data.project.illumination.azimuth_deg, -0)).toBe(true);
  });
});
