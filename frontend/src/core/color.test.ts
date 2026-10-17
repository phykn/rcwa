import { describe, expect, it } from "vitest";
import { spectrumColor } from "./color";

describe("spectrumColor", () => {
  const ws = Array.from({ length: 81 }, (_, i) => 380 + i * 5);
  it("maps a perfect reflector to white and a black body to black", () => {
    expect(spectrumColor(ws, ws.map(() => 1))!.hex).toMatch(/^#f[0-9a-f]f[0-9a-f]f[0-9a-f]$/);
    expect(spectrumColor(ws, ws.map(() => 0))!.hex).toBe("#000000");
  });
  it("renders a long-wavelength band as red-dominant", () => {
    const hex = spectrumColor(ws, ws.map((w) => (w > 600 ? 1 : 0)))!.hex;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });
  it("refuses spectra that miss the visible band", () => {
    expect(spectrumColor([450, 850], [0.5, 0.5])).toBeNull();
  });
});
