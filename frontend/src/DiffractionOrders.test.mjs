import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import legacy from "../public/reference-example.json";
import circular from "../public/reference-circular.json";
import {
  DiffractionOrders,
  compactOrderPower,
  exactOrderPower,
  rankedDiffractionOrders,
} from "./DiffractionOrders";
import { bindResult2D } from "./result2d";
import { SpectrumPlot } from "./Visuals";
import {
  orderFixture,
  pOnlyOrderFixture,
} from "../scripts/order-inspector-fixtures.mjs";
// Read the archived genuine production calculations directly. No duplicate
// fixture, solve, interpolation, or claim about an edited design's accuracy.
async function archived(name) {
  const { project, result } = orderFixture(name);
  return bindResult2D(project, result);
}

function view(result, polarization = "s", sampleIndex = 0) {
  return renderToStaticMarkup(
    createElement(DiffractionOrders, {
      result,
      polarization,
      sampleIndex,
      onUnavailableFocus: () => {},
    }),
  );
}
function plot(result, polarization = "s") {
  return renderToStaticMarkup(
    createElement(SpectrumPlot, {
      result,
      polarization,
      onPolarization: () => {},
    }),
  );
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
describe("stored schema-1.2 diffraction orders", () => {
  it("shows all real multi-open orders with strongest first, collapsed by default", async () => {
    const result = await archived("multiple-open-channels");
    freeze(result);
    const before = JSON.stringify(result);
    const request = vi.spyOn(globalThis, "fetch");
    try {
      for (const polarization of ["s", "p"]) {
        const orders = result.spectra[polarization].orders[0];
        expect(
          orders.filter((row) => row.transmission_propagating).length,
        ).toBe(10);
        expect(
          orders
            .filter((row) => row.m || row.n)
            .reduce((sum, row) => sum + row.T, 0),
        ).toBeGreaterThan(1e-4);
        const html = view(result, polarization);
        expect(html).toContain(
          `632.8 nm · Incident ${polarization} · All 121 retained orders`,
        );
        expect(html).not.toMatch(/<details[^>]*\bopen=/);
        expect(
          [...html.matchAll(/data-order="([^"]+)"/g)].map((match) => match[1]),
        ).toEqual(
          rankedDiffractionOrders(orders).map((row) => `${row.m},${row.n}`),
        );
        for (const row of orders) {
          expect(html).toContain(
            `data-field="R" data-value="${exactOrderPower(row.R)}"`,
          );
          expect(html).toContain(
            `data-field="T" data-value="${exactOrderPower(row.T)}"`,
          );
        }
        expect(html).toContain(
          'role="region" aria-label="All retained diffraction orders" tabindex="0"',
        );
        expect(html).toContain('<th scope="col">(m, n)</th>');
        expect(html).toContain("Exact values");
        expect(html).toContain("Outgoing local s/p");
        expect(html).not.toContain('class="order-channels"');
      }
      expect(request).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).toBe(before);
    } finally {
      request.mockRestore();
    }
  });
  it("uses stored absorbing classifications with unequal Hx/Hy", async () => {
    const result = await archived("lossy-mixed-eight-layer");
    expect(result.metadata.harmonics_x).toBe(5);
    expect(result.metadata.harmonics_y).toBe(4);
    const html = view(result);
    expect(html.match(/data-order=/g)).toHaveLength(99);
    expect(html).toContain('data-order="-5,-4"');
    expect(html).toContain('data-order="5,4"');
    expect(html.match(/>Absorbing half-space</g)).toHaveLength(99);
    expect(html).toContain(
      "T is interface flux into the absorbing substrate, not backside transmission.",
    );
    expect(html).toContain(
      "Ordinary propagating/evanescent classification does not apply there.",
    );
  });
  it("keeps the exact selected wavelength and incident polarization", async () => {
    const result = await bindResult2D(circular.project, circular.result);
    const last = result.wavelengths_nm.length - 1;
    const html = view(result, "p", last);
    expect(html).toContain(`${result.wavelengths_nm[last]} nm · Incident p`);
    for (const row of result.spectra.p.orders[last])
      expect(html).toContain(
        `data-field="R" data-value="${exactOrderPower(row.R)}"`,
      );
  });
  it("binds the p-only selection fixture without changing any archived p value", async () => {
    const fixture = pOnlyOrderFixture();
    const bound = await bindResult2D(fixture.project, fixture.result);
    expect(bound.spectra.p).toEqual(
      orderFixture("multiple-open-channels").result.spectra.p,
    );
    expect(bound.spectra.s).toBeUndefined();
    expect(plot(bound, "p")).toContain("632.8 nm · Incident p");
  });
  it("integrates only typed 1.2 orders and supports each available incident polarization", async () => {
    const result = await archived("multiple-open-channels");
    for (const pol of ["s", "p"]) {
      // Shape-only single-polarization view fixture, not new solver evidence.
      const single = { ...result, spectra: { [pol]: result.spectra[pol] } };
      const html = plot(single, pol);
      expect(html).toContain("Diffraction orders");
      expect(html).toContain(`632.8 nm · Incident ${pol}`);
      expect(html).not.toContain('type="range"');
      const missing = pol === "s" ? "p" : "s";
      expect(plot(single, missing)).not.toContain("Diffraction orders");
    }
    expect(plot(null)).not.toContain("Diffraction orders");
    expect(plot(legacy.result)).not.toContain("Diffraction orders");
  });
});
describe("nonmutating power-magnitude order", () => {
  it("uses absolute magnitude for ranking only and preserves original-order ties", async () => {
    const result = await archived("multiple-open-channels");
    const first = result.spectra.s.orders[0][0];
    const rows = [
      { ...first, m: -2, R: 0, T: -0 },
      { ...first, m: -1, R: -1e-9, T: 0 },
      { ...first, m: 0, R: 0.4, T: 0.1 },
      { ...first, m: 1, R: 1e-9, T: 0 },
      { ...first, m: 2, R: -0, T: 0 },
    ];
    freeze(rows);
    const ranked = rankedDiffractionOrders(rows);
    expect(ranked.map((row) => row.m)).toEqual([0, -1, 1, -2, 2]);
    expect(rows.map((row) => row.m)).toEqual([-2, -1, 0, 1, 2]);
    expect(ranked[1]).toBe(rows[1]);
    expect(ranked[1].R).toBe(-1e-9);
    expect(Object.is(ranked[3].T, -0)).toBe(true);
    expect(ranked).not.toBe(rows);
  });
  it("ranks the chosen sample afresh without reordering either stored sample", async () => {
    const result = globalThis.structuredClone(
      await archived("multiple-open-channels"),
    );
    const base = result.spectra.s.orders[0][0];
    // Rendering-only vector, not numerical evidence.
    const a = [
      { ...base, m: -1, R: 0.2, T: 0 },
      { ...base, m: 1, R: 0.1, T: 0 },
    ];
    const b = [
      { ...base, m: -1, R: 0.05, T: 0 },
      { ...base, m: 1, R: 0.3, T: 0 },
    ];
    result.wavelengths_nm = [500, 600];
    result.spectra.s.orders = [a, b];
    freeze(result);
    expect(view(result, "s", 0).indexOf('data-order="-1,-5"')).toBeLessThan(
      view(result, "s", 0).indexOf('data-order="1,-5"'),
    );
    expect(view(result, "s", 1).indexOf('data-order="1,-5"')).toBeLessThan(
      view(result, "s", 1).indexOf('data-order="-1,-5"'),
    );
    expect(a[0].m).toBe(-1);
    expect(b[0].m).toBe(-1);
  });
});

describe("power presentation without hiding small signed contributions", () => {
  it.each([0, -0, 1e-300, -1e-12, 0.0006262383995636659, 0.9940134163192196])(
    "keeps the exact signed value %s available",
    (value) => {
      expect(Object.is(Number(exactOrderPower(value)), value)).toBe(true);
      const compact = compactOrderPower(value);
      if (value !== 0) {
        expect(Number(compact)).not.toBe(0);
        expect(Math.sign(Number(compact))).toBe(Math.sign(value));
      } else expect(Object.is(Number(compact), value)).toBe(true);
    },
  );
  it("keeps tiny signed and zero values in visible and accessible content", async () => {
    const result = globalThis.structuredClone(
      await archived("multiple-open-channels"),
    );
    // Explicit rendering-only adversarial vector: do not advertise edited
    // powers as physical evidence or import this as a genuine result.
    Object.assign(result.spectra.s.orders[0][0], { R: -0, T: -1e-12 });
    const html = view(result);
    expect(html).toContain(
      'data-value="-0"><span aria-hidden="true">-0</span><span class="sr-only">-0</span>',
    );
    expect(html).toContain(
      'data-value="-1e-12"><span aria-hidden="true">-1.000e-12</span><span class="sr-only">-1e-12</span>',
    );
  });
});
