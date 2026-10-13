// Reuses the real CLI result already produced by browser CI; no extra solve or
// synthetic interpolation. Exercises the shipped static build on three widths.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { capture, importText } from "./browser-2d-controls.mjs";
import {
  assertOrders,
  inspectOrders,
} from "./diffraction-orders-browser-qa.mjs";

const output = new URL("../../artifacts/", import.meta.url).pathname;
const previewUrl = process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173";
const single = JSON.parse(
  await fs.readFile(`${output}/circular-agent-best.json`, "utf8"),
);
const multiple = JSON.parse(
  await fs.readFile(
    new URL("../public/reference-circular.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(
  single.result.wavelengths_nm.length,
  1,
  "Use the real single-wavelength CLI result",
);
const started = Date.now();
const report = {
  startedAt: new Date(started).toISOString(),
  suiteBudgetMs: 240_000,
  status: "running",
  checks: [],
  captures: [],
  screenshots: [],
  pageErrors: [],
  apiRequests: [],
  limitations: [
    "Chromium keyboard and accessibility-tree checks do not substitute for a spoken screen-reader or real-device test.",
  ],
};
let browser;
const quantities = {
  total: [
    ["R", "Reflectance"],
    ["T", "Transmittance"],
  ],
  specular: [
    ["R_specular", "R₀ specular"],
    ["T_specular", "T₀ specular"],
  ],
};
quantities.all = [...quantities.total, ...quantities.specular];

async function values(page, result, polarization, index, mode) {
  const series = result.spectra[polarization];
  const wavelength = result.wavelengths_nm[index];
  await assertOrders(page, result, polarization, index);
  await expect(page.locator(".sample-wavelength strong")).toHaveText(
    `${wavelength} nm`,
  );
  await expect(page.locator(".sample-readout > div > span")).toHaveText(
    quantities[mode].map(
      ([key, label]) => `${label} ${(100 * series[key][index]).toFixed(1)}%`,
    ),
  );
  await expect(page.locator("#spectrum-sample-description")).toHaveText(
    `${wavelength} nanometers. ${polarization} polarization. ${quantities[mode].map(([key, label]) => `${label} ${(100 * series[key][index]).toFixed(1)} percent`).join(". ")}.`,
  );
}
async function imported(page, data, name) {
  await importText(page, data, name);
  await expect(page.locator(".result-badge")).toHaveText("Unverified import");
  await expect(page.locator(".message.success")).toContainText("JSON loaded.");
}
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  for (const width of [1440, 390, 360]) {
    const page = await browser.newPage({
      viewport: {
        width,
        height: width === 1440 ? 1000 : width === 390 ? 844 : 800,
      },
      ...(width < 400 ? { isMobile: true, hasTouch: true } : {}),
    });
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        report.apiRequests.push(request.url());
    });
    await page.goto(previewUrl);
    await expect(page.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    await page.evaluate(() => document.fonts.ready);
    const quantity = page.getByLabel("Spectrum quantity");
    const slider = page.getByRole("slider", {
      name: "Inspect wavelength sample",
      exact: true,
    });
    await quantity.focus();
    await page.keyboard.press("Tab");
    await expect(slider).toBeFocused();
    await slider.press("End");
    const last = multiple.result.wavelengths_nm.length - 1;
    await expect(slider).toHaveValue(String(last));
    await values(page, multiple.result, "s", last, "total");
    await slider.press("ArrowLeft");
    await values(page, multiple.result, "s", last - 1, "total");

    // A result can arrive while the previous spectrum's slider is focused.
    // Clamp its old high index and move only that removed control's focus.
    await expect(slider).toBeFocused();
    await imported(page, single, "single-wavelength-cli");
    await expect(quantity).toBeFocused();
    await expect(slider).toHaveCount(0);
    const wavelength = single.result.wavelengths_nm[0];
    const chart = page.locator(".spectrum-svg");
    await expect(chart).toHaveAccessibleName(
      `s polarized reflection and transmission at ${wavelength} nanometers. Single wavelength; values below.`,
    );
    await expect(chart.locator("path")).toHaveCount(0);
    const axes = await chart.evaluate((svg) => ({
      width: svg.viewBox.baseVal.width,
      ticks: [...svg.querySelectorAll('text[y="237"]')].map((node) => ({
        text: node.textContent,
        x: Number(node.getAttribute("x")),
      })),
      points: [...svg.querySelectorAll("circle")].map((node) =>
        Number(node.getAttribute("cx")),
      ),
    }));
    assert.deepEqual(axes.ticks, [
      { text: String(wavelength), x: 55 + (axes.width - 55 - 20) / 2 },
    ]);
    assert.deepEqual(
      axes.points,
      axes.points.map(() => axes.ticks[0].x),
    );
    await expect(page.locator(".sample-wavelength")).toHaveText(
      `Single wavelength ${wavelength} nm`,
    );
    for (const mode of ["all", "specular", "total"]) {
      await quantity.selectOption(mode);
      await values(page, single.result, "s", 0, mode);
      await expect(chart.locator("circle")).toHaveCount(
        quantities[mode].length,
      );
    }
    await expect(
      page.getByRole("button", { name: "p / TM", exact: true }),
    ).toBeDisabled();
    await quantity.focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement === document.body),
      false,
      "Tab continues to a real control after the static readout",
    );
    await page.keyboard.press("Shift+Tab");
    await expect(quantity).toBeFocused();
    await chart.scrollIntoViewIfNeeded();
    const bounds = await chart.boundingBox();
    await page.mouse.move(
      bounds.x + bounds.width - 1,
      bounds.y + bounds.height / 2,
    );
    await values(page, single.result, "s", 0, "total");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "No mobile page overflow",
    );
    await page.locator(".spectrum-panel").scrollIntoViewIfNeeded();
    await capture(page, report, output, `single-${width}`, {
      prefix: "spectrum",
      top: false,
    });
    await fs.writeFile(
      `${output}/spectrum-single-${width}-ax.txt`,
      await page.locator(".spectrum-panel").ariaSnapshot(),
    );

    // The original multi-sample grid and keyboard/pointer inspection return
    // when loading another real stored result, including s/p and all quantities.
    await quantity.focus();
    await imported(page, multiple, "multiple-wavelength-reference");
    await expect(quantity).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(slider).toBeFocused();
    await expect(slider).toHaveAttribute("max", String(last));
    await slider.press("Home");
    await values(page, multiple.result, "s", 0, "total");
    await slider.press("End");
    await values(page, multiple.result, "s", last, "total");
    await page.getByRole("button", { name: "p / TM", exact: true }).click();
    for (const mode of ["all", "specular", "total"]) {
      await quantity.selectOption(mode);
      await slider.focus();
      await slider.press("Home");
      await slider.press("ArrowRight");
      await values(page, multiple.result, "p", 1, mode);
      await expect(chart.locator("path")).toHaveCount(quantities[mode].length);
    }
    await chart.scrollIntoViewIfNeeded();
    const multipleBounds = await chart.boundingBox();
    await page.mouse.move(
      multipleBounds.x + multipleBounds.width - 1,
      multipleBounds.y + multipleBounds.height / 2,
    );
    await values(page, multiple.result, "p", last, "total");
    // Replacement must not steal focus if a different surviving control was active.
    const sButton = page.getByRole("button", { name: "s / TE", exact: true });
    await sButton.focus();
    await imported(page, single, "single-with-polarization-focused");
    await expect(sButton).toBeFocused();
    await expect(slider).toHaveCount(0);
    await values(page, single.result, "s", 0, "total");
    report.checks.push(
      `${width}px: one exact centered tick and no range/path; real CLI R/T/specular values; no fake slider tab stop; removed-slider focus transfers to quantity without stealing another control's focus; multi-sample keyboard, pointer, s/p and result binding restored`,
    );
    await inspectOrders(page, report, output, width, imported);
    await page.close();
  }
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(
    report.apiRequests,
    [],
    "Static inspection never calculates or contacts an API",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started;
  await fs.writeFile(
    `${output}/spectrum-browser-qa.json`,
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  console.log(JSON.stringify(report, null, 2));
}
