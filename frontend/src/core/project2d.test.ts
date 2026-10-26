import { describe, expect, it } from "vitest";
import legacyReference from "./fixtures/legacy-reference.json";
import { parseProjectFile } from "./projectFile";
import vectors from "./fixtures/project-2d-conformance.json";
import { normalizeProject2D, parseJSONWith2DNumberGate } from "./project2d";

const minimal = {
  schema_version: "1.2",
  period_nm: 300,
  period_y_nm: 350,
  layers: [
    {
      geometry: "rectangle_2d",
      cd_x_nm: 70,
      cd_y_nm: 60,
      material: {},
      background: {},
    },
  ],
  illumination: { wavelengths_nm: [500] },
};
const parse = (text: string) =>
  normalizeProject2D(parseJSONWith2DNumberGate(text));
const azimuths = (value: unknown): unknown[] =>
  value && typeof value === "object"
    ? Object.entries(value).flatMap(([k, v]) =>
        k === "azimuth_deg" ? [v] : azimuths(v),
      )
    : [];

describe("unchanged Python schema-1.2 authority", () => {
  it("uses pinned backend-normalized projects, without numerical solves", () => {
    expect(vectors.authority.pydantic).toBe("2.12.5");
    expect(vectors.authority.solves).toBe(0);
  });
  for (const vector of vectors.projects) {
    it(vector.name, () => {
      if (vector.accepted)
        expect(parse(vector.raw)).toStrictEqual(JSON.parse(vector.canonical!));
      else expect(() => parse(vector.raw)).toThrow();
    });
  }
});

describe("schema-1.2 raw-number gate on files and every network envelope", () => {
  const wraps = [
    (p: string) => p,
    (p: string) => `{"project":${p}}`,
    (p: string) => `{"project":${p},"result_project":${p}}`,
    (p: string) => `{"validation":{"project":${p},"input_hash":"abc"}}`,
    (p: string) => `{"snapshot":{"project":${p},"result":null}}`,
    (p: string) => `{"snapshot":{"project":${p},"result_project":${p}}}`,
  ];
  for (const token of ["3.0", "3e0", "3E+0"]) {
    it(`rejects integer spelling ${token} at the correct nested project path`, () => {
      const source =
        JSON.stringify(minimal).slice(0, -1) +
        `,"solver":{"harmonics_x":${token}}}`;
      for (const wrap of wraps)
        expect(() => parseJSONWith2DNumberGate(wrap(source))).toThrow(
          /integer JSON token/,
        );
    });
  }
  it("distinguishes -0 integer origin from -0.0/-0e0 and underflow for float fields", () => {
    for (const wrap of wraps) {
      for (const token of ["-0", "-0.0", "-0e0", "-1e-999"]) {
        const source = JSON.stringify(minimal).replace(
          '"wavelengths_nm":[500]',
          `"azimuth_deg":${token},"wavelengths_nm":[500]`,
        );
        const found = azimuths(parseJSONWith2DNumberGate(wrap(source)));
        expect(found.length).toBeGreaterThan(0);
        for (const value of found)
          expect(Object.is(value, -0)).toBe(token !== "-0");
      }
    }
  });
  const result = (token: string, field: string) => {
    const value: Record<string, unknown> = {
      schema_version: "1.2",
      result_type: "forward",
      metadata: {},
      spectra: { s: { orders: [[{ m: 0, n: 0 }]] } },
    };
    if (field.startsWith("metadata"))
      value.metadata = { [field.slice(9)]: "TOKEN" };
    else value.spectra = { s: { orders: [[{ [field]: "TOKEN" }]] } };
    return JSON.stringify(value).replace('"TOKEN"', token);
  };
  for (const field of [
    "metadata.harmonics_x",
    "metadata.harmonics_y",
    "metadata.basis_size",
    "metadata.layer_count",
    "metadata.active_slab_count",
    "m",
    "n",
  ]) {
    it(`checks result integer path ${field} in direct, job, and snapshot payloads`, () => {
      for (const token of ["3.0", "3e0"]) {
        const r = result(token, field);
        for (const source of [
          r,
          `{"result":${r}}`,
          `{"job":{"result":${r}}}`,
          `{"snapshot":{"result":${r}}}`,
        ])
          expect(() => parseJSONWith2DNumberGate(source)).toThrow(
            /integer JSON token/,
          );
      }
    });
  }
  it("does not let a surrounding version marker hide nested project/result integer paths", () => {
    const project =
      JSON.stringify(minimal).slice(0, -1) + ',"solver":{"harmonics_x":3.0}}';
    expect(() =>
      parseJSONWith2DNumberGate(
        `{"schema_version":"1.2","project":${project}}`,
      ),
    ).toThrow(/integer JSON token/);
    expect(() =>
      parseJSONWith2DNumberGate(
        `{"schema_version":"1.2","result":${result("3e0", "m")}}`,
      ),
    ).toThrow(/integer JSON token/);
  });
  it("checks both retained-order label columns", () => {
    for (const labels of ["[[0.0,1]]", "[[0,1e0]]"])
      expect(() =>
        parseJSONWith2DNumberGate(
          `{"schema_version":"1.2","metadata":{"retained_orders":${labels}}}`,
        ),
      ).toThrow(/integer JSON token/);
  });
  it("recognizes escaped names and ignores quoted number-looking text", () => {
    const raw =
      JSON.stringify(minimal).slice(0, -1) +
      ',"name":"3e0 \\" -0","solver":{"harmonics_\\u0078":3e0}}';
    expect(() => parseJSONWith2DNumberGate(raw)).toThrow(/integer JSON token/);
    expect(
      parse(JSON.stringify({ ...minimal, name: '3e0 " -0 \\ [3.0]' })).name,
    ).toBe('3e0 " -0 \\ [3.0]');
  });
  it("rejects duplicate members fail-closed, including escaped equivalent names", () => {
    for (const tail of [
      ',"solver":{"harmonics_x":3.0,"harmonics_x":3}}',
      ',"solver":{"harmonics_x":3,"harmonics_\\u0078":3.0}}',
    ])
      expect(() =>
        parseJSONWith2DNumberGate(JSON.stringify(minimal).slice(0, -1) + tail),
      ).toThrow(/duplicate member/);
  });
  it("retains legacy file import when ignored metadata claims schema 1.2", () => {
    const original = JSON.stringify(legacyReference);
    const baseline = parseProjectFile(original);
    for (const ignored of [
      '{"schema_version":"1.2","solver":{"harmonics_x":3.0}}',
      '{"schema_version":"1.2","n":1,"n":2}',
      '{"schema_version":"1.2","value":' +
        "[".repeat(100) +
        "0" +
        "]".repeat(100) +
        "}",
    ]) {
      const text = original.slice(0, -1) + ',"ignored":' + ignored + "}";
      expect(parseJSONWith2DNumberGate(text)).toEqual(JSON.parse(text));
      expect(parseProjectFile(text)).toEqual(baseline);
    }
  });
  it("uses envelope project dispatch rather than an ignored outer version marker", () => {
    const raw =
      JSON.stringify(legacyReference).slice(0, -1) +
      ',"schema_version":"1.2","ignored":{"n":1,"n":2}}';
    expect(parseProjectFile(raw)).toEqual(
      parseProjectFile(JSON.stringify(legacyReference)),
    );
    const invalid =
      JSON.stringify(minimal).slice(0, -1) + ',"solver":{"harmonics_x":3.0}}';
    expect(() =>
      parseJSONWith2DNumberGate(
        `{"schema_version":"1.2","project":${invalid}}`,
      ),
    ).toThrow(/integer JSON token/);
  });
  it("does not validate ignored metadata even beside a genuine 1.2 project", () => {
    const ignored =
      '{"schema_version":"1.2","solver":{"harmonics_x":3e0},"n":1,"n":2,"deep":' +
      "[".repeat(100) +
      "0" +
      "]".repeat(100) +
      "}";
    const raw = `{"project":${JSON.stringify(minimal)},"ignored":${ignored}}`;
    expect(parseJSONWith2DNumberGate(raw)).toEqual(JSON.parse(raw));
    expect(parseProjectFile(raw).design.schema_version).toBe("1.2");
  });
  it("keeps duplicate-member behavior of unrelated envelope fields", () => {
    const raw = `{"project":${JSON.stringify(minimal)},"ignored":1,"ignored":2}`;
    expect(parseJSONWith2DNumberGate(raw)).toEqual(JSON.parse(raw));
  });
  it("does not impose the 1.2 depth limit on legacy-only parsing", () => {
    const text = "[".repeat(500) + '{"schema_version":"1.0"}' + "]".repeat(500);
    expect(() => parseJSONWith2DNumberGate(text)).not.toThrow();
  });
  it("leaves legacy-only raw number and duplicate-member semantics untouched", () => {
    const raw =
      '{"schema_version":"1.0","solver":{"harmonics":3.0},"x":1,"x":2,"zero":-0}';
    expect(parseJSONWith2DNumberGate(raw)).toEqual(JSON.parse(raw));
    expect(
      Object.is((parseJSONWith2DNumberGate(raw) as { zero: number }).zero, -0),
    ).toBe(true);
  });
});

describe("strict defaults, Unicode, and signed zero", () => {
  it("normalizes defaults without mutating the caller", () => {
    const input = structuredClone(minimal);
    const normalized = normalizeProject2D(input);
    expect(input).toEqual(minimal);
    expect(normalized.solver).toEqual({ harmonics_x: 3, harmonics_y: 3 });
    expect(normalized.illumination.azimuth_deg).toBe(0);
    expect(normalized.layers[0].thickness_nm).toBe(90);
  });
  it("rejects explicit null where omission defaults, unknown keys, coercions, and required missing values", () => {
    for (const value of [
      { ...minimal, name: null },
      { ...minimal, ambient: null },
      { ...minimal, solver: null },
      { ...minimal, illumination: {} },
      { ...minimal, period_nm: "300" },
      { ...minimal, solver: { harmonics_x: true } },
      { ...minimal, extra: 0 },
      {
        ...minimal,
        layers: [{ geometry: "rectangle_2d", cd_x_nm: 3, cd_y_nm: 4 }],
      },
    ])
      expect(() => normalizeProject2D(value)).toThrow();
  });
  it("rejects sparse arrays, custom object prototypes, and accessors before normalization", () => {
    expect(() =>
      normalizeProject2D({ ...minimal, layers: new Array(1) }),
    ).toThrow(/dense JSON/);
    expect(() =>
      normalizeProject2D({
        ...minimal,
        illumination: { wavelengths_nm: new Array(1) },
      }),
    ).toThrow(/dense JSON/);
    expect(() =>
      normalizeProject2D(Object.assign(Object.create({ x: 1 }), minimal)),
    ).toThrow(/plain JSON/);
    const accessor = { ...minimal };
    Object.defineProperty(accessor, "name", {
      get: () => "name",
      enumerable: true,
    });
    expect(() => normalizeProject2D(accessor)).toThrow(/accessors/);
  });
  it("counts Unicode code points without trimming or Unicode normalization", () => {
    expect(normalizeProject2D({ ...minimal, name: " " }).name).toBe(" ");
    expect(
      normalizeProject2D({ ...minimal, name: "🧪".repeat(100) }).name.length,
    ).toBe(200);
    expect(() =>
      normalizeProject2D({ ...minimal, name: "🧪".repeat(101) }),
    ).toThrow();
    expect(normalizeProject2D({ ...minimal, name: "e\u0301" }).name).toBe(
      "e\u0301",
    );
    expect(() => normalizeProject2D({ ...minimal, name: "\ud800" })).toThrow(
      /Unicode/,
    );
    expect(() => normalizeProject2D({ ...minimal, name: "\udfff" })).toThrow(
      /Unicode/,
    );
  });
  it("preserves signed zero through normalization", () => {
    const b = structuredClone(minimal) as typeof minimal & {
      illumination: { azimuth_deg?: number };
    };
    b.illumination.azimuth_deg = -0;
    expect(Object.is(normalizeProject2D(b).illumination.azimuth_deg, -0)).toBe(
      true,
    );
  });
  it("bounds the error for an oversized unknown key", () => {
    let message = "";
    try {
      normalizeProject2D({ ...minimal, ["x".repeat(10000)]: true });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message.length).toBeLessThan(400);
  });
});
