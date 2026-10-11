import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import reference from "../public/reference-example.json";
import type {
  ForwardResult,
  ForwardResult1D,
  Project,
  SavedProject,
} from "./model";
import { SpectrumPlot } from "./Visuals";
import { ComparisonPanel } from "./WorkflowPanels";

const result = reference.result as unknown as ForwardResult1D;
function plot(
  value: ForwardResult | null = result,
  polarization: "s" | "p" = "s",
) {
  return renderToStaticMarkup(
    createElement(SpectrumPlot, {
      result: value,
      polarization,
      onPolarization: () => {},
    }),
  );
}
function saved(value: ForwardResult = result): SavedProject {
  return {
    id: "candidate-a",
    name: "Candidate A",
    created_at: "2026-10-10",
    updated_at: "2026-10-10",
    project: reference.project as Project,
    result: value,
  };
}
function compare(value: ForwardResult = result) {
  return renderToStaticMarkup(
    createElement(ComparisonPanel, {
      candidates: [saved(value)],
      onUse: () => {},
      onClose: () => {},
    }),
  );
}

describe("wavelength accessibility", () => {
  it("announces wavelength units and associates active spectrum quantities", () => {
    const html = plot();
    expect(html).toContain(
      `aria-valuetext="${result.wavelengths_nm[0]} nanometers"`,
    );
    expect(html).toContain('aria-describedby="spectrum-sample-description"');
    expect(html).toContain('aria-live="polite" aria-atomic="true"');
    expect(html).toContain(
      `${result.wavelengths_nm[0]} nanometers. s polarization. Reflectance`,
    );
    expect(html).toContain("percent. Transmittance");
  });
  it("describes the chosen polarization", () => {
    expect(plot(result, "p")).toContain("p polarization. Reflectance");
  });
  it("retains exact nonuniform wavelength samples", () => {
    const nonuniform = { ...result, wavelengths_nm: [431.25, 537.5, 809.75] };
    expect(plot(nonuniform)).toContain('aria-valuetext="431.25 nanometers"');
    expect(compare(nonuniform)).toContain('aria-valuetext="431.25 nanometers"');
  });
  it("supports a single sample without inventing a range", () => {
    const single = { ...result, wavelengths_nm: [633] };
    for (const html of [plot(single), compare(single)]) {
      expect(html).toContain('aria-valuetext="633 nanometers"');
      expect(html).toContain('max="0"');
    }
  });
  it("does not announce a spectrum when it is missing", () => {
    expect(plot(null)).not.toContain('id="spectrum-sample-description"');
    const missing = { ...result, spectra: { p: result.spectra.p } };
    expect(plot(missing)).not.toContain("aria-valuetext");
    expect(compare(missing)).not.toContain(
      'id="comparison-sample-description"',
    );
  });
  it("associates the comparison quantity, polarization and candidate readout", () => {
    const html = compare();
    expect(html).toContain(
      `aria-valuetext="${result.wavelengths_nm[0]} nanometers"`,
    );
    expect(html).toContain('aria-describedby="comparison-sample-description"');
    expect(html).toContain(
      `${result.wavelengths_nm[0]} nanometers. Total reflectance, s polarization. Candidate A:`,
    );
    expect(html).toContain('aria-live="polite" aria-atomic="true"');
  });
});
