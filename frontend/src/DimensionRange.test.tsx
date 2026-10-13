import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DimensionRange,
  dimensionTrackBounds,
  dimensionKeyValue,
  dimensionPointerValue,
} from "./DimensionRange";

describe("physical dimension range", () => {
  it("uses useful local intervals capped by the true geometry", () => {
    expect(dimensionTrackBounds(150, 95, 5000)).toEqual({ min: 95, max: 300 });
    expect(dimensionTrackBounds(90, 0, 2000)).toEqual({ min: 0, max: 200 });
    expect(dimensionTrackBounds(70, 0, 140)).toEqual({ min: 0, max: 140 });
    expect(dimensionTrackBounds(70, 0, 5000)).toEqual({ min: 0, max: 200 });
    expect(dimensionTrackBounds(4200.123456789, 95, 5000)).toEqual({
      min: 95,
      max: 5000,
    });
    expect(dimensionTrackBounds(5000, 5000, 5000)).toEqual({
      min: 5000,
      max: 5000,
    });
    expect(dimensionTrackBounds(0, 0, 0.00001)).toEqual({
      min: 0,
      max: 0.00001,
    });
  });

  it("rejects invalid domains and never invents a finite value", () => {
    for (const values of [
      [NaN, 0, 5000],
      [Infinity, 0, 5000],
      [1, 0, Infinity],
      [1, NaN, 5],
      [-1, 0, 5],
      [6, 0, 5],
      [5, 6, 7],
      [1, -1, 5],
    ])
      expect(
        dimensionTrackBounds(...(values as [number, number, number])),
      ).toBeNull();
    for (const value of [NaN, Infinity, -1, 141])
      expect(dimensionPointerValue(value, { min: 0, max: 140 })).toBeNull();
  });

  it("has exact local endpoints and explicit physical keyboard increments", () => {
    const bounds = { min: 95.125, max: 140.25 };
    expect(dimensionKeyValue("Home", 100, bounds)).toBe(95.125);
    expect(dimensionKeyValue("End", 100, bounds)).toBe(140.25);
    expect(dimensionKeyValue("ArrowRight", 100.125, bounds)).toBe(101.125);
    expect(dimensionKeyValue("ArrowLeft", 100.125, bounds)).toBe(99.125);
    expect(dimensionKeyValue("PageUp", 100.125, bounds)).toBe(110.125);
    expect(dimensionKeyValue("PageDown", 100.125, bounds)).toBe(95.125);
    expect(dimensionKeyValue("ArrowUp", 140, bounds)).toBe(140.25);
    expect(dimensionKeyValue("Tab", 100, bounds)).toBeNull();
    expect(dimensionKeyValue("Escape", 100, bounds)).toBeNull();
    expect(dimensionPointerValue(95.125, bounds)).toBe(95.125);
    expect(dimensionPointerValue(140.25, bounds)).toBe(140.25);
    expect(dimensionPointerValue(109.65, bounds)).toBe(110);
  });

  it("mounts exact off-grid values without edits or quantization", () => {
    for (const value of [-0, Number.MIN_VALUE, 1e-20, 70.123456789, 140]) {
      const onChange = vi.fn(),
        onBeginEdit = vi.fn(),
        onEndEdit = vi.fn();
      const html = renderToStaticMarkup(
        createElement(DimensionRange, {
          label: "Diameter",
          value,
          min: 0,
          max: 140,
          onChange,
          onBeginEdit,
          onEndEdit,
        }),
      );
      const exact = Object.is(value, -0) ? "-0" : String(value);
      expect(html).toContain(`aria-valuetext="${exact} nanometers"`);
      expect(html).toContain('step="any"');
      expect(html).toContain('min="0" max="140"');
      expect(onChange).not.toHaveBeenCalled();
      expect(onBeginEdit).not.toHaveBeenCalled();
      expect(onEndEdit).not.toHaveBeenCalled();
    }
  });

  it("disables a zero-width interval without changing the exact value", () => {
    const html = renderToStaticMarkup(
      createElement(DimensionRange, {
        label: "Pitch X",
        value: 5000,
        min: 5000,
        max: 5000,
        onChange: () => {},
        onBeginEdit: () => {},
        onEndEdit: () => {},
      }),
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-valuetext="5000 nanometers"');
    expect(html).toContain('min="5000" max="5000"');
  });
});
