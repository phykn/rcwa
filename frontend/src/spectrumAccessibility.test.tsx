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
  it("shows one exact centered sample without a slider or invented range", () => {
    const wavelength = 633.25;
    const single = {
      ...result,
      wavelengths_nm: [wavelength],
      spectra: {
        s: {
          ...result.spectra.s!,
          R: [0.2],
          T: [0.8],
          R_specular: [0.15],
          T_specular: [0.7],
        },
      },
    };
    const html = plot(single);
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain('for="wavelength-sample"');
    expect(html).not.toContain("wavelength slider");
    expect(html).not.toContain("<path");
    expect(html).toContain("Single wavelength");
    expect(html).toContain("633.25 nm");
    expect(html).toContain(
      "at 633.25 nanometers. Single wavelength; values below.",
    );
    expect(html).toContain(
      "633.25 nanometers. s polarization. Reflectance 20.0 percent. Transmittance 80.0 percent.",
    );
    expect(html.match(/>633\.25<\/text>/g)).toHaveLength(1);
    expect(html.match(/cx="192.5"/g)).toHaveLength(2);
    // Comparison has its own separate sample control; this patch does not change it.
    expect(compare(single)).toContain('aria-valuetext="633.25 nanometers"');
  });
  it("keeps the keyboard control and plotted range for multiple samples", () => {
    const html = plot();
    expect(html).toContain('type="range"');
    expect(html).toContain(`max="${result.wavelengths_nm.length - 1}"`);
    expect(html).toContain("wavelength slider");
    expect(html).toContain("<path");
    expect(html).not.toContain("Single wavelength");
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
