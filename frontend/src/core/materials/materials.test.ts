import { describe, expect, it } from "vitest";
import { describeMaterial, indexAt, LIBRARY, parseMaterialCsv } from ".";

describe("material library", () => {
  it("ships sourced tables inside the solver's bounds", () => {
    expect(LIBRARY.length).toBeGreaterThanOrEqual(12);
    for (const item of LIBRARY) {
      const m = item.material;
      expect(m.source).toMatch(/refractiveindex\.info/);
      expect(m.wavelengths_nm!.every((w, i, a) => !i || w > a[i - 1])).toBe(true);
      expect(m.n_values!.every((n) => n > 0 && n <= 10)).toBe(true);
      expect(m.k_values!.every((k) => k >= 0 && k <= 10)).toBe(true);
    }
  });
  it("interpolates n and k linearly and refuses to extrapolate", () => {
    const sio2 = LIBRARY.find((m) => m.id === "SiO2")!.material;
    expect(indexAt(sio2, 600)!.n).toBeCloseTo(1.458, 3);
    expect(indexAt(sio2, 100)).toBeNull();
    expect(describeMaterial(sio2, 100)).toBe("outside its data");
  });
  it("parses CSV tables in nm or µm", () => {
    const um = parseMaterialCsv("film", "wavelength,n,k\n0.4,1.5,0\n0.8,1.4,0.01\n");
    expect(um.wavelengths_nm).toEqual([400, 800]);
    expect(parseMaterialCsv("x", "500 2 0\n400 2.1 0").wavelengths_nm).toEqual([400, 500]);
    expect(() => parseMaterialCsv("x", "400 2\n400 2")).toThrow(/repeat/);
    expect(() => parseMaterialCsv("x", "400 20\n500 2")).toThrow(/n ≤ 10/);
  });
});
