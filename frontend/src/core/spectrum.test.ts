import { describe, expect, it } from "vitest";
import { sampleAt } from "./spectrum";

describe("sampleAt", () => {
  it("interpolates between samples and holds the ends", () => {
    const xs = [400, 500, 600];
    const ys = [0, 1, 0.5];
    expect(sampleAt(xs, ys, 450)).toBeCloseTo(0.5);
    expect(sampleAt(xs, ys, 575)).toBeCloseTo(0.625);
    expect(sampleAt(xs, ys, 500)).toBe(1);
    expect(sampleAt(xs, ys, 300)).toBe(0);
    expect(sampleAt(xs, ys, 900)).toBe(0.5);
  });
});
