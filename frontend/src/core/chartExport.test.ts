import { describe, expect, it } from "vitest";
import { spectrumChartSvg } from "./chartExport";
import { TEMPLATES } from "./templates";
import type { SpectrumResult } from "../engine/types";

describe("spectrum chart export", () => {
  it("draws R, T and A as a standalone, well-formed SVG", () => {
    const ws = [400, 500, 600];
    const result = {
      wavelengths_nm: ws,
      spectra: {
        s: { R: [0.1, 0.2, 0.3], T: [0.9, 0.8, 0.7], R_specular: [0, 0, 0], T_specular: [0, 0, 0], A_balance: [0, 0, 0], orders: [[], [], []] },
      },
    } as unknown as SpectrumResult;
    const svg = spectrumChartSvg(TEMPLATES[0].design, result, "s");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelectorAll("polyline")).toHaveLength(3);
    expect(svg).toContain(`xmlns="http://www.w3.org/2000/svg"`);
    expect(svg).toContain("s light");
  });
});
