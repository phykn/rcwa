import { describe, expect, it } from "vitest";
import { defaultProject } from "./model";
import {
  dimensionRange,
  materialSummary,
  structureGeometry,
  StructurePickGesture,
  structureValues,
} from "./structureGeometry";

describe("canonical 3D structure", () => {
  it("derives every physical dimension and angle from the project", () => {
    expect(structureValues(defaultProject)).toEqual({
      width: 180,
      height: 160,
      pitch: 400,
      angle: 15,
    });
  });

  it("preserves physical proportions throughout the admissible range", () => {
    for (const pitch of [20, 21, 400, 4999, 5000]) {
      for (const width of [0, pitch / 2, pitch]) {
        for (const height of [0, 1, 160, 1999, 2000]) {
          const scene = structureGeometry({ width, height, pitch, angle: 75 });
          expect(scene.scale).toBeGreaterThan(0);
          expect(scene.width / scene.scale).toBeCloseTo(width, 8);
          expect(scene.height / scene.scale).toBeCloseTo(height, 8);
          expect(scene.pitch / scene.scale).toBeCloseTo(pitch, 8);
          expect(Math.max(scene.span, scene.height)).toBeCloseTo(5.1, 8);
          expect(scene.width / scene.pitch).toBeCloseTo(width / pitch, 8);
        }
      }
    }
  });

  it("uses absent ridges at both zero endpoints and a continuous full-fill layer", () => {
    const values = structureValues(defaultProject);
    expect(structureGeometry({ ...values, width: 0 }).ridgeMode).toBe("none");
    expect(structureGeometry({ ...values, height: 0 }).ridgeMode).toBe("none");
    expect(
      structureGeometry({ ...values, width: values.pitch }).ridgeMode,
    ).toBe("continuous");
    expect(structureGeometry(values).ridgeMode).toBe("patterned");
  });

  it("exposes the complete canonical edit ranges", () => {
    const values = structureValues(defaultProject);
    expect(dimensionRange("width", values)).toEqual([0, 400]);
    expect(dimensionRange("height", values)).toEqual([0, 2000]);
    expect(dimensionRange("pitch", values)).toEqual([180, 5000]);
    expect(dimensionRange("pitch", { ...values, width: 0 })).toEqual([
      20, 5000,
    ]);
  });

  it("never labels tabulated data with the unused constant fields", () => {
    expect(
      materialSummary({
        ...defaultProject.ambient,
        kind: "tabulated",
        n: 9.99,
      }),
    ).toBe("Tabulated n/k");
    expect(materialSummary(defaultProject.ambient)).toBe("n 1 · k 0");
  });
});

describe("material picking", () => {
  it("accepts a stationary single-pointer tap", () => {
    const gesture = new StructurePickGesture();
    gesture.down(1, 10, 10, true);
    expect(gesture.up(1, 10, 10)).toBe(true);
  });

  it("rejects orbit even if the pointer ends at its starting position", () => {
    const gesture = new StructurePickGesture();
    gesture.down(1, 10, 10, true);
    gesture.move(1, 30, 10);
    expect(gesture.up(1, 10, 10)).toBe(false);
    gesture.down(1, 10, 10, true);
    gesture.cameraChanged();
    expect(gesture.up(1, 10, 10)).toBe(false);
  });

  it("rejects both fingers of a pinch and permits the next distinct tap", () => {
    const gesture = new StructurePickGesture();
    gesture.down(1, 10, 10, true);
    gesture.down(2, 20, 20, true);
    expect(gesture.up(1, 10, 10)).toBe(false);
    expect(gesture.up(2, 20, 20)).toBe(false);
    gesture.down(3, 10, 10, true);
    expect(gesture.up(3, 10, 10)).toBe(true);
  });

  it("rejects cancelled, suppressed and non-primary-button gestures", () => {
    const gesture = new StructurePickGesture();
    gesture.down(1, 10, 10, true);
    gesture.cancel(1);
    expect(gesture.up(1, 10, 10)).toBe(false);
    gesture.down(2, 10, 10, false);
    expect(gesture.up(2, 10, 10)).toBe(false);
    gesture.down(3, 10, 10, true);
    gesture.suppress();
    expect(gesture.up(3, 10, 10)).toBe(false);
  });
});
