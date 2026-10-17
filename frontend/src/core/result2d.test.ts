import reference from "../../public/reference-2d.json";
import circleReference from "../../public/reference-circular.json";
import circleManifest from "./fixtures/reference-circular-manifest.json";
import { parseJSONWith2DNumberGate } from "./project2d";
import { describe, expect, it, vi } from "vitest";
import type { Material } from "./model";
import type { Project2D } from "./project2d";
import { hashProject2D, normalizeProject2D } from "./project2d";
import type { PublicForwardResult2D, PublicOrderPower2D } from "./result2d";
import {
  bindResult2D,
  boundResult2DCompatibilityError,
  isForwardResult2D,
  validateForwardResult2D,
} from "./result2d";

// The sole promoted immutable result remains in public assets; do not duplicate it here.
const fixture = reference as {
  project: Project2D;
  result: PublicForwardResult2D;
};
const constant = (n: number, k = 0): Material => ({
  name: "Contract-only material",
  kind: "constant",
  n,
  k,
});

/** Artificial contract vectors only. The powers below are not numerical solver evidence. */
async function vector(edit?: (project: Project2D) => void) {
  const project = normalizeProject2D({
    schema_version: "1.2",
    period_nm: 150,
    period_y_nm: 140,
    ambient: constant(1),
    substrate: constant(1.5),
    layers: [
      {
        geometry: "rectangle_2d",
        thickness_nm: 100,
        cd_x_nm: 70,
        cd_y_nm: 60,
        material: constant(2),
        background: constant(1),
      },
    ],
    illumination: {
      wavelengths_nm: [600],
      angle_deg: 0,
      azimuth_deg: 0,
      polarization: "s",
    },
    solver: { harmonics_x: 1, harmonics_y: 1 },
  });
  edit?.(project);
  const labels: [number, number][] = [];
  for (let n = -1; n <= 1; n++)
    for (let m = -1; m <= 1; m++) labels.push([m, n]);
  const orders: PublicOrderPower2D[] = labels.map(([m, n]) => {
    const x = (m * 600) / project.period_nm,
      y = (n * 600) / project.period_y_nm;
    const reflection = 1 - x * x - y * y > 0;
    const transmission = project.substrate.n ** 2 - x * x - y * y > 0;
    const absorbing = project.substrate.k !== 0;
    const zero = m === 0 && n === 0;
    return {
      m,
      n,
      R: zero ? 0.2 : 0,
      T: zero ? 0.8 : 0,
      R_s: zero ? 0.2 : 0,
      R_p: 0,
      T_s: zero ? 0.8 : 0,
      T_p: 0,
      kx_over_k0: x,
      ky_over_k0: y,
      reflection_propagating: reflection,
      transmission_propagating: absorbing ? null : transmission,
      transmission_class: absorbing
        ? "absorbing_half_space"
        : transmission
          ? "propagating"
          : "evanescent",
    };
  });
  const result: PublicForwardResult2D = {
    result_type: "forward",
    schema_version: "1.2",
    wavelengths_nm: [600],
    spectra: {
      s: {
        R: [0.2],
        T: [0.8],
        R_specular: [0.2],
        T_specular: [0.8],
        A_balance: [0],
        orders: [orders],
      },
    },
    metadata: {
      ...structuredClone(fixture.result.metadata),
      input_hash: await hashProject2D(project),
      harmonics_x: 1,
      harmonics_y: 1,
      basis_size: 9,
      retained_orders: labels,
      layer_count: project.layers.length,
      active_slab_count: project.layers.filter((l) => l.thickness_nm > 0)
        .length,
      total_thickness_nm: project.layers.reduce(
        (sum, l) => sum + l.thickness_nm,
        0,
      ),
      max_lossless_flux_error: 0,
    },
    warnings: ["Artificial contract-only vector; no numerical certification."],
  };
  return { project, result };
}
function set(
  value: unknown,
  path: (string | number)[],
  replacement: unknown,
): void {
  let target = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1))
    target = target[key] as Record<string | number, unknown>;
  target[path[path.length - 1]] = replacement;
}
const first = (result: PublicForwardResult2D) => result.spectra.s!.orders[0][0];
const zero = (result: PublicForwardResult2D) => result.spectra.s!.orders[0][4];
function setPower(result: PublicForwardResult2D, R: number, T: number) {
  const s = result.spectra.s!;
  s.R[0] = s.R_specular[0] = zero(result).R = zero(result).R_s = R;
  s.T[0] = s.T_specular[0] = zero(result).T = zero(result).T_s = T;
  s.A_balance[0] = 1 - R - T;
}

describe("strict public 1.2 result contract", () => {
  it("validates and binds the full immutable reference without claiming provenance", async () => {
    expect(isForwardResult2D(fixture.result)).toBe(true);
    const bound = await bindResult2D(fixture.project, fixture.result);
    expect(bound).toEqual(fixture.result);
    expect(boundResult2DCompatibilityError(fixture.project, bound)).toBeNull();
    expect(bound.metadata.convergence_checked).toBe(false);
    expect(bound).not.toHaveProperty("provenance");
  });
  const corruptions: [string, (string | number)[], unknown][] = [
    ["missing discriminator", ["result_type"], undefined],
    ["legacy version", ["schema_version"], "1.1"],
    ["unknown root key", ["unexpected"], true],
    ["unknown metadata key", ["metadata", "extra"], true],
    ...Object.entries({
      stage: "certified",
      engine: "other",
      version: "0.13.3",
      adapter_version: "1.1.0",
      precision: "complex64",
      backend: "torch",
      offline_reference_override: true,
      factorization: "diagnostic_laurent",
      convergence_checked: true,
      stack_order: "bottom_to_top",
      units: "um",
    }).map(([key, value]): [string, string[], unknown] => [
      `unsupported ${key}`,
      ["metadata", key],
      value,
    ]),
    ["invalid hash", ["metadata", "input_hash"], "A".repeat(64)],
    ["zero x basis", ["metadata", "harmonics_x"], 0],
    ["offline y basis", ["metadata", "harmonics_y"], 6],
    ["fractional basis", ["metadata", "harmonics_x"], 1.5],
    ["coerced basis", ["metadata", "harmonics_x"], "1"],
    ["boolean basis", ["metadata", "basis_size"], true],
    ["basis mismatch", ["metadata", "basis_size"], 25],
    ["retained label mismatch", ["metadata", "retained_orders", 0, 0], 0],
    ["retained fractional label", ["metadata", "retained_orders", 0, 1], -0.5],
    ["retained pair width", ["metadata", "retained_orders", 0], [-1, -1, 0]],
    ["layer count zero", ["metadata", "layer_count"], 0],
    ["fractional slabs", ["metadata", "active_slab_count"], 0.5],
    ["negative thickness", ["metadata", "total_thickness_nm"], -1],
    ["excess thickness", ["metadata", "total_thickness_nm"], 16001],
    ["negative elapsed", ["metadata", "elapsed_seconds"], -1],
    ["large flux metadata", ["metadata", "max_lossless_flux_error"], 1.0001e-6],
    ["nonfinite flux metadata", ["metadata", "max_lossless_flux_error"], NaN],
    ["invalid Unicode", ["metadata", "geometry"], "bad\ud800"],
    ["numeric string field", ["metadata", "regularization"], 1],
    ["numeric warning", ["warnings", 0], 1],
    ["lone low surrogate", ["warnings", 0], "\udc00"],
    ["empty wavelengths", ["wavelengths_nm"], []],
    ["out of range wavelength", ["wavelengths_nm", 0], 199],
    ["repeated wavelength", ["wavelengths_nm"], [600, 600]],
    [
      "excess wavelengths",
      ["wavelengths_nm"],
      Array.from({ length: 32 }, (_, i) => 600 + i),
    ],
    ["empty spectra", ["spectra"], {}],
    ["unknown polarization", ["spectra", "q"], {}],
    ["missing spectrum array", ["spectra", "s", "T"], undefined],
    ["spectrum length", ["spectra", "s", "R"], [0.2, 0.2]],
    ["nonfinite total", ["spectra", "s", "R", 0], Infinity],
    ["coerced total", ["spectra", "s", "R", 0], "0.2"],
    ["wrong total", ["spectra", "s", "R", 0], 0.3],
    ["wrong specular", ["spectra", "s", "T_specular", 0], 0.7],
    ["wrong balance", ["spectra", "s", "A_balance", 0], 0.1],
    ["missing order", ["spectra", "s", "orders", 0], []],
    ["unknown order key", ["spectra", "s", "orders", 0, 0, "extra"], true],
    ["fractional order label", ["spectra", "s", "orders", 0, 0, "m"], -0.5],
    ["wrong order label", ["spectra", "s", "orders", 0, 0, "n"], 0],
    [
      "nonfinite wavevector",
      ["spectra", "s", "orders", 0, 0, "ky_over_k0"],
      NaN,
    ],
    ["negative channel", ["spectra", "s", "orders", 0, 0, "R_s"], -1.001e-8],
    ["negative order", ["spectra", "s", "orders", 0, 0, "T"], -1.001e-8],
    ["channel sum", ["spectra", "s", "orders", 0, 4, "R_p"], 0.01],
    [
      "reflection flag",
      ["spectra", "s", "orders", 0, 0, "reflection_propagating"],
      0,
    ],
    [
      "unknown transmission class",
      ["spectra", "s", "orders", 0, 0, "transmission_class"],
      "unknown",
    ],
    [
      "transmission flag mismatch",
      ["spectra", "s", "orders", 0, 0, "transmission_propagating"],
      true,
    ],
  ];
  it.each(corruptions)("rejects %s", async (_label, path, value) => {
    const { result } = await vector();
    set(result, path, value);
    expect(isForwardResult2D(result)).toBe(false);
    expect(() => validateForwardResult2D(result)).toThrow(
      /^Invalid 1.2 result:/,
    );
  });
  it("rejects sparse arrays, accessors, foreign prototypes and symbol fields", async () => {
    const { result } = await vector();
    const hole = structuredClone(result);
    delete hole.spectra.s!.R[0];
    expect(isForwardResult2D(hole)).toBe(false);
    const accessor = structuredClone(result);
    Object.defineProperty(accessor.metadata, "stage", {
      get: () => "bounded_forward",
    });
    expect(isForwardResult2D(accessor)).toBe(false);
    const prototype = structuredClone(result);
    Object.setPrototypeOf(prototype.metadata, { inherited: true });
    expect(isForwardResult2D(prototype)).toBe(false);
    const symbol = structuredClone(result);
    Object.defineProperty(symbol, Symbol("hidden"), { value: true });
    expect(isForwardResult2D(symbol)).toBe(false);
  });
  it("does not invent string limits and keeps helpful errors bounded", async () => {
    const { result } = await vector();
    result.metadata.geometry = "e\u0301🧪".repeat(1000);
    expect(isForwardResult2D(result)).toBe(true);
    set(result, ["unexpected".repeat(10000)], true);
    expect(() => validateForwardResult2D(result)).toThrow(/unknown fields/);
    try {
      validateForwardResult2D(result);
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(250);
    }
  });
  it("keeps power, passive balance and consistency tolerances distinct", async () => {
    const { result } = await vector();
    first(result).R = first(result).R_s = -1e-8;
    result.spectra.s!.R[0] -= 1e-8;
    result.spectra.s!.A_balance[0] =
      1 - result.spectra.s!.R[0] - result.spectra.s!.T[0];
    expect(isForwardResult2D(result)).toBe(true);
    first(result).R = first(result).R_s = -1.0001e-8;
    expect(isForwardResult2D(result)).toBe(false);
    const passive = (await vector()).result;
    setPower(passive, 0.2, 0.8000005);
    expect(isForwardResult2D(passive)).toBe(true);
    setPower(passive, 0.2, 0.8000011);
    expect(isForwardResult2D(passive)).toBe(false);
    const absolute = (await vector()).result;
    absolute.spectra.s!.R_specular[0] += 0.9e-9;
    expect(isForwardResult2D(absolute)).toBe(true);
    absolute.spectra.s!.R_specular[0] += 0.2e-9;
    expect(isForwardResult2D(absolute)).toBe(false);
  });
});

describe("exact project/result binding", () => {
  it.each([
    [
      "input hash",
      (p: Project2D) => {
        p.name += " changed";
      },
      false,
    ],
    [
      "basis",
      (p: Project2D) => {
        p.solver.harmonics_x = 2;
      },
      true,
    ],
    [
      "wavelengths",
      (p: Project2D) => {
        p.illumination.wavelengths_nm = [610];
      },
      true,
    ],
    [
      "polarizations",
      (p: Project2D) => {
        p.illumination.polarization = "both";
      },
      true,
    ],
    [
      "layer count",
      (p: Project2D) => {
        p.layers.push(structuredClone(p.layers[0]));
      },
      true,
    ],
    [
      "active slabs",
      (p: Project2D) => {
        p.layers[0].thickness_nm = 0;
      },
      true,
    ],
    [
      "thickness",
      (p: Project2D) => {
        p.layers[0].thickness_nm += 1;
      },
      true,
    ],
    [
      "kx",
      (p: Project2D) => {
        p.period_nm += 1;
      },
      true,
    ],
    [
      "ky",
      (p: Project2D) => {
        p.period_y_nm += 1;
      },
      true,
    ],
    [
      "azimuth",
      (p: Project2D) => {
        p.illumination.angle_deg = 20;
        p.illumination.azimuth_deg = 60;
      },
      true,
    ],
  ] as const)(
    "rejects changed %s even with a rehashed envelope",
    async (_label, edit, rehash) => {
      const { project, result } = await vector();
      edit(project);
      if (rehash) result.metadata.input_hash = await hashProject2D(project);
      expect(isForwardResult2D(result)).toBe(true);
      await expect(bindResult2D(project, result)).rejects.toThrow();
      expect(boundResult2DCompatibilityError(project, result)).not.toBeNull();
    },
  );
  it("rejects independently corrupted reflection and transmission classifications", async () => {
    const { project, result } = await vector();
    first(result).reflection_propagating = true;
    expect(isForwardResult2D(result)).toBe(true);
    await expect(bindResult2D(project, result)).rejects.toThrow(
      /Reflection classification/,
    );
    first(result).reflection_propagating = false;
    first(result).transmission_class = "propagating";
    first(result).transmission_propagating = true;
    expect(isForwardResult2D(result)).toBe(true);
    await expect(bindResult2D(project, result)).rejects.toThrow(
      /Transmission classification/,
    );
  });
  it("rejects evanescent normal power at 1e-9", async () => {
    const { project, result } = await vector();
    first(result).R = first(result).R_s = 2e-9;
    result.spectra.s!.R[0] += 2e-9;
    result.spectra.s!.A_balance[0] =
      1 - result.spectra.s!.R[0] - result.spectra.s!.T[0];
    result.metadata.max_lossless_flux_error = Math.abs(
      result.spectra.s!.A_balance[0],
    );
    expect(isForwardResult2D(result)).toBe(true);
    await expect(bindResult2D(project, result)).rejects.toThrow(/Evanescent/);
  });
  it("treats absorbing substrate as entrance flux, separately from finite-stack loss", async () => {
    const { project, result } = await vector((p) => {
      p.substrate.k = 0.1;
    });
    await expect(bindResult2D(project, result)).resolves.toBeDefined();
    result.metadata.max_lossless_flux_error = null;
    await expect(bindResult2D(project, result)).rejects.toThrow(
      /Lossless finite stacks/,
    );
    result.metadata.max_lossless_flux_error = 0;
    setPower(result, 0.2, 0.7);
    await expect(bindResult2D(project, result)).rejects.toThrow(
      /Lossless flux tolerance/,
    );
  });
  it.each(["inclusion", "background", "homogeneous"])(
    "requires null lossless metadata for active %s loss",
    async (region) => {
      const { project, result } = await vector((p) => {
        if (region === "homogeneous")
          p.layers = [
            {
              name: "Lossy film",
              geometry: "homogeneous",
              thickness_nm: 100,
              material: constant(2, 0.1),
            },
          ];
        else {
          const layer = p.layers[0];
          if (layer.geometry !== "rectangle_2d") throw new Error("fixture");
          (region === "inclusion" ? layer.material : layer.background).k = 0.1;
        }
      });
      await expect(bindResult2D(project, result)).rejects.toThrow(
        /Lossy finite stacks/,
      );
      result.metadata.max_lossless_flux_error = null;
      setPower(result, 0.2, 0.7);
      await expect(bindResult2D(project, result)).resolves.toBeDefined();
    },
  );
  it.each([
    "zero thickness",
    "zero x width",
    "zero y width",
    "full widths",
    "1d zero width",
    "1d full width",
  ])("ignores unused absorbing regions for %s", async (kind) => {
    const { project, result } = await vector((p) => {
      const layer = p.layers[0];
      if (layer.geometry !== "rectangle_2d") throw new Error("fixture");
      if (kind === "zero thickness") {
        layer.thickness_nm = 0;
        layer.material.k = layer.background.k = 0.1;
      }
      if (kind === "zero x width") {
        layer.cd_x_nm = 0;
        layer.material.k = 0.1;
      }
      if (kind === "zero y width") {
        layer.cd_y_nm = 0;
        layer.material.k = 0.1;
      }
      if (kind === "full widths") {
        layer.cd_x_nm = p.period_nm;
        layer.cd_y_nm = p.period_y_nm;
        layer.background.k = 0.1;
      }
      if (kind.startsWith("1d"))
        p.layers = [
          {
            name: "1D in 1.2",
            geometry: "rectangle_1d",
            thickness_nm: 100,
            cd_nm: kind === "1d zero width" ? 0 : p.period_nm,
            material: constant(2, kind === "1d zero width" ? 0.1 : 0),
            background: constant(1, kind === "1d full width" ? 0.1 : 0),
          },
        ];
    });
    await expect(bindResult2D(project, result)).resolves.toBeDefined();
    result.metadata.max_lossless_flux_error = null;
    await expect(bindResult2D(project, result)).rejects.toThrow(
      /Lossless finite stacks/,
    );
  });
  it("checks coverage of inactive declared material tables", async () => {
    const { project, result } = await vector();
    project.layers[0].thickness_nm = 0;
    project.layers[0].material = {
      name: "Inactive uncovered table",
      kind: "tabulated",
      n: 2,
      k: 0,
      wavelengths_nm: [700, 800],
      n_values: [2, 2],
      k_values: [0.1, 0.1],
    };
    await expect(bindResult2D(project, result)).rejects.toThrow();
  });
  it("interpolates n and k separately and detects loss between endpoints", async () => {
    const { project, result } = await vector((p) => {
      p.period_nm = 500;
      p.layers[0].material = {
        name: "Interpolated loss",
        kind: "tabulated",
        n: 1,
        k: 0,
        wavelengths_nm: [500, 700],
        n_values: [1.5, 2.5],
        k_values: [0, 0.2],
      };
      p.substrate = {
        name: "Interpolated port",
        kind: "tabulated",
        n: 1,
        k: 0,
        wavelengths_nm: [500, 700],
        n_values: [1, 2],
        k_values: [0, 0],
      };
    });
    // At 600 nm the port n is 1.5, not the ignored scalar placeholder n=1.
    // The axial x=1.2 order therefore transmits, making interpolation observable.
    for (const order of result.spectra.s!.orders[0]) {
      const propagating =
        1.5 ** 2 - order.kx_over_k0 ** 2 - order.ky_over_k0 ** 2 > 0;
      order.transmission_propagating = propagating;
      order.transmission_class = propagating ? "propagating" : "evanescent";
    }
    expect(result.spectra.s!.orders[0][5].transmission_propagating).toBe(true);
    result.metadata.max_lossless_flux_error = null;
    await expect(bindResult2D(project, result)).resolves.toBeDefined();
    result.metadata.max_lossless_flux_error = 0;
    await expect(bindResult2D(project, result)).rejects.toThrow(
      /Lossy finite stacks/,
    );
  });
  it.each([599.999999, 600.000001])(
    "classifies cutoff-adjacent orders strictly at period %s",
    async (period) => {
      const { project, result } = await vector((p) => {
        p.period_nm = period;
        p.substrate.n = 1;
      });
      const axial = result.spectra.s!.orders[0][5];
      expect(axial.reflection_propagating).toBe(period > 600);
      expect(axial.transmission_class).toBe(
        period > 600 ? "propagating" : "evanescent",
      );
      await expect(bindResult2D(project, result)).resolves.toBeDefined();
      axial.reflection_propagating = !axial.reflection_propagating;
      await expect(bindResult2D(project, result)).rejects.toThrow(
        /Reflection classification/,
      );
    },
  );
  it("refuses either classification at an exact cutoff with project-only recovery", async () => {
    const { project, result } = await vector((p) => {
      p.period_nm = 600;
      p.substrate.n = 1;
    });
    const axial = result.spectra.s!.orders[0][5];
    for (const propagating of [false, true]) {
      axial.reflection_propagating = propagating;
      axial.transmission_propagating = propagating;
      axial.transmission_class = propagating ? "propagating" : "evanescent";
      await expect(bindResult2D(project, result)).rejects.toThrow(
        /ambiguous at a Rayleigh cutoff; import the project without its result/,
      );
      expect(boundResult2DCompatibilityError(project, result)).not.toBeNull();
    }
  });
  it("registers only the returned frozen identity and rejects copied snapshots", async () => {
    const { project, result } = await vector();
    expect(boundResult2DCompatibilityError(project, result)).not.toBeNull();
    const bound = await bindResult2D(project, result);
    expect(bound).not.toBe(result);
    expect(Object.isFrozen(bound.metadata.retained_orders[0])).toBe(true);
    expect(Object.isFrozen(bound.spectra.s!.orders[0][0])).toBe(true);
    expect(boundResult2DCompatibilityError(project, bound)).toBeNull();
    expect(
      boundResult2DCompatibilityError(structuredClone(project), bound),
    ).toBeNull();
    expect(boundResult2DCompatibilityError(project, result)).not.toBeNull();
    expect(
      boundResult2DCompatibilityError(
        project,
        Object.freeze(structuredClone(bound)),
      ),
    ).not.toBeNull();
    result.spectra.s!.R[0] = 9;
    expect(bound.spectra.s!.R[0]).toBe(0.2);
    project.illumination.azimuth_deg = -0;
    expect(boundResult2DCompatibilityError(project, bound)).toMatch(
      /different project/,
    );
  });
  it("uses relative as well as absolute tolerance when binding determined numbers", async () => {
    const { project, result } = await vector();
    result.metadata.total_thickness_nm += 0.9e-7;
    first(result).kx_over_k0 -= 3e-9;
    await expect(bindResult2D(project, result)).resolves.toBeDefined();
    result.metadata.total_thickness_nm += 0.2e-7;
    await expect(bindResult2D(project, result)).rejects.toThrow(
      /Total thickness/,
    );
    result.metadata.total_thickness_nm = 100;
    first(result).kx_over_k0 -= 2e-9;
    await expect(bindResult2D(project, result)).rejects.toThrow(/Order kx/);
  });
  it("normalizes signed-zero integers only on the returned snapshot", async () => {
    const { project, result } = await vector((p) => {
      p.layers[0].thickness_nm = 0;
    });
    result.metadata.active_slab_count = -0;
    result.metadata.retained_orders[4] = [-0, -0];
    zero(result).m = zero(result).n = -0;
    zero(result).kx_over_k0 = -0;
    const bound = await bindResult2D(project, result);
    expect(Object.is(bound.metadata.active_slab_count, -0)).toBe(false);
    expect(Object.is(bound.metadata.retained_orders[4][0], -0)).toBe(false);
    expect(Object.is(zero(bound).m, -0)).toBe(false);
    expect(Object.is(zero(bound).n, -0)).toBe(false);
    expect(Object.is(zero(bound).kx_over_k0, -0)).toBe(true);
    expect(Object.is(zero(result).m, -0)).toBe(true);
  });
  it("captures immutable inputs before async digest", async () => {
    const { project, result } = await vector();
    const originalProject = structuredClone(project);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const spy = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async (...args) => {
        await gate;
        return digest(...args);
      });
    try {
      const pending = bindResult2D(project, result);
      project.name = "Changed while hashing";
      result.metadata.input_hash = "0".repeat(64);
      result.spectra.s!.R[0] = 9;
      resume();
      const bound = await pending;
      expect(bound.spectra.s!.R[0]).toBe(0.2);
      expect(
        boundResult2DCompatibilityError(originalProject, bound),
      ).toBeNull();
      expect(boundResult2DCompatibilityError(project, bound)).toMatch(
        /different project/,
      );
    } finally {
      resume();
      spy.mockRestore();
    }
  });
});

describe("circle public result identity and active-material limits", () => {
  it("binds the genuine new stored circular result to its own exact input hash", async () => {
    const p = normalizeProject2D(circleReference.project);
    expect(await hashProject2D(p)).toBe(circleManifest.input_hash);
    const result = await bindResult2D(p, circleReference.result);
    expect(result).toBeDefined();
    expect(circleReference.result.metadata.adapter_version).toBe("1.3.0");
    expect(circleReference.result.metadata.convergence_checked).toBe(false);
    expect(circleReference.result.metadata.input_hash).not.toBe(
      fixture.result.metadata.input_hash,
    );
    const raw = JSON.stringify(circleReference);
    expect(() =>
      parseJSONWith2DNumberGate(raw.replace('"strips":64', '"strips":64.0')),
    ).toThrow(/integer JSON token/);
    expect(() =>
      parseJSONWith2DNumberGate(
        raw.replace('"layer_index":0', '"layer_index":0.0'),
      ),
    ).toThrow(/integer JSON token/);
  });
  async function circularVector(
    diameter = 70,
    thickness = 90,
    holeK = 0,
    hostK = 0,
  ) {
    const pair = await vector((p) => {
      p.layers = [
        {
          geometry: "circular_hole_2d",
          name: "Circle contract-only fixture",
          diameter_nm: diameter,
          thickness_nm: thickness,
          material: constant(1, holeK),
          background: constant(2, hostK),
        },
      ];
    });
    let sum = 0;
    for (let i = 0; i < 64; i++) {
      const y = (i + 0.5) / 64 - 0.5;
      sum += diameter * Math.sqrt(1 - 4 * y * y);
    }
    pair.result.metadata.adapter_version = "1.3.0";
    pair.result.metadata.circular_geometry = {
      method: "centered_midpoint_strips",
      strips: 64,
      offline_spatial_override: false,
      area_bound_is_optical_error_bound: false,
      layers: [
        {
          layer_index: 0,
          exact_area_nm2: Math.PI * (diameter / 2) ** 2,
          approximate_area_nm2: (sum * diameter) / 64,
          symmetric_difference_area_bound_nm2:
            diameter ** 2 / 64 +
            64 *
              Number.EPSILON *
              pair.project.period_nm *
              pair.project.period_y_nm,
        },
      ],
    };
    return pair;
  }
  it("binds disclosed circle metadata, and refuses historical adapter or missing/mismatched circle metadata", async () => {
    const { project, result } = await circularVector();
    await expect(bindResult2D(project, result)).resolves.toBeDefined();
    const old = structuredClone(result);
    old.metadata.adapter_version = "1.2.0";
    await expect(bindResult2D(project, old)).rejects.toThrow(/adapter/);
    const missing = structuredClone(result);
    delete missing.metadata.circular_geometry;
    await expect(bindResult2D(project, missing)).rejects.toThrow(
      /Circular geometry metadata/,
    );
    const wrong = structuredClone(result);
    wrong.metadata.circular_geometry!.layers[0].approximate_area_nm2 += 1;
    await expect(bindResult2D(project, wrong)).rejects.toThrow(
      /Circular approximate area/,
    );
  });
  it("rejects offline spatial refinements and optical-error claims in public results", async () => {
    const { result } = await circularVector();
    for (const patch of [
      { strips: 128 },
      { offline_spatial_override: true },
      { area_bound_is_optical_error_bound: true },
    ]) {
      const candidate = structuredClone(result);
      Object.assign(candidate.metadata.circular_geometry!, patch);
      expect(() => validateForwardResult2D(candidate)).toThrow(
        /discretization|convergence/,
      );
    }
  });
  it("retains absorbing host corners at maximum diameter, even with square pitch", async () => {
    const { project, result } = await circularVector(140, 90, 0, 0.01);
    project.period_nm = 140;
    result.metadata.input_hash = await hashProject2D(project);
    result.metadata.circular_geometry!.layers[0].symmetric_difference_area_bound_nm2 =
      140 ** 2 / 64 + 64 * Number.EPSILON * 140 * 140;
    // Rebuild expected order vectors for the changed pitch, retaining artificial contract powers.
    for (const order of result.spectra.s!.orders[0])
      order.kx_over_k0 = (order.m * 600) / 140;
    await expect(bindResult2D(project, result)).rejects.toThrow(/lossless/);
    result.metadata.max_lossless_flux_error = null;
    await expect(bindResult2D(project, result)).resolves.toBeDefined();
  });
  it("ignores zero-diameter hole loss and zero-thickness layer loss", async () => {
    for (const pair of [
      await circularVector(0, 90, 0.1, 0),
      await circularVector(70, 0, 0.1, 0.1),
    ])
      await expect(
        bindResult2D(pair.project, pair.result),
      ).resolves.toBeDefined();
  });
});
