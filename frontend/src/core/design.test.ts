import { describe, expect, it } from "vitest";
import { convertLayer, describeRange, designError, designKey, newLayer, normalizeDesign, wavelengthRange } from "./design";
import { TEMPLATES } from "./templates";
import { apiProjects } from "./exporters";
import { parseProjectFile, serializeDesign } from "./projectFile";
import { decodeShare, encodeShare } from "./share";
import legacy from "./fixtures/legacy-reference.json";

const example = TEMPLATES[0].design;

describe("design helpers", () => {
  it("builds rounded, strictly increasing ranges", () => {
    const ws = wavelengthRange(400, 700, 7);
    expect(ws).toEqual([400, 450, 500, 550, 600, 650, 700]);
    expect(describeRange(ws)).toMatchObject({ start: 400, end: 700, points: 7, uniform: true });
    expect(describeRange([400, 410, 500]).uniform).toBe(false);
  });

  it("accepts spectra longer than one request but keeps every other 1.2 rule", () => {
    const long = { ...example, illumination: { ...example.illumination, wavelengths_nm: wavelengthRange(450, 850, 201) } };
    expect(normalizeDesign(long).illumination.wavelengths_nm).toHaveLength(201);
    expect(designError({ ...example, period_nm: 50 })).toMatch(/diameter/i);
    expect(designError({ ...example, illumination: { ...example.illumination, wavelengths_nm: [500, 400] } })).toMatch(/increase/);
  });

  it("keys designs independently of object key order", () => {
    const reverse = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverse) : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)]))
        : v;
    const reordered = reverse(example) as typeof example;
    expect(designKey(reordered)).toBe(designKey(example));
    expect(designKey({ ...example, period_nm: 151 })).not.toBe(designKey(example));
  });

  it("keeps name, thickness and materials when a layer changes shape", () => {
    const hole = example.layers[0];
    const film = convertLayer(hole, "homogeneous", example);
    expect(film).toMatchObject({ geometry: "homogeneous", name: hole.name, thickness_nm: hole.thickness_nm });
    expect(film.material).toEqual("background" in hole ? hole.background : hole.material);
    const blocks = convertLayer(newLayer("homogeneous", example, 0), "rectangle_2d", example);
    expect(normalizeDesign({ ...example, layers: [blocks] }).layers[0].geometry).toBe("rectangle_2d");
  });

  it("validates every template", () => {
    for (const t of TEMPLATES) expect(designError(t.design), t.id).toBeNull();
  });
});

describe("files and links", () => {
  it("round-trips a design file", () => {
    expect(parseProjectFile(serializeDesign(example)).design).toEqual(normalizeDesign(example));
  });
  it("converts legacy 1.0 projects to 1.2 with notes", () => {
    const { design, notes } = parseProjectFile(JSON.stringify(legacy));
    expect(design.schema_version).toBe("1.2");
    expect(design.layers[0].geometry).toBe("rectangle_1d");
    expect(design.solver.harmonics_y).toBe(1);
    expect(notes[0]).toMatch(/Converted from schema 1\.0/);
  });
  it("rejects JSON that is not a project instead of opening a default design", () => {
    expect(() => parseProjectFile('{"hello": 1}')).toThrow(/not an RCWA project/);
    expect(() => parseProjectFile('{"layers": [], "extra": true}')).toThrow(/not an RCWA project/);
  });
  it("reopens its own chunked API export as one design", () => {
    const long = { ...example, illumination: { ...example.illumination, wavelengths_nm: wavelengthRange(400, 800, 81) } };
    const text = apiProjects(long);
    expect(JSON.parse(text).projects.length).toBeGreaterThan(1);
    expect(parseProjectFile(text).design).toEqual(normalizeDesign(long));
    const mixed = JSON.parse(text);
    mixed.projects[1].period_nm += 10;
    expect(() => parseProjectFile(JSON.stringify(mixed))).toThrow(/different designs/);
  });
  it("round-trips a share link", async () => {
    const hash = await encodeShare(example);
    expect(hash.startsWith("d=")).toBe(true);
    expect(hash.slice(2)).not.toMatch(/[+/=]/);
    expect(await decodeShare(`#${hash}`)).toEqual(normalizeDesign(example));
    expect(await decodeShare("#other")).toBeNull();
  });
});
