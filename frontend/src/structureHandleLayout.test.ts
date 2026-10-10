import { describe, expect, it } from "vitest";
import {
  HANDLE_DIAMETER,
  HANDLE_SPACING,
  STRUCTURE_HANDLE_SAFE_AREA,
  layoutStructureHandles,
} from "./structureHandleLayout";
import type { HandlePoints } from "./structureHandleLayout";
import type { StructureDimension } from "./structureGeometry";
const dimensions: StructureDimension[] = ["width", "height", "pitch"];
function verify(
  anchors: HandlePoints,
  width = 326,
  height = 290,
  visible = dimensions,
) {
  const before = structuredClone(anchors);
  const result = layoutStructureHandles(anchors, visible, width, height);
  expect(result).not.toBeNull();
  for (const [index, dimension] of visible.entries()) {
    const point = result![dimension];
    expect(point.x).toBeGreaterThanOrEqual(HANDLE_DIAMETER / 2);
    expect(point.x).toBeLessThanOrEqual(width - HANDLE_DIAMETER / 2);
    expect(point.y).toBeGreaterThanOrEqual(HANDLE_DIAMETER / 2);
    expect(point.y).toBeLessThanOrEqual(height - HANDLE_DIAMETER / 2);
    for (const other of visible.slice(index + 1))
      expect(
        Math.hypot(point.x - result![other].x, point.y - result![other].y),
      ).toBeGreaterThanOrEqual(HANDLE_SPACING - 1e-6);
  }
  expect(anchors).toEqual(before);
  expect(layoutStructureHandles(anchors, visible, width, height)).toEqual(
    result,
  );
  return result!;
}

describe("collision-aware physical handle labels", () => {
  it("leaves already legal projected anchors exactly unchanged", () => {
    const points = {
      width: { x: 80, y: 130 },
      height: { x: 150, y: 70 },
      pitch: { x: 240, y: 210 },
    };
    expect(verify(points)).toEqual(points);
  });
  it("separates the measured eight-layer360px overlap with a minimal leader offset", () => {
    const points = {
      width: { x: 142.14510368029218, y: 129.733729259859 },
      height: { x: 173.23687352982205, y: 105.67157251054975 },
      pitch: { x: 164.948185111355, y: 236.1856271662451 },
    };
    const result = verify(points, 326, 290.85714285714283);
    expect(result.width).toEqual(points.width);
    expect(result.pitch).toEqual(points.pitch);
    expect(
      Math.hypot(
        result.height.x - points.height.x,
        result.height.y - points.height.y,
      ),
    ).toBeCloseTo(48 - 39.31520748774528, 6);
  });
  it("handles coincident points, all corners, viewport edges and offscreen projections", () => {
    for (const point of [
      { x: 163, y: 145 },
      { x: 22, y: 22 },
      { x: 0, y: 0 },
      { x: 326, y: 290 },
      { x: 100000, y: -100000 },
    ])
      verify({
        width: { ...point },
        height: { ...point },
        pitch: { ...point },
      });
    verify({
      width: { x: 25, y: 25 },
      height: { x: 50, y: 30 },
      pitch: { x: 30, y: 50 },
    });
  });
  it("considers only the film's visible thickness/pitch controls", () => {
    const points = {
      width: { x: 150, y: 100 },
      height: { x: 150, y: 100 },
      pitch: { x: 240, y: 210 },
    };
    const result = verify(points, 326, 290, ["height", "pitch"]);
    expect(result.height).toEqual(points.height);
    expect(result.pitch).toEqual(points.pitch);
  });
  it("stays deterministic and separated through orbit/zoom/resize-like projections", () => {
    const original = {
      width: { x: 140, y: 130 },
      height: { x: 173, y: 105 },
      pitch: { x: 165, y: 236 },
    };
    for (const [width, height] of [
      [326, 290],
      [340, 303],
      [590, 436],
      [200, 160],
    ])
      for (const zoom of [0.65, 1, 1.65])
        for (let angle = -1.05; angle <= 1.05; angle += 0.15) {
          const points = Object.fromEntries(
            Object.entries(original).map(([dimension, point]) => {
              const x = (point.x - 163) * zoom,
                y = (point.y - 145) * zoom;
              return [
                dimension,
                {
                  x: width / 2 + x * Math.cos(angle) - y * Math.sin(angle),
                  y: height / 2 + x * Math.sin(angle) + y * Math.cos(angle),
                },
              ];
            }),
          ) as HandlePoints;
          verify(points, width, height);
        }
  });
  it("preserves separation for adversarial deterministic projected positions", () => {
    let seed = 928374;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let sample = 0; sample < 1200; sample++) {
      const width = 200 + random() * 600,
        height = 160 + random() * 400;
      const points = Object.fromEntries(
        dimensions.map((dimension) => [
          dimension,
          { x: (random() * 3 - 1) * width, y: (random() * 3 - 1) * height },
        ]),
      ) as HandlePoints;
      verify(points, width, height);
    }
  });
  it("returns no direct targets for impossible or nonfinite viewports, allowing exact-entry fallback", () => {
    const points = {
      width: { x: 22, y: 22 },
      height: { x: 22, y: 22 },
      pitch: { x: 22, y: 22 },
    };
    for (const [width, height] of [
      [0, 0],
      [43, 200],
      [44, 44],
      [NaN, 300],
    ])
      expect(
        layoutStructureHandles(points, dimensions, width, height),
      ).toBeNull();
    expect(
      layoutStructureHandles(
        { ...points, width: { x: Infinity, y: 10 } },
        dimensions,
        326,
        290,
      ),
    ).toBeNull();
  });
});

describe("scene control safe-area bands", () => {
  const dimensions: StructureDimension[] = ["width", "height", "pitch"];
  const safeArea = STRUCTURE_HANDLE_SAFE_AREA;
  function verifySafe(points: HandlePoints, width = 326, height = 290) {
    const before = structuredClone(points);
    const targets = layoutStructureHandles(
      points,
      dimensions,
      width,
      height,
      safeArea,
    );
    expect(targets).not.toBeNull();
    for (const [index, dimension] of dimensions.entries()) {
      const point = targets![dimension];
      expect(point.x - 22).toBeGreaterThanOrEqual(0);
      expect(point.x + 22).toBeLessThanOrEqual(width);
      expect(point.y - 22).toBeGreaterThanOrEqual(safeArea.top);
      expect(point.y + 22).toBeLessThanOrEqual(height - safeArea.bottom);
      for (const other of dimensions.slice(index + 1))
        expect(
          Math.hypot(point.x - targets![other].x, point.y - targets![other].y),
        ).toBeGreaterThanOrEqual(HANDLE_SPACING - 1e-6);
    }
    expect(points).toEqual(before);
    return targets!;
  }
  it("preserves exact positions already clear of every control band", () => {
    const points = {
      width: { x: 80, y: 130 },
      height: { x: 150, y: 100 },
      pitch: { x: 240, y: 185 },
    };
    expect(verifySafe(points)).toEqual(points);
  });
  it("moves the observed footer-caption collision and protects the header too", () => {
    const points = {
      width: { x: 131, y: 92 },
      height: { x: 175, y: 70 },
      pitch: { x: 131, y: 254 },
    };
    const targets = verifySafe(points);
    expect(targets.pitch.y).toBe(204);
    expect(targets.height.y).toBeGreaterThanOrEqual(86);
    expect(targets.width).toEqual(points.width);
  });
  it("keeps all visible targets clear through orbit/zoom and extreme projections", () => {
    const original = {
      width: { x: 140, y: 80 },
      height: { x: 173, y: 65 },
      pitch: { x: 165, y: 256 },
    };
    for (const [width, height] of [
      [326, 290],
      [340, 303],
      [590, 436],
    ])
      for (const zoom of [0.65, 1, 1.65])
        for (let angle = -1.05; angle <= 1.05; angle += 0.15) {
          const points = Object.fromEntries(
            Object.entries(original).map(([dimension, point]) => {
              const x = (point.x - 163) * zoom,
                y = (point.y - 145) * zoom;
              return [
                dimension,
                {
                  x: width / 2 + x * Math.cos(angle) - y * Math.sin(angle),
                  y: height / 2 + x * Math.sin(angle) + y * Math.cos(angle),
                },
              ];
            }),
          ) as HandlePoints;
          verifySafe(points, width, height);
        }
    for (const point of [
      { x: 0, y: 0 },
      { x: 326, y: 290 },
      { x: 163, y: 145 },
      { x: -10000, y: 10000 },
    ])
      verifySafe({
        width: { ...point },
        height: { ...point },
        pitch: { ...point },
      });
  });
  it("supports asymmetric explicit bounds and refuses impossible/invalid safe areas", () => {
    const points = {
      width: { x: 0, y: 0 },
      height: { x: 326, y: 0 },
      pitch: { x: 163, y: 290 },
    };
    const result = layoutStructureHandles(points, dimensions, 326, 290, {
      left: 30,
      right: 20,
      top: 60,
      bottom: 70,
    })!;
    expect(result).not.toBeNull();
    for (const point of Object.values(result)) {
      expect(point.x).toBeGreaterThanOrEqual(52);
      expect(point.x).toBeLessThanOrEqual(284);
      expect(point.y).toBeGreaterThanOrEqual(82);
      expect(point.y).toBeLessThanOrEqual(198);
    }
    for (const safe of [
      { top: -1 },
      { bottom: Infinity },
      { left: NaN },
      { top: 150, bottom: 150 },
    ])
      expect(
        layoutStructureHandles(points, dimensions, 326, 290, safe),
      ).toBeNull();
    expect(
      layoutStructureHandles(points, dimensions, 326, 160, safeArea),
    ).toBeNull();
  });
});
