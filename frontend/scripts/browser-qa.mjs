import { legacyExampleUrl } from "./browser-editor-controls.mjs";
import {
  enableDragHandles,
  openMaterial,
  dimensionLabel,
} from "./browser-editor-controls.mjs";
/* global document, getComputedStyle, innerWidth, requestAnimationFrame, scrollY, window */
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
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
const checks = [],
  errors = [];
let page, mobile;
async function menu(target = page) {
  const m = target.locator(".project-menu");
  if (!(await m.evaluate((n) => n.open))) await m.locator("summary").click();
}
async function dimension(target, kind, value) {
  await target
    .locator(".dimension-rail button")
    .filter({ hasText: new RegExp(`^${dimensionLabel(kind)}`, "i") })
    .click();
  const input = target.locator(`#dimension-${kind}`);
  if (value !== undefined) await input.fill(String(value));
  else
    await expect(input).toHaveValue(
      kind === "width" ? "180" : kind === "height" ? "160" : "400",
    );
  await target
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
}
async function rendered(target) {
  await expect(target.locator(".three-canvas")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect(target.locator(".three-canvas")).toHaveAttribute(
    "data-fallback",
    "false",
  );
  await target.waitForFunction(
    () => document.querySelector(".webgl-host canvas")?.width > 0,
  );
  await target.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}
async function shot(target, name, fullPage = false) {
  await target.screenshot({ path: `${output}/${name}.png`, fullPage });
}
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(legacyExampleUrl("http://127.0.0.1:5173"));
  await expect(page.locator(".connection")).toHaveText("Solver connected", {
    timeout: 20000,
  });
  await rendered(page);
  await dimension(page, "width");
  await page.getByRole("button", { name: /Run simulation/ }).click();
  await expect(page.locator(".result-badge")).toHaveText("Computed", {
    timeout: 90000,
  });
  await expect(page.locator(".spectrum-svg")).toBeVisible();
  checks.push("Real local API forward solve from canonical default Project");
  await page.getByRole("button", { name: "p / TM", exact: true }).click();
  await page.getByLabel("Spectrum quantity").selectOption("specular");
  await expect(page.locator(".plot-legend")).toContainText("R₀ specular");
  await expect(page.locator(".plot-legend")).not.toContainText("Reflectance");
  await page.getByLabel("Spectrum quantity").selectOption("total");
  await page.getByRole("button", { name: "s / TE", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "workbench-desktop", true);
  await shot(page, "workbench-desktop-viewport");
  const runControl = await page.locator(".run-button").boundingBox();
  assert.ok(
    runControl && runControl.y + runControl.height <= 1000,
    "Run simulation stays on the desktop first screen",
  );
  checks.push("s/p and total/specular are distinct; desktop rendered");
  await dimension(page, "width", 181);
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  await dimension(page, "width", 180);
  await expect(page.locator(".result-badge")).toHaveText("Computed");
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
  await page.getByRole("button", { name: "Dismiss error" }).click();
  checks.push(
    "Stale state clears only for original exact inputs; malformed result import leaves project/result untouched",
  );
  await page.getByLabel("Project name").fill("Browser QA saved project");
  await menu();
  await page.getByLabel("Save project to local server").click();
  await expect(page.locator(".message.success")).toContainText("Project saved");
  await menu();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: /Browser QA saved project/ })
    .first()
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  checks.push("Real local save/list/load remains available");
  await page.locator(".fit-panel > summary").click();
  await page
    .getByRole("button", { name: "Run synthetic recovery", exact: true })
    .click();
  await expect(page.locator(".fit-result-heading")).toContainText(
    "Synthetic target recovered",
    { timeout: 90000 },
  );
  await expect(page.getByTestId("recovered-cd")).toContainText("220.000");
  await page
    .locator(".fit-panel")
    .screenshot({ path: `${output}/workbench-fit.png` });
  checks.push("Real bounded synthetic CD fit recovers 220 nm with caveat");
  await page.getByRole("button", { name: /Load reference result/ }).click();
  await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
  await menu();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await (await downloading).saveAs(`${output}/browser-export.json`);
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(`${output}/browser-export.json`);
  await expect(page.locator(".result-badge")).toHaveText("Unverified import");
  checks.push("Project/result export/import preserves unverified origin");
  for (const width of [390, 360]) {
    mobile = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 800 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    mobile.on("pageerror", (e) => errors.push(e.message));
    const requests = [];
    mobile.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/")) requests.push(r.url());
    });
    await mobile.goto(legacyExampleUrl("http://127.0.0.1:4173"));
    await expect(mobile.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    await expect(mobile.locator(".connection")).toHaveText("Static preview");
    await rendered(mobile);
    assert.equal(
      await mobile.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const rail = await mobile.locator(".dimension-rail").boundingBox();
    assert.ok(
      rail.y + rail.height < (width === 390 ? 844 : 800),
      "Precision rail is on first screen",
    );
    await shot(mobile, `workbench-mobile-${width}-viewport`);
    await shot(mobile, `workbench-mobile-${width}`, true);
    await expect(
      mobile.getByRole("button", { name: /Run simulation/ }),
    ).toHaveCount(0);
    await expect(
      mobile.getByRole("link", { name: "View example spectrum", exact: true }),
    ).toBeVisible();
    for (const kind of ["width", "height", "pitch"]) {
      const button = mobile
        .locator(".dimension-rail button")
        .filter({ hasText: new RegExp(`^${dimensionLabel(kind)}`, "i") });
      const box = await button.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44);
      await button.click();
      await expect(mobile.locator(`#dimension-${kind}`)).toBeFocused();
      await mobile.keyboard.press("Escape");
      await expect(button).toBeFocused();
    }
    await dimension(mobile, "width", 210);
    await expect(mobile.locator(".result-badge")).toHaveText("Inputs changed");
    await expect(mobile.locator(".reference-note")).toHaveCount(0);
    await expect(mobile.locator(".result-inputs")).toContainText(
      "width 180 nm",
    );
    await mobile.locator(".dimension-rail button").first().click();
    await shot(mobile, `workbench-mobile-${width}-exact-entry`);
    await mobile.locator("#dimension-width").fill("9999");
    await expect(mobile.locator("#dimension-width")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(
      mobile.locator(".dimension-rail button").first(),
    ).toHaveAttribute("aria-label", /currently 210 nanometers/);
    await mobile.keyboard.press("Escape");
    await openMaterial(mobile);
    await expect(mobile.getByLabel("Ridge material name")).toBeVisible();
    await shot(mobile, `workbench-mobile-${width}-material`);
    await mobile.getByRole("button", { name: "Close settings" }).click();
    await mobile
      .getByRole("button", { name: "Edit light", exact: true })
      .click();
    await expect(mobile.getByLabel("Wavelength samples")).toBeVisible();
    await shot(mobile, `workbench-mobile-${width}-light`);
    await mobile.keyboard.press("Escape");
    await mobile.locator(".spectrum-panel").screenshot({
      path: `${output}/workbench-mobile-${width}-stale-spectrum.png`,
    });
    const chartBox = await mobile.locator(".spectrum-svg").boundingBox();
    assert.ok(chartBox.height >= 240 && chartBox.height <= 280);
    const tickSize = await mobile
      .locator(".chart-tick")
      .first()
      .evaluate(
        (n) => parseFloat(getComputedStyle(n).fontSize) * n.getScreenCTM().a,
      );
    assert.ok(tickSize >= 11.99);
    if (width === 390) {
      await menu(mobile);
      await mobile
        .getByRole("button", { name: "Reset example", exact: true })
        .click();
      await expect(mobile.locator(".result-badge")).toHaveText(
        "Precomputed example",
      );
      await enableDragHandles(mobile);
      const handle = mobile.getByRole("slider", {
        name: "Drag width",
        exact: true,
      });
      await handle.focus();
      await mobile.keyboard.press("ArrowRight");
      await expect(handle).toHaveAttribute("aria-valuenow", "181");
      await mobile.keyboard.press("Shift+ArrowRight");
      await expect(handle).toHaveAttribute("aria-valuenow", "191");
      await menu(mobile);
      await mobile
        .getByRole("button", { name: "Reset example", exact: true })
        .click();
      const box = await handle.boundingBox();
      assert.equal(
        await mobile.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest('[role="slider"]')
              ?.getAttribute("aria-label"),
          { x: box.x + 22, y: box.y + 22 },
        ),
        "Drag width",
        "Width target center must not be covered by another dimension handle",
      );
      await mobile.mouse.move(box.x + 22, box.y + 22);
      await mobile.mouse.down();
      await mobile.mouse.move(box.x + 44, box.y + 22, { steps: 8 });
      await mobile.mouse.up();
      assert.ok(Number(await handle.getAttribute("aria-valuenow")) > 180);
      await expect(
        mobile.getByRole("slider", { name: "Drag thickness", exact: true }),
      ).toHaveAttribute("aria-valuenow", "160");
      await shot(mobile, "workbench-mobile-390-dragged");
      await menu(mobile);
      await mobile
        .getByRole("button", { name: "Reset example", exact: true })
        .click();
      const canvas = mobile.locator(".webgl-host canvas");
      await canvas.focus();
      await mobile.keyboard.press("ArrowLeft");
      await expect(handle).toHaveAttribute("aria-valuenow", "180");
      await expect(
        mobile.getByRole("button", { name: "Reset 3D view" }),
      ).toBeVisible();
      await shot(mobile, "workbench-mobile-390-orbited");
      await mobile.getByRole("button", { name: "Reset 3D view" }).click();
      const session = await mobile.context().newCDPSession(mobile);
      const scene = await canvas.boundingBox();
      const cy = scene.y + scene.height * 0.38,
        cx = scene.x + scene.width / 2;
      const zoom = Number(await canvas.getAttribute("data-zoom"));
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: cx - 40, y: cy, id: 1 },
          { x: cx + 40, y: cy, id: 2 },
        ],
      });
      for (let d = 45; d <= 72; d += 5)
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            { x: cx - d, y: cy, id: 1 },
            { x: cx + d, y: cy, id: 2 },
          ],
        });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      assert.ok(
        Number(await canvas.getAttribute("data-zoom")) > zoom,
        "Pinch zoom changes only camera",
      );
      await expect(handle).toHaveAttribute("aria-valuenow", "180");
      await expect(mobile.getByRole("dialog")).not.toBeVisible();
      await mobile.getByRole("button", { name: "Reset 3D view" }).click();
      await mobile.evaluate(() => window.scrollTo(0, 0));
      const area = await canvas.boundingBox();
      const sy = area.y + area.height * 0.65;
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: area.x + 14, y: sy }],
      });
      for (let d = 20; d <= 150; d += 20)
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: area.x + 14, y: sy - d }],
        });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      assert.ok(
        (await mobile.evaluate(() => scrollY)) > 10,
        "Vertical swipe scrolls page",
      );
      checks.push(
        "3D width pointer/keyboard editing, orbit, real two-touch pinch and vertical page scrolling; gestures do not open sheets or mutate other values",
      );
    }
    assert.deepEqual(requests, []);
    checks.push(
      `${width}px: real WebGL render, first-screen precision rail, 44px targets, exact/invalid entry, focus restoration, material/light sheets, readable 260px chart, stale reference and zero API requests`,
    );
    await mobile.close();
    mobile = null;
  }
  let cancelled = false;
  let cancellationKind = "forward";
  let cancellationHash;
  await page.route("**/api/jobs**", async (route) => {
    if (route.request().method() === "POST") {
      cancelled = false;
      const request = route.request().postDataJSON();
      cancellationKind = request.kind;
      const validation = await page.request.post(
        "http://127.0.0.1:8000/api/validate",
        { data: request.project },
      );
      assert.ok(validation.ok());
      const validated = await validation.json();
      assert.equal(validated.valid, true);
      cancellationHash = validated.input_hash;
    }
    if (route.request().method() === "DELETE") cancelled = true;
    await route.fulfill({
      json: {
        id: "qa-cancel",
        kind: cancellationKind,
        status: cancelled ? "cancelled" : "running",
        input_hash: cancellationHash,
        created_at: new Date().toISOString(),
        completed_at: cancelled ? new Date().toISOString() : null,
        result: null,
        error: null,
        error_code: null,
      },
    });
  });
  await page.getByRole("button", { name: /Run simulation/ }).click();
  await expect(page.locator(".dimension-rail button").first()).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".message.success")).toContainText(
    "Calculation cancelled.",
  );
  await expect(page.locator(".dimension-rail button").first()).toBeEnabled();
  await page
    .getByRole("button", { name: "Run synthetic recovery", exact: true })
    .click();
  await page.getByRole("button", { name: "Cancel fit", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Run synthetic recovery", exact: true }),
  ).toBeEnabled();
  await page.unroute("**/api/jobs**");
  await menu();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  checks.push(
    "Forward/fit cancellation unlocks all geometry controls; saved dialog Escape dismissal",
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    `${output}/browser-qa.json`,
    JSON.stringify(
      {
        status: "passed",
        checks,
        pageErrors: errors,
        date: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "passed", checks }, null, 2));
} catch (error) {
  await mobile
    ?.screenshot({
      path: `${output}/browser-mobile-failure.png`,
      fullPage: true,
    })
    .catch(() => {});
  await page
    ?.screenshot({ path: `${output}/browser-failure.png`, fullPage: true })
    .catch(() => {});
  await fs.writeFile(
    `${output}/browser-qa.json`,
    JSON.stringify(
      { status: "failed", checks, error: String(error), pageErrors: errors },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
