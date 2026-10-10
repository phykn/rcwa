import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const checks = [];
try {
  await page.goto("http://127.0.0.1:5173");
  await expect(page.getByText("Solver connected", { exact: true })).toBeVisible(
    { timeout: 20000 },
  );
  await expect(page.getByLabel(/Width \(CD\)/)).toHaveValue("180");
  await page.getByRole("button", { name: /Run simulation/ }).click();
  await expect(page.locator(".result-badge")).toHaveText("Computed", {
    timeout: 90000,
  });
  await expect(page.locator(".spectrum-svg")).toBeVisible();
  checks.push("Real API default forward solve and plotted output");
  await page.getByRole("button", { name: "p / TM", exact: true }).click();
  await page.getByLabel("Spectrum quantity").selectOption("specular");
  await expect(page.locator(".plot-legend")).toContainText("R₀ specular");
  await expect(page.locator(".plot-legend")).not.toContainText("R total");
  await page.getByLabel("Spectrum quantity").selectOption("all");
  await page.getByRole("button", { name: "s / TE", exact: true }).click();
  checks.push("s/p selection and total/specular distinction");
  await page.screenshot({
    path: `${output}/workbench-desktop.png`,
    fullPage: true,
  });
  await page.getByLabel(/Width \(CD\)/).fill("181");
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  checks.push("Editing parameters preserves and marks previous results stale");
  await page.getByLabel(/Width \(CD\)/).fill("180");
  const malformed = JSON.parse(
    await fs.readFile(
      new URL("../public/reference-example.json", import.meta.url),
      "utf8",
    ),
  );
  malformed.result.warnings = "oops";
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(malformed)),
    });
  await expect(page.getByRole("alert")).toContainText(
    "Saved result is invalid",
  );
  await expect(page.locator(".result-badge")).toHaveText("Computed");
  await expect(page.getByLabel(/Width \(CD\)/)).toHaveValue("180");
  await page.getByRole("button", { name: "Dismiss error" }).click();
  checks.push(
    "Malformed JSON result rejected without replacing current inputs/output",
  );
  await page.getByLabel("Project name").fill("Browser QA saved project");
  await page.getByLabel("Save project to local server").click();
  await expect(page.getByRole("status")).toContainText("Project saved");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: /Browser QA saved project/ }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByLabel("Project name")).toHaveValue(
    "Browser QA saved project",
  );
  checks.push("Save/list/load project from real local API");
  await page.locator(".fit-panel > summary").click();
  await page
    .getByRole("button", { name: "Run synthetic recovery", exact: true })
    .click();
  await expect(page.locator(".fit-result-heading")).toContainText(
    "Synthetic target recovered",
    { timeout: 90000 },
  );
  await expect(page.getByTestId("recovered-cd")).toContainText("220.000");
  checks.push(
    "Real local bounded synthetic CD fit recovered 220 nm and showed same-model caveat",
  );
  await page
    .locator(".fit-panel")
    .screenshot({ path: `${output}/workbench-fit.png` });
  await page.getByRole("button", { name: /Load reference result/ }).click();
  await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(`${output}/browser-export.json`);
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(`${output}/browser-export.json`);
  await expect(page.locator(".result-badge")).toHaveText("Imported result");
  checks.push("Full input/result export and JSON reload");
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  mobile.on("pageerror", (error) => errors.push(error.message));
  const requests = [];
  mobile.on("request", (request) => {
    if (request.url().includes("/api/")) requests.push(request.url());
  });
  await mobile.goto("http://127.0.0.1:4173");
  await expect(
    mobile.getByText("Static preview", { exact: true }),
  ).toBeVisible();
  await expect(mobile.locator(".result-badge")).toHaveText(
    "Precomputed example",
    { timeout: 15000 },
  );
  await expect(
    mobile.getByRole("link", { name: /Set up the local solver/ }),
  ).toBeVisible();
  await expect(
    mobile.getByRole("button", { name: /Run simulation/ }),
  ).toHaveCount(0);
  await expect(mobile.locator(".more-settings")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(mobile.locator(".notes-panel")).not.toHaveAttribute("open", "");
  const geometryBox = await mobile.locator(".geometry-panel").boundingBox();
  const widthBox = await mobile.getByLabel(/Width \(CD\)/).boundingBox();
  if (!geometryBox || !widthBox || widthBox.y + widthBox.height > 844)
    throw new Error(
      "Geometry and main inputs must fit in the first mobile screen",
    );
  await mobile.locator(".more-settings > summary").click();
  await mobile.getByText("Light", { exact: true }).click();
  await expect(mobile.getByLabel("Wavelength samples")).toBeVisible();
  await mobile.locator(".more-settings > summary").click();
  if (requests.length)
    throw new Error(`Static preview made API requests: ${requests}`);
  if (
    await mobile.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
  )
    throw new Error("Horizontal overflow on 390px mobile");
  await mobile.screenshot({
    path: `${output}/workbench-mobile.png`,
    fullPage: true,
  });
  await mobile
    .locator(".spectrum-panel")
    .screenshot({ path: `${output}/workbench-mobile-spectrum.png` });
  await mobile.getByLabel(/Width \(CD\)/).fill("210");
  await expect(mobile.locator(".result-badge")).toHaveText("Inputs changed");
  await expect(mobile.locator(".reference-note")).toContainText("CD 180 nm");
  checks.push(
    "390px static mobile preview: first-screen geometry and inputs, collapsed settings, no overflow or API calls, frozen reference and local-setup link",
  );
  // Keep cancellation deterministic: real solver coverage is above; these routes
  // hold jobs open so cancellation cannot race a fast completed calculation.
  let cancelled = false;
  await page.route("**/api/jobs**", async (route) => {
    if (route.request().method() === "POST") cancelled = false;
    if (route.request().method() === "DELETE") cancelled = true;
    await route.fulfill({
      json: {
        id: "qa-cancel",
        kind: "forward",
        status: cancelled ? "cancelled" : "queued",
        result: null,
        error: null,
      },
    });
  });
  await page.getByRole("button", { name: /Run simulation/ }).click();
  await expect(page.getByLabel(/Width \(CD\)/)).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".message.success")).toContainText(
    "Calculation cancelled.",
  );
  await expect(page.getByLabel(/Width \(CD\)/)).toBeEnabled();
  await page
    .getByRole("button", { name: "Run synthetic recovery", exact: true })
    .click();
  await page.getByRole("button", { name: "Cancel fit", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Run synthetic recovery", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel(/Width \(CD\)/)).toBeEnabled();
  await page.unroute("**/api/jobs**");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  checks.push(
    "Deterministic forward/fit cancellation unlocks inputs; saved-project dialog dismisses with Escape",
  );
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
  await fs.writeFile(
    `${output}/browser-qa.json`,
    JSON.stringify(
      {
        status: "passed",
        checks,
        browser: "Chromium with Playwright",
        pageErrors: errors,
        date: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "passed", checks }, null, 2));
} catch (error) {
  await page
    .screenshot({ path: `${output}/browser-failure.png`, fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    `${output}/browser-qa.json`,
    JSON.stringify(
      {
        status: "failed",
        checks,
        error: String(error),
        pageErrors: errors,
        date: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
