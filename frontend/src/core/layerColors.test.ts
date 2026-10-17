import { describe, expect, it } from "vitest";
import { layerColor } from "./layerColors";
function luminance(hex: string) {
  const rgb = [1, 3, 5]
    .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
describe("schematic layer colors", () => {
  it("gives every bounded layer a distinct color independent of selection and material", () => {
    const colors = Array.from({ length: 8 }, (_, index) => layerColor(index));
    expect(new Set(colors).size).toBe(8);
    colors.forEach((color, index) => expect(layerColor(index)).toBe(color));
  });
  it("supports readable dark layer numbers at WCAG normal-text contrast", () => {
    for (let index = 0; index < 8; index++)
      expect(
        (luminance(layerColor(index)) + 0.05) / (luminance("#101010") + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
  });
});
