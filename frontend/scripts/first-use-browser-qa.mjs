// A first-use task check against the genuine static reference, never fake recomputation.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const report = { screenshots: [], checks: [], pageErrors: [], issues: [] };
const url = process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173";
for (const width of [360, 390, 1440]) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  try {
    const page = await browser.newPage({
      viewport: {
        width,
        height: width === 360 ? 800 : width === 390 ? 844 : 1000,
      },
    });
    const apiCalls = [];
    page.on("pageerror", (e) => report.pageErrors.push(e.message));
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.startsWith("/api/"))
        apiCalls.push(req.url());
    });
    await page.goto(url);
    await expect(page.locator(".three-canvas")).toHaveAttribute(
      "data-ready",
      "true",
    );
    await expect(page.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    await page.evaluate(() => document.fonts.ready);
    async function shot(name) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const path = `first-use-${width}-${name}.png`;
      await page.screenshot({ path: `${output}/${path}`, fullPage: true });
      report.screenshots.push(path);
      const viewportPath = path.replace(".png", "-viewport.png");
      await page.screenshot({ path: `${output}/${viewportPath}` });
      report.screenshots.push(viewportPath);
    }
    await expect(
      page.getByRole("button", { name: /Select layer 1:/ }),
    ).toBeVisible();
    await expect(page.locator(".scene-selection")).toContainText(
      "Selected: Layer 1",
    );
    await expect(
      page.getByRole("slider", { name: "Drag width", exact: true }),
    ).toHaveCount(0);
    assert.equal(
      await page.locator(".advanced-settings").evaluate((n) => n.open),
      false,
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    const primary = await page.locator(".preview-result-button").boundingBox();
    if (
      width < 650 &&
      !(primary && primary.y + primary.height <= (width === 360 ? 800 : 844))
    )
      report.issues.push(
        `Primary result action is below the ${width}px mobile viewport: ${JSON.stringify(primary)}`,
      );
    await shot("initial");
    // First change the existing layer, without having to discover Add.
    await page.locator(".dimension-rail button").first().click();
    await shot("width-editor");
    await page.locator("#dimension-width").fill("200");
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await expect(page.locator(".dimension-rail button").first()).toContainText(
      "200",
    );
    await expect(page.locator(".stale-note")).toContainText(
      "no longer matches your inputs",
    );
    await page.getByLabel("Add layer", { exact: true }).click();
    await page
      .getByRole("button", { name: "Add patterned layer", exact: true })
      .click();
    await expect(page.locator(".scene-selection")).toContainText(
      "Selected: Layer 2",
    );
    await shot("two-layers");
    await page.getByRole("button", { name: /Select layer 1:/ }).click();
    await expect(page.locator(".scene-selection")).toContainText(
      "Selected: Layer 1",
    );
    await expect(page.locator(".dimension-rail button").first()).toContainText(
      "200",
    );
    await page
      .locator(".dimension-rail button")
      .filter({ hasText: "Thickness" })
      .click();
    await shot("thickness-editor");
    await page.locator("#dimension-height").fill("150");
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await expect(
      page.locator(".dimension-rail button").filter({ hasText: "Thickness" }),
    ).toContainText("150");
    await shot("edited-layer");
    await page
      .getByRole("button", { name: "Layer settings", exact: true })
      .click();
    await shot("layer-settings");
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await page
      .getByRole("link", { name: "View example spectrum", exact: true })
      .click();
    await expect(page.locator(".static-edit-note")).toContainText(
      "Edits won't calculate a new spectrum",
    );
    await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
    await page
      .locator("#spectrum")
      .screenshot({ path: `${output}/first-use-${width}-edited-spectrum.png` });
    report.screenshots.push(`first-use-${width}-edited-spectrum.png`);
    assert.equal(
      apiCalls.length,
      0,
      "Static editing must make no API requests",
    );
    report.checks.push(
      `${width}px: select existing layer, edit width, add/select layer, edit thickness, identify original example result, no horizontal overflow, primary action in mobile viewport, no API calls`,
    );
  } finally {
    await browser.close();
  }
}
assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
await fs.writeFile(
  `${output}/first-use-browser-qa.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
assert.equal(report.issues.length, 0, JSON.stringify(report.issues));
