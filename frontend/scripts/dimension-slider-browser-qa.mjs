// Production editor acceptance. Run only in CI's supported browser environment.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import {
  capture,
  closeSheet,
  menuAction,
  importText,
  applyImportedDesign,
} from "./browser-2d-controls.mjs";

const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const preview = process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173";
const report = {
  status: "running",
  checks: [],
  captures: [],
  screenshots: [],
  pageErrors: [],
  issues: [],
  limitations: [
    "Chromium touch emulation is not a physical-phone or spoken screen-reader test.",
    "Cancellation and focus-loss injections verify interaction cleanup, not numerical accuracy.",
  ],
};
let browser;
async function exported(page, name) {
  const pending = page.waitForEvent("download");
  pending.catch(() => {});
  await menuAction(page, "Export");
  const download = await pending;
  const path = `${output}/dimension-slider-${name}.json`;
  await download.saveAs(path);
  return JSON.parse(await fs.readFile(path, "utf8"));
}
async function preserved(page, project, baseline, name) {
  const actual = await exported(page, name);
  assert.deepEqual(actual.project, project, `${name}: exact current inputs`);
  assert.deepEqual(
    actual.result,
    baseline.result,
    `${name}: every original result value`,
  );
  assert.deepEqual(
    actual.result_project ?? actual.project,
    baseline.result_project ?? baseline.project,
    `${name}: original result binding`,
  );
}
function controls(page, kind, example) {
  const legacy = example === "1d";
  const card = legacy
    ? page.locator(".dimension-rail").getByRole("button", {
        name: new RegExp(
          kind === "pitch"
            ? "Shared pitch"
            : kind === "height"
              ? "Thickness"
              : "Width",
          "i",
        ),
      })
    : page.getByRole("button", {
        name:
          kind === "pitch"
            ? /^Edit shared pitch:/
            : new RegExp(
                `^Edit Layer 1 ${kind === "height" ? "thickness" : example === "circle" ? "diameter" : "width"}:`,
              ),
      });
  return {
    card,
    number: page.locator('dialog.inspector input[type="number"]').first(),
    range: page
      .locator('dialog.inspector .dimension-range input[type="range"]')
      .first(),
  };
}
function changedWidth(project, example, value) {
  const next = structuredClone(project);
  next.layers[0][
    example === "circle"
      ? "diameter_nm"
      : example === "1d"
        ? "cd_nm"
        : "cd_x_nm"
  ] = value;
  return next;
}
async function drag(page, range, touch, delta = 30, cancel = false) {
  await range.scrollIntoViewIfNeeded();
  const box = await range.boundingBox();
  assert.ok(
    box && box.height >= 44,
    "Actual slider hit area is at least44px high",
  );
  const values = await range.evaluate((node) => ({
    min: +node.min,
    max: +node.max,
    value: +node.value,
  }));
  const x =
      box.x +
      12 +
      ((box.width - 24) * (values.value - values.min)) /
        (values.max - values.min),
    y = box.y + box.height / 2;
  const end = Math.min(box.x + box.width - 13, x + delta);
  if (touch) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
      });
      for (let step = 1; step <= 5; step++)
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x + ((end - x) * step) / 5, y, id: 1 }],
        });
      await session.send("Input.dispatchTouchEvent", {
        type: cancel ? "touchCancel" : "touchEnd",
        touchPoints: [],
      });
    } finally {
      await session.detach();
    }
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(end, y, { steps: 5 });
    if (cancel)
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.up();
  }
  await expect
    .poll(async () => +(await range.inputValue()))
    .not.toBe(values.value);
  assert.equal(await range.getAttribute("min"), String(values.min));
  assert.equal(await range.getAttribute("max"), String(values.max));
  return +(await range.inputValue());
}
async function swipeVertically(page, range) {
  await range.scrollIntoViewIfNeeded();
  const box = await range.boundingBox();
  const values = await range.evaluate((node) => {
    node.dataset.testCanceled = "0";
    node.addEventListener(
      "pointercancel",
      () => {
        node.dataset.testCanceled = "1";
      },
      { once: true },
    );
    return { min: +node.min, max: +node.max, value: +node.value };
  });
  assert.ok(box && box.height >= 44);
  const x =
      box.x +
      12 +
      ((box.width - 24) * (values.value - values.min)) /
        (values.max - values.min),
    y = box.y + box.height / 2;
  const dialog = page.locator("dialog.inspector");
  const before = await dialog.evaluate((node) => node.scrollTop);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    for (let step = 1; step <= 8; step++)
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y - step * 12, id: 1 }],
      });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
  await expect(range).toHaveAttribute("data-test-canceled", "1");
  await expect
    .poll(() => dialog.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(before);
}

async function reset(page) {
  await menuAction(page, "Reset example");
  await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
}
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  for (const example of ["circle", "rectangle", "1d"])
    for (const width of [360, 390, 1440]) {
      const name = `${example}-${width}`,
        touch = width < 700;
      const context = await browser.newContext({
        viewport: {
          width,
          height: width === 360 ? 800 : width === 390 ? 844 : 1000,
        },
        isMobile: touch,
        hasTouch: touch,
      });
      const page = await context.newPage(),
        requests = [];
      page.on("pageerror", (error) =>
        report.pageErrors.push(`${name}: ${error.message}`),
      );
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/"))
          requests.push(request.url());
      });
      const url = new URL(preview);
      if (example !== "circle") url.searchParams.set("example", example);
      await page.goto(url.href);
      await expect(page.locator(".result-badge")).toHaveText(
        "Precomputed example",
      );
      const baseline = await exported(page, `${name}-baseline`),
        original = baseline.project;
      const { card, number, range } = controls(page, "width", example);
      await card.click();
      const initial = +(await number.inputValue()),
        typed = initial + 0.125;
      await number.fill(String(typed));
      await expect(range).toHaveAttribute(
        "aria-valuetext",
        `${typed} nanometers`,
      );
      const afterDrag = await drag(page, range, touch);
      await expect(number).toHaveValue(String(afterDrag));
      await capture(page, report, output, `${name}-width-slider`, {
        prefix: "dimension-slider",
      });
      await closeSheet(page);
      await preserved(
        page,
        changedWidth(original, example, afterDrag),
        baseline,
        `${name}-drag`,
      );
      await menuAction(page, "↶ Undo");
      await preserved(
        page,
        changedWidth(original, example, typed),
        baseline,
        `${name}-undo-drag`,
      );
      await menuAction(page, "↶ Undo");
      await preserved(page, original, baseline, `${name}-undo-typing`);
      await menuAction(page, "↷ Redo");
      await menuAction(page, "↷ Redo");
      await preserved(
        page,
        changedWidth(original, example, afterDrag),
        baseline,
        `${name}-redo`,
      );
      await reset(page);

      // A canceled gesture and a fresh gesture on the still-focused range are
      // exactly two edits, even when the browser sends multiple end signals.
      await card.click();
      const canceled = await drag(page, range, touch, 24, true);
      const second = await drag(page, range, touch, 24);
      await closeSheet(page, "Escape");
      await menuAction(page, "↶ Undo");
      await preserved(
        page,
        changedWidth(original, example, canceled),
        baseline,
        `${name}-undo-second`,
      );
      await menuAction(page, "↶ Undo");
      await preserved(page, original, baseline, `${name}-undo-canceled`);
      assert.notEqual(second, canceled);
      await reset(page);

      await card.click();
      await range.focus();
      for (let count = 0; count < 3; count++)
        await page.keyboard.down("ArrowRight");
      await page.keyboard.up("ArrowRight");
      await expect(number).toHaveValue(String(initial + 3));
      await closeSheet(page, "Close settings");
      await menuAction(page, "↶ Undo");
      await preserved(page, original, baseline, `${name}-held-key-undo`);
      await reset(page);

      await card.click();
      await range.focus();
      await page.keyboard.down("ArrowRight");
      await closeSheet(page, "Escape");
      await page.keyboard.up("ArrowRight");
      await card.click();
      await number.fill(String(initial + 2));
      await closeSheet(page);
      await menuAction(page, "↶ Undo");
      await preserved(
        page,
        changedWidth(original, example, initial + 1),
        baseline,
        `${name}-escape-new-edit-undo`,
      );
      await menuAction(page, "↶ Undo");
      await preserved(page, original, baseline, `${name}-escape-held-key-undo`);
      await reset(page);

      const pitch = controls(page, "pitch", example);
      await pitch.card.click();
      await expect(pitch.range).toHaveAttribute(
        "max",
        String(Math.ceil(Math.max(200, 2 * original.period_nm) / 100) * 100),
      );
      await pitch.number.fill("4200.123456789");
      await expect(pitch.range).toHaveAttribute("max", "5000");
      await expect(pitch.number).toHaveValue("4200.123456789");
      await expect(pitch.range).toHaveAttribute(
        "aria-valuetext",
        "4200.123456789 nanometers",
      );
      await capture(page, report, output, `${name}-exact-large-pitch`, {
        prefix: "dimension-slider",
      });
      await closeSheet(page, "Escape");
      const large = structuredClone(original);
      large.period_nm = 4200.123456789;
      await preserved(page, large, baseline, `${name}-exact-large`);
      await menuAction(page, "↶ Undo");
      await preserved(page, original, baseline, `${name}-undo-large`);
      await reset(page);

      const thickness = controls(page, "height", example);
      await thickness.card.click();
      await expect(thickness.range).toHaveAttribute(
        "max",
        String(
          Math.min(
            2000,
            Math.ceil(
              Math.max(200, 2 * original.layers[0].thickness_nm) / 100,
            ) * 100,
          ),
        ),
      );
      await thickness.range.focus();
      await page.keyboard.press("Home");
      await expect(thickness.number).toHaveValue("0");
      await closeSheet(page);
      await menuAction(page, "↶ Undo");
      await preserved(page, original, baseline, `${name}-zero-thickness-undo`);
      await reset(page);
      if (width === 360) {
        await page
          .getByRole("button", {
            name: example === "1d" ? "Layer settings" : "Layer settings ↗",
            exact: true,
          })
          .click();
        const layerRange = page
          .locator("dialog.inspector .dimension-field .dimension-range input")
          .first();
        await expect(layerRange).toHaveAccessibleName("Thickness range");
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        assert.equal(
          await page
            .locator("dialog.inspector")
            .evaluate((node) => node.scrollWidth <= node.clientWidth),
          true,
        );
        await swipeVertically(page, layerRange);
        await capture(page, report, output, `${name}-layer-settings-scroll`, {
          prefix: "dimension-slider",
        });
        const depth = await drag(page, layerRange, true, 24);
        await closeSheet(page, "Close settings");
        const edited = structuredClone(original);
        edited.layers[0].thickness_nm = depth;
        await preserved(page, edited, baseline, `${name}-layer-drag`);
        await menuAction(page, "↶ Undo");
        await preserved(page, original, baseline, `${name}-layer-drag-undo`);
        await reset(page);
      }
      assert.deepEqual(
        requests,
        [],
        "Static slider interactions never request validation, solving or saving",
      );
      report.checks.push(
        `${name}: native ${touch ? "touch + touchcancel" : "mouse + window-blur"}, typed-to-drag separation, repeated gestures, exact Undo/Redo/result identity, held physical keys, local bounds and full-domain exact entry passed.`,
      );
      await context.close();
    }

  // Fractional true limits, zero-span pitch and huge-period/small-hole reuse.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) =>
    report.pageErrors.push(`edge: ${error.message}`),
  );
  const edgeRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      edgeRequests.push(request.url());
  });
  await page.goto(preview);
  await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
  const baseline = await exported(page, "edge-baseline");
  const edge = structuredClone(baseline.project);
  edge.period_nm = 5000;
  edge.period_y_nm = 140.25;
  edge.layers[0].diameter_nm = 70.123456789;
  await importText(page, { project: edge }, "slider-fractional-edge");
  await applyImportedDesign(page);
  const field = controls(page, "width", "circle");
  await field.card.click();
  await expect(field.number).toHaveValue("70.123456789");
  await expect(field.range).toHaveAttribute("max", "140.25");
  await field.range.focus();
  await page.keyboard.press("End");
  await expect(field.number).toHaveValue("140.25");
  await closeSheet(page);
  await menuAction(page, "↶ Undo");
  await preserved(page, edge, baseline, "fractional-endpoint-undo");
  edge.period_y_nm = 5000;
  await importText(page, { project: edge }, "slider-huge-pitch");
  await applyImportedDesign(page);
  await field.card.click();
  await expect(field.range).toHaveAttribute("max", "200");
  await closeSheet(page);
  edge.layers[0].diameter_nm = 5000;
  await importText(page, { project: edge }, "slider-zero-span");
  await applyImportedDesign(page);
  const pitch = controls(page, "pitch", "circle");
  await pitch.card.click();
  await expect(pitch.range).toBeDisabled();
  await expect(pitch.range).toHaveAttribute("min", "5000");
  await expect(pitch.range).toHaveAttribute("max", "5000");
  await expect(pitch.number).toHaveValue("5000");
  await closeSheet(page);
  const fractional = structuredClone(baseline.project);
  fractional.period_nm = 150.12345678901234;
  fractional.period_y_nm = 140.12345678901234;
  fractional.layers[0].geometry = "rectangle_2d";
  fractional.layers[0].cd_x_nm = 70.12345678901234;
  fractional.layers[0].cd_y_nm = 60.12345678901234;
  delete fractional.layers[0].diameter_nm;
  await importText(page, { project: fractional }, "slider-long-grid-labels");
  await applyImportedDesign(page);
  await page
    .getByRole("button", { name: "Layer settings ↗", exact: true })
    .click();
  const grid = page.locator("dialog.inspector .field-grid");
  await grid.scrollIntoViewIfNeeded();
  assert.equal(
    await page
      .locator("dialog.inspector")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  for (const label of await grid.locator(".range-labels > span").all())
    assert.equal(
      await label.evaluate((node) => node.scrollWidth <= node.clientWidth),
      true,
    );
  await capture(page, report, output, "fractional-grid-endpoints", {
    prefix: "dimension-slider",
  });
  await closeSheet(page, "Close settings");
  assert.deepEqual(
    edgeRequests,
    [],
    "Edge imports and slider edits are API-free",
  );
  await context.close();
  report.checks.push(
    "Fractional physical max remains reachable; off-grid exact imports do not snap; huge periods retain a usable small-diameter range; a zero-span range is disabled.",
  );
  assert.deepEqual(report.pageErrors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.issues.push(error.stack || String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fs.writeFile(
    `${output}/dimension-slider-browser-report.json`,
    JSON.stringify(report, null, 2),
  );
}
