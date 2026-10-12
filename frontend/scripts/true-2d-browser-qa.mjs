// Retained rectangular 2D acceptance via the explicit historical example route. Run only in the supported CI browser
// environment with local API/dev (:8000/:5173) and static preview (:4173) ready.
// No prototype page, React state injection, or mocked numerical proof.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium, expect as baseExpect } from "@playwright/test";
import {
  canvas2D,
  widthCard,
  pitchCard,
  clone,
  closeSheet,
  menuAction,
  exportWorkspace,
  importText,
  applyImportedDesign,
  editY,
  capture,
  CAPTURE_BUDGET_MS,
  activeCapture,
  verifyCaptureFile,
  assertScene,
  assertFullResult,
  replayTouch,
} from "./browser-2d-controls.mjs";
const expect = baseExpect.configure({ timeout: 5000 });
const rectangleUrl = (value) => {
  const url = new URL(value);
  url.searchParams.set("example", "rectangle");
  return url.href;
};
const appUrl = rectangleUrl(
  process.env.RCWA_APP_URL || "http://127.0.0.1:5173",
);
const previewUrl = rectangleUrl(
  process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173",
);
const apiUrl = process.env.RCWA_API_URL || "http://127.0.0.1:8000";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const originalBytes = await fs.readFile(
  new URL(
    "../../backend/tests/fixtures/true-2d/default-project.json",
    import.meta.url,
  ),
);
const original = JSON.parse(originalBytes);
const referenceBytes = await fs.readFile(
  new URL("../public/reference-2d.json", import.meta.url),
);
const reference = JSON.parse(referenceBytes);
const manifest = JSON.parse(
  await fs.readFile(
    new URL("../src/fixtures/reference-2d-manifest.json", import.meta.url),
    "utf8",
  ),
);
const expectedHash =
  "eeb26da3484602221944f1784b4b93ce2ed76f89b61e95d34bb68730be7bddc7";
const started = Date.now();
const report = {
  status: "running",
  startedAt: new Date(started).toISOString(),
  source:
    "Production entry point, explicit rectangular example URL; exact historical 1.2 fixture/reference",
  screenshotPolicy: {
    serialPageGroups: true,
    playwrightTimeoutMs: CAPTURE_BUDGET_MS.playwright,
    cdpRetryTimeoutMs: CAPTURE_BUDGET_MS.cdp,
    groupTimeoutWaitsForActiveCapture: true,
  },
  limitations: [
    "Chromium mobile/touch replay is not a real-phone onscreen keyboard or spoken screen-reader test.",
    "Real backend exposes running, succeeded, failed and cancelled; transported queued is an explicitly adversarial invalid-contract case.",
    "Transport fault injections are UI contract evidence, not independent numerical verification.",
  ],
  groups: [],
  checks: [],
  captures: [],
  screenshots: [],
  pageErrors: [],
  issues: [],
  geometry: [],
  touches: [],
  api: [],
  jobs: [],
  artifacts: [],
};
let browser;
const liveJobs = new Set();
const liveSnapshots = [];
const required = [];
let capability;
const pathOf = (item) => new URL(item.url()).pathname;
const isResponse = (r, path, method = "GET") =>
  pathOf(r) === `/api${path}` && r.request().method() === method;
function responseFor(page, predicate, options) {
  const pending = page.waitForResponse(predicate, options);
  // Preserve rejection for the awaited path without an unhandled rejection
  // when an earlier assertion fails before a paired response is awaited.
  pending.catch(() => {});
  return pending;
}
const briefJob = (j) => ({
  id: j.id,
  kind: j.kind,
  status: j.status,
  input_hash: j.input_hash,
  error: j.error,
  error_code: j.error_code,
  resultHash: j.result?.metadata?.input_hash,
});
async function http(
  path,
  body,
  method = body === undefined ? "GET" : "POST",
  expected = 200,
) {
  const response = await fetch(`${apiUrl}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path}: non-JSON ${response.status}`);
  }
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${text.slice(0, 1000)}`,
  );
  return data;
}
async function group(
  name,
  run,
  {
    width = 1440,
    height = width === 360 ? 800 : width === 390 ? 844 : 1000,
    timeout = 30000,
  } = {},
) {
  required.push(name);
  const record = {
    name,
    status: "running",
    startedMs: Date.now() - started,
    timeoutMs: timeout,
    checks: [],
  };
  report.groups.push(record);
  let context, page, timer;
  try {
    assert.ok(
      Date.now() - started < 280000,
      "Suite budget exhausted before this required group",
    );
    context = await browser.newContext({
      viewport: { width, height },
      isMobile: width < 700,
      hasTouch: width < 700,
      acceptDownloads: true,
      serviceWorkers: "block",
    });
    page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(12000);
    page.on("pageerror", (error) =>
      report.pageErrors.push({ group: name, error: error.message }),
    );
    page.on("request", (request) => {
      if (pathOf(request).startsWith("/api/"))
        report.api.push({
          group: name,
          method: request.method(),
          path: pathOf(request),
        });
    });
    timer = setTimeout(() => {
      record.timeout = true;
      const captureFinished = activeCapture(page);
      if (captureFinished) {
        record.timeoutDeferredForCapture = true;
        void captureFinished.then(() => context.close().catch(() => {}));
      } else void context.close().catch(() => {});
    }, timeout);
    await run(page, record);
    assert.equal(
      record.timeout,
      undefined,
      "Required group exceeded its bounded time budget",
    );
    record.status = "passed";
    report.checks.push(name);
  } catch (error) {
    record.status = "failed";
    record.error = String(error);
    report.issues.push({ group: name, error: String(error) });
    if (page && !page.isClosed() && !record.timeout) {
      try {
        await capture(page, report, output, `${name}-failure`, { top: false });
      } catch (failure) {
        record.failureCaptureError = String(failure);
      }
    }
  } finally {
    clearTimeout(timer);
    await context?.close().catch(() => {});
    record.elapsedMs = Date.now() - started - record.startedMs;
    await fs.writeFile(
      `${output}/true-2d-browser-qa.json`,
      JSON.stringify(report, null, 2),
    );
  }
}
async function ready(page, url = previewUrl, referenceExpected = true) {
  await page.goto(url);
  await expect(canvas2D(page)).toHaveAttribute("data-ready", "true");
  if (referenceExpected)
    await expect(page.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
  await page.evaluate(() => document.fonts.ready);
}
async function exported(page, name) {
  const value = await exportWorkspace(page, output, name);
  report.artifacts.push(value.path.split("/").at(-1));
  return value;
}
async function projectEquals(
  page,
  expected,
  name,
  result = reference.result,
  resultProject = original,
) {
  const value = await exported(page, name);
  assert.deepEqual(
    value.data.project,
    expected,
    "Exported project preserves every exact input",
  );
  if (result !== undefined)
    assert.deepEqual(
      value.data.result,
      result,
      "Full result, all directions/channels/metadata, remains exact",
    );
  if (resultProject !== undefined)
    assert.deepEqual(
      value.data.result_project,
      resultProject,
      "Result retains its exact original input",
    );
  return value;
}
async function rejectImport(page, text, name, baseline, pattern = /./) {
  const dismiss = page.getByRole("button", { name: "Dismiss error" });
  if (await dismiss.isVisible()) await dismiss.click();
  await importText(page, text, name);
  await expect(page.locator(".message.error")).toContainText(pattern);
  assert.deepEqual(
    stable((await exported(page, `${name}-preserved`)).data),
    stable(baseline),
  );
  await expect(page.locator("dialog[open]")).toHaveCount(0);
}
async function desktopSheetDiagnostics(page, record, name) {
  // One bounded DOM snapshot per desktop paired-sheet state, under the
  // existing group deadline. No extra waits, altered styles or capture paths.
  const state = await page.locator("dialog.inspector").evaluate((dialog) => {
    const canvas = document.querySelector(".s2-webgl canvas");
    const focused = document.activeElement;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      scroll: { x: scrollX, y: scrollY },
      dialog: {
        open: dialog.open,
        title: dialog.querySelector("h2")?.textContent,
        bounds: dialog.getBoundingClientRect().toJSON(),
        backdropFilter: getComputedStyle(dialog, "::backdrop").backdropFilter,
        backdropColor: getComputedStyle(dialog, "::backdrop").backgroundColor,
        inputs: [...dialog.querySelectorAll("input")].map((input) => ({
          label: [...(input.labels || [])]
            .map((label) => label.textContent?.trim())
            .join(" "),
          value: input.value,
          axis: input.dataset.axis,
          focused: input === focused,
        })),
      },
      scene: canvas
        ? {
            ready: canvas.dataset.ready,
            selectedLayer: canvas.dataset.selectedLayer,
            cutaway: canvas.dataset.cutaway,
            physicalScale: canvas.dataset.physicalScale,
            renderedRegionCount: canvas.dataset.renderedRegionCount,
          }
        : null,
    };
  });
  (record.captureDOM ??= []).push({ name, ...state });
  assert.equal(state.dialog.open, true);
  assert.equal(
    state.dialog.backdropFilter,
    "none",
    "Production 2D paired sheets keep the scrim without a filtered WebGL backdrop",
  );
  assert.equal(state.scene?.ready, "true");
  return state;
}
async function staticTasks(width) {
  await group(
    `static-${width}`,
    async (page, record) => {
      await ready(page);
      await expect(page.locator(".connection")).toHaveText("Static preview");
      await projectEquals(page, original, `${width}-default`);
      assertFullResult(reference.result, original);
      assert.equal(original.layers.length, 3);
      await expect(page.locator(".stack-row")).toHaveCount(3);
      assert.deepEqual(await page.locator(".stack-name").allTextContents(), [
        "Pattern",
        "Film",
        "Pattern",
      ]);
      assert.equal(
        await page.locator(".advanced-settings").evaluate((n) => n.open),
        false,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      const height = width === 360 ? 800 : width === 390 ? 844 : 1000;
      for (const target of [
        page.locator(".preview-result-button"),
        ...(await page.locator(".stack-row").all()),
      ]) {
        const box = await target.boundingBox();
        assert.ok(
          box &&
            box.x >= -1 &&
            box.x + box.width <= width + 1 &&
            box.y >= 0 &&
            box.y + box.height <= height,
          `Complete chips/CTA fit ${width}: ${JSON.stringify(box)}`,
        );
        assert.ok(
          box.height >= 44,
          "Initial mobile actions retain touch target height",
        );
      }
      await expect(page.locator(".s2-dimensions > button")).toHaveCount(3);
      await expect(
        page.getByRole("slider", { name: /Drag (width|height|pitch)/ }),
      ).toHaveCount(0);
      record.geometry = await assertScene(page, original, true);
      report.geometry.push({
        group: record.name,
        view: "cutaway",
        ...record.geometry,
      });
      await capture(page, report, output, `${width}-initial-cutaway`);
      await page
        .getByRole("combobox", { name: "Structure view", exact: true })
        .selectOption("full");
      report.geometry.push({
        group: record.name,
        view: "full",
        ...(await assertScene(page, original, false)),
      });
      await projectEquals(page, original, `${width}-view-only`);
      const menu = page.locator(".project-menu");
      if (!(await menu.evaluate((n) => n.open)))
        await menu.locator("summary").click();
      await expect(
        page.getByRole("button", { name: "↶ Undo", exact: true }),
      ).toBeDisabled();
      await menu.locator("summary").click();
      await capture(page, report, output, `${width}-full-stack`);
      await page
        .getByRole("combobox", { name: "Structure view", exact: true })
        .selectOption("cutaway");
      await page.getByRole("button", { name: /^Select layer 2:/ }).click();
      await expect(page.locator(".s2-dimensions > button")).toHaveCount(2);
      await expect(
        page.getByRole("button", { name: /^Edit Layer 2 width:/ }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: /^Select layer 3:/ }).click();
      await expect(page.locator(".s2-selection")).toHaveText(
        "Selected: Layer 3",
      );
      await expect(canvas2D(page)).toHaveAttribute("data-selected-layer", "2");
      await capture(page, report, output, `${width}-bottom-selected`);
      await widthCard(page).click();
      await expect(
        page.getByRole("dialog", { name: /^Layer 3 · Width/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("spinbutton", { name: "Width X nm", exact: true }),
      ).toHaveValue("95");
      const y = page.getByRole("spinbutton", {
        name: "Width Y nm",
        exact: true,
      });
      await expect(y).toHaveValue("80");
      await y.focus();
      await capture(page, report, output, `${width}-open-width-fields`, {
        diagnostics:
          width === 1440
            ? await desktopSheetDiagnostics(page, record, "open-width-fields")
            : undefined,
      });
      await y.fill("85");
      await y.fill("90");
      await closeSheet(page);
      await expect(widthCard(page)).toBeFocused();
      const changed = clone(original);
      changed.layers[2].cd_y_nm = 90;
      await projectEquals(page, changed, `${width}-width-y-only`);
      await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
      await expect(page.locator(".stale-note")).toHaveText(
        "This stored spectrum no longer matches your inputs.",
      );
      await pitchCard(page).click();
      const pitchY = page.getByRole("spinbutton", {
        name: "Pitch Y nm",
        exact: true,
      });
      await expect(
        page.getByRole("spinbutton", { name: "Pitch X nm", exact: true }),
      ).toHaveValue("150");
      await expect(pitchY).toHaveValue("140");
      await pitchY.focus();
      await capture(page, report, output, `${width}-open-pitch-fields`, {
        diagnostics:
          width === 1440
            ? await desktopSheetDiagnostics(page, record, "open-pitch-fields")
            : undefined,
      });
      await pitchY.fill("150");
      await pitchY.fill("160");
      await closeSheet(page);
      changed.period_y_nm = 160;
      await projectEquals(page, changed, `${width}-shared-y-only`);
      for (const dismissal of ["Done", "Close settings", "Escape"]) {
        await pitchCard(page).click();
        await pitchY.fill("89");
        await expect(pitchY).toHaveAttribute("aria-invalid", "true");
        await expect(page.locator(".s2-error")).toHaveText(
          "Pitch Y must be at least 90 nm because of Layer 3. 89 is not applied. Keeping 160 nm.",
        );
        if (dismissal === "Done")
          await capture(page, report, output, `${width}-invalid-pitch-y`);
        await closeSheet(page, dismissal);
        await expect(pitchCard(page)).toBeFocused();
        await projectEquals(
          page,
          changed,
          `${width}-invalid-${dismissal.replace(/ /g, "-")}`,
        );
      }
      // One undo per field focus/gesture, never per keystroke or rejected draft.
      await menuAction(page, "↶ Undo");
      changed.period_y_nm = 140;
      await projectEquals(page, changed, `${width}-undo-pitch`);
      await expect(page.locator(".s2-selection")).toHaveText(
        "Selected: Layer 3",
      );
      await menuAction(page, "↶ Undo");
      await projectEquals(page, original, `${width}-undo-width`);
      await expect(page.locator(".result-badge")).toHaveText(
        "Precomputed example",
      );
      await menuAction(page, "↷ Redo");
      await projectEquals(page, changed, `${width}-redo-width`);
      await menuAction(page, "↷ Redo");
      changed.period_y_nm = 160;
      await projectEquals(page, changed, `${width}-redo-pitch`);
      report.geometry.push({
        group: record.name,
        view: "edited",
        ...(await assertScene(page, changed, true)),
      });
      await capture(page, report, output, `${width}-edited`);
      await page.getByRole("button", { name: "Use this design locally", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Use this design locally" })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.locator("#spectrum").scrollIntoViewIfNeeded();
      await expect(page.locator(".spectrum-svg")).toBeVisible();
      await capture(page, report, output, `${width}-stale-spectrum`, {
        top: false,
      });
      await page.locator("#fit > summary").click();
      await expect(page.locator(".fit-explanation")).toContainText(
        "not supported for schema 1.2",
      );
      await expect(page.locator("#fit input, #fit button")).toHaveCount(0);
      assert.equal(
        report.api.filter((entry) => entry.group === record.name).length,
        0,
        "Static Pages makes zero API calls",
      );
      record.checks.push(
        "Exact fixture/full reference; full/cutaway/selection view-only; paired fields; axis isolation; invalid Done/Close/Escape; one-step history; exact stale original pair; static zero API",
      );
    },
    { width, timeout: 45000 },
  );
}
const stable = ({ exported_at: _timestamp, ...rest }) => rest;
async function touchAndLayers(width) {
  await group(
    `touch-layers-${width}`,
    async (page, record) => {
      await ready(page);
      const canvas = canvas2D(page);
      const beforeCamera = await canvas.getAttribute("data-camera-state");
      assert.ok(
        beforeCamera,
        "Production camera state must be derived from actual camera/controls",
      );
      const box = await canvas.boundingBox();
      assert.ok(box);
      const x = box.x + box.width * 0.45,
        y = box.y + box.height * 0.55;
      await replayTouch(
        page,
        [{ x, y, id: 1 }],
        Array.from({ length: 8 }, (_, i) => [{ x: x + (i + 1) * 7, y, id: 1 }]),
      );
      await expect
        .poll(() => canvas.getAttribute("data-camera-state"))
        .not.toBe(beforeCamera);
      await expect(canvas).toHaveAttribute("data-selected-layer", "0");
      const orbitCamera = await canvas.getAttribute("data-camera-state");
      await replayTouch(
        page,
        [
          { x: x - 20, y, id: 1 },
          { x: x + 20, y, id: 2 },
        ],
        Array.from({ length: 8 }, (_, i) => [
          { x: x - 20 - (i + 1) * 3, y, id: 1 },
          { x: x + 20 + (i + 1) * 3, y, id: 2 },
        ]),
      );
      await expect
        .poll(() => canvas.getAttribute("data-camera-state"))
        .not.toBe(orbitCamera);
      await expect(canvas).toHaveAttribute("data-selected-layer", "0");
      const pinchCamera = await canvas.getAttribute("data-camera-state");
      await capture(page, report, output, `${width}-touch-zoom-before-reset`);
      await page.getByLabel("View guide", { exact: true }).click();
      await page
        .getByRole("button", { name: "Reset view", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "View guide details", exact: true }),
      ).not.toBeVisible();
      await expect(canvas).toBeFocused();
      await expect(canvas).toHaveAttribute("data-selected-layer", "0");
      const initialCamera = JSON.parse(beforeCamera);
      await expect
        .poll(async () => {
          const current = JSON.parse(
            await canvas.getAttribute("data-camera-state"),
          );
          return ["position", "target"].every((key) =>
            current[key].every(
              (value, axis) =>
                Math.abs(value - initialCamera[key][axis]) < 1e-7,
            ),
          );
        })
        .toBe(true);
      const resetCamera = JSON.parse(
        await canvas.getAttribute("data-camera-state"),
      );
      for (const key of ["position", "target"])
        resetCamera[key].forEach((value, axis) =>
          assert.ok(
            Math.abs(value - initialCamera[key][axis]) < 1e-7,
            `Reset restores initial ${key} axis ${axis}`,
          ),
        );
      const fit = JSON.parse(
        await canvas.getAttribute("data-projected-bounds"),
      );
      const fittedCanvas = await canvas.boundingBox();
      assert.ok(
        fittedCanvas &&
          fit.left >= 17 &&
          fit.right <= fittedCanvas.width - 17 &&
          fit.top >= 49 &&
          fit.bottom <= fittedCanvas.height - 31,
        `Reset fits the complete geometry inside overlay insets: ${JSON.stringify({ fit, fittedCanvas })}`,
      );
      await projectEquals(page, original, `${width}-reset-view-only`);
      const projectMenu = page.locator(".project-menu");
      await projectMenu.locator("summary").click();
      await expect(
        page.getByRole("button", { name: "↶ Undo", exact: true }),
      ).toBeDisabled();
      await projectMenu.locator("summary").click();
      await capture(page, report, output, `${width}-touch-reset-fit`);
      await replayTouch(
        page,
        [{ x, y, id: 1 }],
        Array.from({ length: 8 }, (_, i) => [
          { x, y: y - (i + 1) * 14, id: 1 },
        ]),
      );
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(10);
      const scrolledY = await page.evaluate(() => scrollY);
      await expect(canvas).toHaveAttribute("data-selected-layer", "0");
      await projectEquals(page, original, `${width}-touch-view-only`);
      report.touches.push({
        width,
        orbitChanged: orbitCamera !== beforeCamera,
        pinchChanged: pinchCamera !== orbitCamera,
        scrollY: scrolledY,
        resetRestoredCamera: true,
        resetProjectedBounds: fit,
        selection: 0,
      });
      await page.evaluate(() => window.scrollTo(0, 0));
      // Add inserts immediately after the selected layer. Select the bottom
      // first so the bounded eight-layer exercise intentionally appends.
      await page.getByRole("button", { name: /^Select layer 3:/ }).click();
      await expect(canvas).toHaveAttribute("data-selected-layer", "2");
      for (let count = 4; count <= 8; count++) {
        await page.getByLabel("Add layer", { exact: true }).click();
        await page
          .getByRole("button", { name: "Add patterned layer", exact: true })
          .click();
        await expect(page.locator(".stack-row")).toHaveCount(count);
        await expect(page.locator(".s2-selection")).toHaveText(
          `Selected: Layer ${count}`,
        );
      }
      const eight = (await exported(page, `${width}-eight-layers`)).data
        .project;
      assert.equal(eight.schema_version, "1.2");
      assert.equal(eight.layers.length, 8);
      assert.deepEqual(eight.layers.slice(0, 3), original.layers);
      assert.ok(
        eight.layers
          .slice(3)
          .every((layer) => layer.geometry === "rectangle_2d"),
      );
      const selected = await page
        .locator('[data-layer-index="7"]')
        .boundingBox();
      const strip = await page.locator(".stack-rows").boundingBox();
      assert.ok(
        selected &&
          strip &&
          selected.x >= strip.x - 1 &&
          selected.x + selected.width <= strip.x + strip.width + 1,
        "Selected eighth layer is revealed in scroll strip",
      );
      await expect(
        page.getByLabel("Add layer", { exact: true }),
      ).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByLabel("Add layer", { exact: true })).toContainText(
        "8-layer limit",
      );
      await page.getByLabel("Add layer", { exact: true }).click();
      assert.equal(
        await page.locator(".stack-add").evaluate((n) => n.open),
        false,
      );
      await expect(page.locator(".stack-row")).toHaveCount(8);
      await widthCard(page, 8).click();
      await expect(
        page.getByRole("spinbutton", { name: "Width Y nm", exact: true }),
      ).toBeVisible();
      await closeSheet(page, "Escape");
      await capture(page, report, output, `${width}-eight-selected-limit`);
      assert.equal(
        report.api.filter((entry) => entry.group === record.name).length,
        0,
      );
      record.checks.push(
        "Bounded real CDP touch orbit/pinch/pan-y without edits or accidental picks; eight-layer selected visibility and add limit",
      );
    },
    { width, timeout: 40000 },
  );
}
async function fallback(kind, width) {
  await group(
    `webgl-${kind}-${width}`,
    async (page, record) => {
      if (kind === "unavailable")
        await page.addInitScript(() => {
          const getContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            if (/^(webgl2?|experimental-webgl)$/.test(type)) return null;
            return getContext.call(this, type, ...args);
          };
        });
      await page.goto(previewUrl);
      await expect(page.locator(".result-badge")).toHaveText(
        "Precomputed example",
      );
      if (kind === "context-loss") {
        await expect(canvas2D(page)).toHaveAttribute("data-ready", "true");
        const lost = await canvas2D(page).evaluate((canvas) => {
          const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
          const extension = gl?.getExtension("WEBGL_lose_context");
          canvas.__qaLossExtension = extension;
          extension?.loseContext();
          return !!extension;
        });
        assert.equal(
          lost,
          true,
          "Actual WebGL context-loss extension is required for this evidence",
        );
      }
      await expect(page.locator(".s2-fallback")).toContainText(
        "2D view · 3D unavailable.",
      );
      await expect(page.locator(".s2-webgl")).toHaveAttribute(
        "data-fallback",
        "true",
      );
      const guide = page.getByLabel("View guide", { exact: true });
      await guide.focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("button", { name: "Reset view", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("combobox", { name: "Structure view", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("img", {
          name: "Selected layer top view, X–Y",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("img", {
          name: "Stack center section, X–Z at Y=0",
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("region", { name: "View guide details", exact: true }),
      ).not.toBeVisible();
      await expect(guide).toBeFocused();
      await editY(page, 90);
      const changed = clone(original);
      changed.layers[2].cd_y_nm = 90;
      await pitchCard(page).click();
      await page
        .getByRole("spinbutton", { name: "Pitch Y nm", exact: true })
        .fill("160");
      await closeSheet(page);
      changed.period_y_nm = 160;
      await page
        .getByRole("button", { name: /^Edit Layer 3 thickness:/ })
        .click();
      await page.locator("#dimension-height").fill("131");
      await closeSheet(page, "Close settings");
      changed.layers[2].thickness_nm = 131;
      await projectEquals(page, changed, `${width}-${kind}-editable`);
      await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
      await capture(page, report, output, `${width}-${kind}-fallback`);
      if (kind === "context-loss") {
        await pitchCard(page).focus();
        await canvas2D(page).evaluate((canvas) => {
          canvas.__qaLossExtension.restoreContext();
        });
        await expect(canvas2D(page)).toHaveAttribute("data-ready", "true");
        await expect(page.locator(".s2-fallback")).toHaveCount(0);
        await expect(pitchCard(page)).toBeFocused();
        await assertScene(page, changed, true);
        await projectEquals(page, changed, `${width}-${kind}-restored`);
        await expect(page.locator(".result-badge")).toHaveText(
          "Inputs changed",
        );
        await capture(page, report, output, `${width}-${kind}-restored`);
      }
      assert.equal(
        report.api.filter((entry) => entry.group === record.name).length,
        0,
      );
    },
    { width, timeout: 40000 },
  );
}
async function importsAndEdges() {
  await group(
    "import-integrity",
    async (page, record) => {
      await ready(page);
      const baseline = (await exported(page, "import-baseline")).data;
      await rejectImport(page, "{not JSON", "invalid-json", baseline);
      const rawInteger = JSON.stringify(original).replace(
        '"harmonics_x":5',
        '"harmonics_x":5.0',
      );
      assert.notEqual(rawInteger, JSON.stringify(original));
      await rejectImport(
        page,
        rawInteger,
        "raw-harmonics-5-point-0",
        baseline,
        /integer|harmonics|token/i,
      );
      const mismatched = clone(reference);
      mismatched.project.period_y_nm = 160;
      await rejectImport(
        page,
        mismatched,
        "unbound-y-result",
        baseline,
        /Invalid 1\.2 result: Order ky is inconsistent\./,
      );
      await expect(page.locator(".message.error")).toContainText(
        "Import the project only to recover its inputs.",
      );
      await expect(page.locator(".result-badge")).toHaveText(
        "Precomputed example",
      );
      for (const schema of [
        "rcwa-change-proposal/1.0",
        "rcwa-change-proposal/1.1",
      ]) {
        await rejectImport(
          page,
          {
            schema_version: schema,
            base_project: original,
            candidate_project: original,
          },
          `unsupported-proposal-${schema.slice(-3)}`,
          baseline,
          /1\.2|unsupported|not supported/i,
        );
        await expect(page.getByRole("dialog")).not.toBeVisible();
      }
      await page.evaluate(() => {
        const text = File.prototype.text;
        File.prototype.text = function () {
          if (this.name === "true-2d-read-failure.json")
            return Promise.reject(
              new Error("Intentional browser file read failure"),
            );
          return text.call(this);
        };
      });
      await rejectImport(
        page,
        original,
        "read-failure",
        baseline,
        /file read failure/i,
      );
      const forged = {
        ...reference,
        provenance: {
          source: "server_computed",
          input_hash: expectedHash,
          job_id: "forged-file",
        },
        resultOrigin: "server",
      };
      await importText(page, forged, "forged-origin");
      await expect(page.locator(".result-badge")).toHaveText(
        "Unverified import",
      );
      await expect(page.locator(".result-badge")).toHaveAttribute(
        "title",
        /not trusted/,
      );
      const pair = await projectEquals(
        page,
        original,
        "unverified-import-full",
      );
      assert.equal(pair.data.provenance, undefined);
      await capture(page, report, output, "imported-unverified");
      record.checks.push(
        "Malformed/read-failed/raw-integer/unbound-result/proposal imports preserve exact workspace; imported source claims never become server provenance",
      );
    },
    { timeout: 35000 },
  );
  await group(
    "mixed-boundary-signed-zero",
    async (page) => {
      await ready(page);
      const mixed = clone(original);
      mixed.layers[0].cd_x_nm = mixed.period_nm;
      mixed.layers[0].cd_y_nm = mixed.period_y_nm;
      mixed.layers[1].thickness_nm = 0;
      mixed.layers[2].geometry = "rectangle_1d";
      mixed.layers[2].cd_nm = 95;
      delete mixed.layers[2].cd_x_nm;
      delete mixed.layers[2].cd_y_nm;
      await importText(page, mixed, "mixed-full-zero");
      await applyImportedDesign(page);
      await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
      await projectEquals(
        page,
        mixed,
        "mixed-full-zero-export",
        reference.result,
        original,
      );
      await page
        .getByRole("combobox", { name: "Structure view", exact: true })
        .selectOption("full");
      report.geometry.push({
        group: "mixed-boundary-signed-zero",
        ...(await assertScene(page, mixed, false)),
      });
      await page.getByRole("button", { name: /^Select layer 3:/ }).click();
      await widthCard(page).click();
      await expect(
        page.getByRole("spinbutton", { name: "Width X nm", exact: true }),
      ).toHaveValue("95");
      await expect(
        page.getByRole("spinbutton", { name: "Width Y nm", exact: true }),
      ).toHaveCount(0);
      await closeSheet(page);
      await page.getByRole("button", { name: /Layer settings/ }).click();
      await expect(page.locator("dialog.inspector")).toContainText(
        "This ridge is uniform along Y.",
      );
      await closeSheet(page, "Close settings");
      const zero = clone(original);
      zero.layers[0].cd_y_nm = 0;
      zero.illumination.angle_deg = 0;
      const signedText = JSON.stringify(zero).replace(
        '"angle_deg":0',
        '"angle_deg":-0.0',
      );
      await importText(page, signedText, "signed-zero");
      await applyImportedDesign(page);
      // Input-only Apply retains the current layer. Check that contract before
      // explicitly selecting the layer whose zero-Y width this case examines.
      await expect(
        page.getByRole("button", { name: /^Select layer 3:/ }),
      ).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: /^Select layer 1:/ }).click();
      await expect(
        page.getByRole("button", { name: /^Select layer 1:/ }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("button", { name: /^Edit Layer 1 width:/ }),
      ).toHaveAccessibleName(/Y 0 nanometers/);
      const value = await exported(page, "signed-zero-export");
      assert.ok(
        Object.is(value.data.project.illumination.angle_deg, -0),
        "Signed zero survives raw import and export",
      );
      assert.match(value.text, /"angle_deg"\s*:\s*-0(?:\.0)?(?:[,}])/);
      await expect(page.locator(".s2-model-note")).toContainText(
        "zero pattern width",
      );
      report.geometry.push({
        group: "mixed-boundary-signed-zero",
        ...(await assertScene(page, value.data.project, false)),
      });
      await capture(page, report, output, "mixed-boundary-zero-width");
    },
    { timeout: 30000 },
  );
}
async function startupRace() {
  await group(
    "startup-reference-race",
    async (page) => {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let requested = false;
      await page.route("**/reference-2d.json", async (route) => {
        requested = true;
        await gate;
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: referenceBytes,
          })
          .catch(() => {});
      });
      try {
        await ready(page, previewUrl, false);
        await expect.poll(() => requested).toBe(true);
        await expect(page.locator(".result-badge")).toHaveText("No result yet");
        await editY(page, 90);
        const changed = clone(original);
        changed.layers[2].cd_y_nm = 90;
        const arrival = responseFor(page, (r) =>
          pathOf(r).endsWith("/reference-2d.json"),
        );
        release();
        await arrival;
        // Drain promise continuations and two animation frames rather than an arbitrary long sleep.
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await projectEquals(
          page,
          changed,
          "late-startup-preserved",
          null,
          null,
        );
        await expect(page.locator(".result-badge")).toHaveText("No result yet");
        await menuAction(page, "↶ Undo");
        await projectEquals(page, original, "late-startup-undo", null, null);
        await capture(page, report, output, "late-startup-empty");
      } finally {
        release();
      }
    },
    { width: 390, timeout: 25000 },
  );
}
async function realForward() {
  await group(
    "real-default-forward-snapshot",
    async (page, record) => {
      await ready(page, appUrl);
      await expect(page.locator(".connection")).toHaveText("Solver connected");
      await projectEquals(page, original, "local-before-run");
      assert.equal(
        report.api.filter(
          (r) => r.group === record.name && r.path === "/api/jobs",
        ).length,
        0,
        "Connection alone never runs the default",
      );
      assert.equal(
        report.api.filter(
          (r) => r.group === record.name && r.path === "/api/example",
        ).length,
        0,
        "Legacy API example never replaces the default",
      );
      const seen = [];
      const observations = [];
      page.on("response", (response) => {
        if (/\/api\/jobs(?:\/[^/]+)?$/.test(pathOf(response))) {
          observations.push(
            response
              .json()
              .then((job) => {
                seen.push(briefJob(job));
                if (["running", "queued"].includes(job.status))
                  liveJobs.add(job.id);
                else liveJobs.delete(job.id);
              })
              .catch(() => {}),
          );
        }
      });
      const validating = responseFor(page, (r) =>
        isResponse(r, "/validate", "POST"),
      );
      const creating = responseFor(page, (r) => isResponse(r, "/jobs", "POST"));
      await page.getByRole("button", { name: /Run simulation/ }).click();
      const validationResponse = await validating;
      assert.deepEqual(validationResponse.request().postDataJSON(), original);
      const validation = await validationResponse.json();
      assert.equal(validation.valid, true);
      assert.equal(validation.input_hash, expectedHash);
      assert.deepEqual(validation.project, original);
      const createResponse = await creating;
      assert.equal(createResponse.status(), 202);
      assert.deepEqual(createResponse.request().postDataJSON(), {
        kind: "forward",
        project: validation.project,
      });
      const initial = await createResponse.json();
      liveJobs.add(initial.id);
      assert.equal(
        initial.status,
        "running",
        "Genuine backend starts a running worker, not a simulated queue",
      );
      assert.equal(initial.input_hash, expectedHash);
      await expect(page.locator(".job-progress")).toContainText(
        "RCWA solver running",
      );
      await expect(page.locator(".reference-note")).toHaveText(
        "Showing the stored example while your calculation runs.",
      );
      await expect(
        page.getByLabel("Project name", { exact: true }),
      ).toBeDisabled();
      await expect(widthCard(page, 1)).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeEnabled();
      await capture(page, report, output, "local-real-running");
      await expect(page.locator(".result-badge")).toHaveText("Computed", {
        timeout: 150000,
      });
      await Promise.all(observations);
      const terminal = await http(`/jobs/${encodeURIComponent(initial.id)}`);
      liveJobs.delete(initial.id);
      report.jobs.push({
        evidence: "real-numerical",
        observations: seen,
        terminal: briefJob(terminal),
      });
      assert.equal(terminal.status, "succeeded");
      assert.equal(terminal.input_hash, validation.input_hash);
      assert.equal(terminal.result.metadata.input_hash, expectedHash);
      assert.ok(
        seen.some((j) => j.status === "running") &&
          seen.some((j) => j.status === "succeeded"),
      );
      assertFullResult(terminal.result, original);
      for (const polarization of ["s", "p"])
        for (const key of ["R", "T", "R_specular", "T_specular", "A_balance"])
          terminal.result.spectra[polarization][key].forEach((value, i) =>
            assert.ok(
              Math.abs(value - reference.result.spectra[polarization][key][i]) <
                1e-7,
              `${polarization}/${key}/${i} agrees with genuine approved default reference`,
            ),
          );
      await projectEquals(
        page,
        original,
        "computed-default-full-export",
        terminal.result,
        original,
      );
      await expect(
        page.getByLabel("Project name", { exact: true }),
      ).toBeEnabled();
      await capture(page, report, output, "local-real-computed");
      for (const polarization of ["s", "p"]) {
        await page
          .getByRole("button", {
            name: polarization === "s" ? "s / TE" : "p / TM",
            exact: true,
          })
          .click();
        for (const quantity of ["total", "specular", "all"]) {
          await page
            .getByLabel("Spectrum quantity", { exact: true })
            .selectOption(quantity);
          const slider = page.getByRole("slider", {
            name: "Inspect wavelength sample",
            exact: true,
          });
          await slider.focus();
          await page.keyboard.press("End");
          await expect(slider).toHaveAttribute(
            "aria-valuetext",
            "850 nanometers",
          );
          const description = page.locator("#spectrum-sample-description");
          await expect(description).toContainText(
            `850 nanometers. ${polarization} polarization.`,
          );
          for (const [key, label] of quantity === "total"
            ? [
                ["R", "Reflectance"],
                ["T", "Transmittance"],
              ]
            : quantity === "specular"
              ? [
                  ["R_specular", "R₀ specular"],
                  ["T_specular", "T₀ specular"],
                ]
              : [
                  ["R", "Reflectance"],
                  ["T", "Transmittance"],
                  ["R_specular", "R₀ specular"],
                  ["T_specular", "T₀ specular"],
                ])
            await expect(description).toContainText(
              `${label} ${(100 * terminal.result.spectra[polarization][key].at(-1)).toFixed(1)} percent`,
            );
        }
      }
      const projectMenu = page.locator(".project-menu");
      if (!(await projectMenu.evaluate((node) => node.open)))
        await projectMenu.locator("summary").click();
      await expect(
        page.getByRole("button", {
          name: "Save project to local server",
          exact: true,
        }),
      ).toBeVisible();
      await capture(
        page,
        report,
        output,
        "local-save-menu-before-genuine-save",
        { full: false },
      );
      const saving = responseFor(page, (r) =>
        isResponse(r, "/snapshots", "POST"),
      );
      await menuAction(page, "Save project to local server");
      const saveResponse = await saving;
      assert.deepEqual(saveResponse.request().postDataJSON(), {
        job_id: initial.id,
      });
      const saved = await saveResponse.json();
      liveSnapshots.push(saved);
      assert.equal(saved.provenance.source, "server_computed");
      assert.equal(saved.provenance.job_id, initial.id);
      assert.equal(saved.provenance.input_hash, expectedHash);
      assert.deepEqual(saved.project, original);
      assert.deepEqual(saved.result, terminal.result);
      await expect(page.locator(".result-badge")).toHaveText("Server-computed");
      await expect(page.locator(".result-badge")).toHaveAttribute(
        "title",
        /does not certify/,
      );
      await editY(page, 90);
      await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
      const changed = clone(original);
      changed.layers[2].cd_y_nm = 90;
      await projectEquals(
        page,
        changed,
        "server-snapshot-stale-export",
        terminal.result,
        original,
      );
      const listing = responseFor(page, (r) => isResponse(r, "/projects"));
      await menuAction(page, "Open");
      const { snapshots: list } = await (await listing).json();
      const index = list.findIndex((item) => item.id === saved.id);
      assert.ok(index >= 0);
      const loading = responseFor(page, (r) =>
        isResponse(r, `/projects/${saved.id}`),
      );
      await page.locator(".saved-item").nth(index).click();
      const loaded = await (await loading).json();
      assert.deepEqual(loaded, saved);
      await expect(
        page.getByRole("dialog", { name: "Saved projects" }),
      ).not.toBeVisible();
      await expect(page.locator(".result-badge")).toHaveText("Server-computed");
      await projectEquals(
        page,
        original,
        "server-snapshot-reloaded",
        terminal.result,
        original,
      );
      const forged = {
        ...saved,
        resultOrigin: "server",
        source: "server_computed",
      };
      await importText(page, forged, "saved-snapshot-file");
      await expect(page.locator(".result-badge")).toHaveText(
        "Unverified import",
      );
      await projectEquals(
        page,
        original,
        "snapshot-file-unverified",
        terminal.result,
        original,
      );
      assert.deepEqual(await http(`/projects/${saved.id}`), saved);
      await capture(page, report, output, "server-snapshot-file-unverified");
      record.checks.push(
        "One actual full 21-wave Hx=Hy=5 forward; validate/request/job/result exact hash; real running/terminal lock; all (m,n)/outgoing channels preserved; wavelength AX readouts; job-ID save/load exact server provenance; file import always unverified",
      );
    },
    { timeout: 200000 },
  );
  await group(
    "real-edited-cancellation",
    async (page) => {
      await ready(page, appUrl);
      await expect(page.locator(".connection")).toHaveText("Solver connected");
      const edited = clone(original);
      edited.layers[2].cd_y_nm = 90;
      edited.name = `2D single-wavelength browser QA ${started}`;
      edited.illumination.wavelengths_nm = [650];
      await importText(page, edited, "single-wave-cancel-input");
      await applyImportedDesign(page);
      await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
      // Delay only this real DELETE until the real worker completes. This is
      // completed-before-cancel transport timing, not proof of a cancelled worker.
      await page.route("**/api/jobs/*", async (route) => {
        if (route.request().method() !== "DELETE") {
          await route.continue();
          return;
        }
        const path = new URL(route.request().url()).pathname.slice(4);
        const deadline = Date.now() + 20000;
        let status;
        do {
          status = await http(path);
          if (status.status !== "running") break;
          assert.ok(
            Date.now() < deadline,
            "Single-wave completion exceeded cancellation timing budget",
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
        } while (true);
        const response = await route.fetch();
        await route.fulfill({ response });
      });
      const validating = responseFor(page, (r) =>
        isResponse(r, "/validate", "POST"),
      );
      const creating = responseFor(page, (r) => isResponse(r, "/jobs", "POST"));
      await page.locator(".run-button").click();
      const validated = await (await validating).json();
      assert.equal(validated.valid, true);
      assert.notEqual(validated.input_hash, expectedHash);
      assert.deepEqual(validated.project, edited);
      const job = await (await creating).json();
      liveJobs.add(job.id);
      assert.equal(job.input_hash, validated.input_hash);
      const cancelling = responseFor(page, (r) =>
        isResponse(r, `/jobs/${job.id}`, "DELETE"),
      );
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      const terminal = await (await cancelling).json();
      assert.ok(
        ["cancelled", "succeeded"].includes(terminal.status),
        `Honest cancel/completed-before-cancel outcome: ${JSON.stringify(briefJob(terminal))}`,
      );
      assert.equal(terminal.input_hash, validated.input_hash);
      liveJobs.delete(job.id);
      report.jobs.push({
        evidence: "real-completed-before-cancel-with-delayed-DELETE-transport",
        terminal: briefJob(terminal),
      });
      assert.equal(
        terminal.status,
        "succeeded",
        "The second genuine run must succeed to provide an exact comparison candidate",
      );
      await expect(page.locator(".job-progress")).toHaveCount(0);
      await expect(
        page.getByLabel("Project name", { exact: true }),
      ).toBeEnabled();
      if (terminal.status === "succeeded") {
        assertFullResult(terminal.result, edited);
        await expect(page.locator(".result-badge")).toHaveText("Computed");
        await projectEquals(
          page,
          edited,
          "cancel-completed-first",
          terminal.result,
          edited,
        );
      } else {
        await expect(page.locator(".message.success")).toContainText(
          "cancelled",
        );
        await projectEquals(
          page,
          edited,
          "cancelled-inputs-unlocked",
          reference.result,
          original,
        );
      }
      await capture(
        page,
        report,
        output,
        "real-completed-before-cancel-terminal",
      );
      const saving = responseFor(page, (r) =>
        isResponse(r, "/snapshots", "POST"),
      );
      await menuAction(page, "Save project to local server");
      const savedResponse = await saving;
      assert.deepEqual(savedResponse.request().postDataJSON(), {
        job_id: job.id,
      });
      const saved = await savedResponse.json();
      liveSnapshots.push(saved);
      assert.equal(saved.provenance.input_hash, validated.input_hash);
      assert.deepEqual(saved.project, edited);
      assert.deepEqual(saved.result, terminal.result);
      await expect(page.locator(".result-badge")).toHaveText("Server-computed");
      // These actual API rejections never start another solver worker.
      for (const [path, body] of [
        [
          "/jobs",
          {
            kind: "fit",
            project: original,
            fit: { target_cd_nm: 80, lower_cd_nm: 40, upper_cd_nm: 120 },
          },
        ],
        [
          "/change-preview",
          { base_project: original, changes: { period_nm: 160 } },
        ],
        [
          "/stack-change-preview",
          { base_project: original, changes: { period_nm: 160 } },
        ],
      ]) {
        const error = await http(path, body, "POST", 422);
        assert.match(JSON.stringify(error), /1\.2|1\.0|1\.1|support|preview/i);
      }
    },
    { timeout: 25000 },
  );
}
async function transportCases() {
  for (const mode of [
    "unsupported-capabilities",
    "validation-hash",
    "queued-contract",
    "job-hash",
    "failed-terminal",
    "malformed-poll",
    "integer-poll",
    "network-recovery",
    "cancel-late-poll",
  ]) {
    await group(
      `transport-${mode}`,
      async (page, record) => {
        record.evidence =
          "Deterministic transport-contract injection; no solver worker or numerical proof";
        let jobs = 0,
          polls = 0,
          release;
        let pollStarted = false;
        const pending = new Promise((resolve) => {
          release = resolve;
        });
        const job = {
          id: `transport-${mode}`,
          kind: "forward",
          status: "running",
          input_hash: expectedHash,
          result: null,
          error: null,
          error_code: null,
          created_at: new Date(started).toISOString(),
          completed_at: null,
        };
        const cap = clone(capability);
        if (mode === "unsupported-capabilities") {
          cap.supported_project_schema_versions = ["1.0", "1.1"];
          cap.supported_result_schema_versions = ["1.0", "1.1"];
          delete cap.project_profiles["1.2"];
        }
        await page.route("**/api/capabilities", (route) =>
          route.fulfill({ json: cap }),
        );
        await page.route("**/api/validate", (route) =>
          route.fulfill({
            json: {
              valid: true,
              project: original,
              input_hash:
                mode === "validation-hash" ? "0".repeat(64) : expectedHash,
              diagnostics: [],
            },
          }),
        );
        await page.route("**/api/jobs", async (route) => {
          jobs++;
          await route.fulfill({
            status: 202,
            json: {
              ...job,
              status: mode === "queued-contract" ? "queued" : "running",
              input_hash: mode === "job-hash" ? "0".repeat(64) : expectedHash,
            },
          });
        });
        await page.route("**/api/jobs/*", async (route) => {
          if (route.request().method() === "DELETE") {
            await route.fulfill({
              json: {
                ...job,
                status: "cancelled",
                completed_at: new Date().toISOString(),
              },
            });
            return;
          }
          polls++;
          if (mode === "cancel-late-poll") {
            pollStarted = true;
            await pending;
            await route
              .fulfill({
                json: {
                  ...job,
                  status: "succeeded",
                  result: reference.result,
                  completed_at: new Date().toISOString(),
                },
              })
              .catch(() => {});
            return;
          }
          if (mode === "malformed-poll") {
            await route.fulfill({
              contentType: "application/json",
              body: '{"invalid":',
            });
            return;
          }
          if (mode === "integer-poll") {
            const raw = JSON.stringify({
              ...job,
              status: "succeeded",
              result: reference.result,
            }).replace('"harmonics_x":5', '"harmonics_x":5.0');
            await route.fulfill({ contentType: "application/json", body: raw });
            return;
          }
          if (mode === "network-recovery" && polls === 1) {
            await route.abort("connectionreset");
            return;
          }
          await route.fulfill({
            json: {
              ...job,
              status: "failed",
              error: "Intentional transport-test terminal failure",
              error_code: "test_failure",
              completed_at: new Date().toISOString(),
            },
          });
        });
        try {
          await ready(page, appUrl);
          if (mode === "unsupported-capabilities") {
            await expect(page.locator(".connection")).toHaveText(
              "Solver unsupported",
            );
            await expect(page.locator(".connection-banner")).toContainText(
              "does not support schema 1.2",
            );
            await expect(page.locator(".run-button")).toBeDisabled();
            assert.equal(jobs, 0);
          } else {
            await expect(page.locator(".connection")).toHaveText(
              "Solver connected",
            );
            await page.locator(".run-button").click();
            if (mode === "cancel-late-poll") {
              await expect.poll(() => pollStarted).toBe(true);
              await page
                .getByRole("button", { name: "Cancel", exact: true })
                .click();
              await expect(page.locator(".message.success")).toContainText(
                "cancelled",
              );
              await editY(page, 90);
              const lateResponse = responseFor(page, (r) =>
                isResponse(r, `/jobs/${job.id}`),
              );
              release();
              await lateResponse;
              await page.evaluate(
                () =>
                  new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  ),
              );
              const changed = clone(original);
              changed.layers[2].cd_y_nm = 90;
              await projectEquals(
                page,
                changed,
                "late-terminal-cancelled-preserved",
              );
              await expect(page.locator(".result-badge")).toHaveText(
                "Inputs changed",
              );
              await expect(page.locator(".job-progress")).toHaveCount(0);
            } else {
              if (mode === "network-recovery")
                await expect(page.locator(".message.error")).toContainText(
                  "Retrying job status",
                );
              await expect(page.locator(".message.error")).toContainText(
                mode === "validation-hash"
                  ? /validation hash/
                  : ["queued-contract", "job-hash"].includes(mode)
                    ? /invalid forward job|different/
                    : ["malformed-poll", "integer-poll"].includes(mode)
                      ? /JSON|integer|token|harmonics|invalid/i
                      : /Intentional transport-test terminal failure/,
                { timeout: 10000 },
              );
              await expect(page.locator(".job-progress")).toHaveCount(0);
              await expect(
                page.getByLabel("Project name", { exact: true }),
              ).toBeEnabled();
              await expect(page.locator(".result-badge")).toHaveText(
                "Precomputed example",
              );
              await projectEquals(
                page,
                original,
                `transport-${mode}-preserved`,
              );
              if (mode === "validation-hash")
                assert.equal(
                  jobs,
                  0,
                  "Wrong preflight hash stops before job creation",
                );
              if (["malformed-poll", "integer-poll"].includes(mode)) {
                const completedPolls = polls;
                await page.waitForTimeout(900);
                assert.equal(
                  polls,
                  completedPolls,
                  "Malformed success response is terminal rather than repeatedly polled",
                );
                await expect(page.locator(".connection")).toHaveText(
                  "Solver connected",
                );
              }
              if (mode === "network-recovery")
                assert.equal(
                  polls,
                  2,
                  "One aborted poll is retried, then terminal failure unlocks",
                );
            }
          }
          await capture(page, report, output, `transport-${mode}`, {
            full: false,
          });
          record.checks.push(
            `Injected ${mode}; preserved input/result/origin, bounded terminal handling`,
          );
        } finally {
          release();
        }
      },
      { timeout: 25000 },
    );
  }
}
async function regressions() {
  await group(
    "startup-selection-editor-race",
    async (page) => {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route("**/reference-2d.json", async (route) => {
        await gate;
        await route
          .fulfill({ contentType: "application/json", body: referenceBytes })
          .catch(() => {});
      });
      try {
        await ready(page, previewUrl, false);
        await page.getByRole("button", { name: /^Select layer 3:/ }).click();
        await widthCard(page).click();
        const arrival = responseFor(page, (r) =>
          pathOf(r).endsWith("/reference-2d.json"),
        );
        release();
        await arrival;
        await expect(page.locator(".result-badge")).toHaveText(
          "Precomputed example",
        );
        await expect(
          page.getByRole("dialog", { name: /^Layer 3 · Width/ }),
        ).toBeVisible();
        await expect(
          page.getByRole("spinbutton", { name: "Width Y nm", exact: true }),
        ).toHaveValue("80");
        await expect(page.locator(".s2-selection")).toHaveText(
          "Selected: Layer 3",
        );
        await page
          .getByRole("spinbutton", { name: "Width Y nm", exact: true })
          .fill("90");
        await closeSheet(page);
        const changed = clone(original);
        changed.layers[2].cd_y_nm = 90;
        await projectEquals(page, changed, "startup-selection-edited");
        await menuAction(page, "↶ Undo");
        await projectEquals(page, original, "startup-selection-undo");
        await expect(page.locator(".result-badge")).toHaveText(
          "Precomputed example",
        );
        await expect(page.locator(".s2-selection")).toHaveText(
          "Selected: Layer 3",
        );
      } finally {
        release();
      }
    },
    { width: 390, timeout: 25000 },
  );
  await group(
    "invalid-name-valid-dimension",
    async (page) => {
      await ready(page, appUrl);
      await expect(page.locator(".connection")).toHaveText("Solver connected");
      const name = page.getByLabel("Project name", { exact: true });
      await name.fill("");
      await widthCard(page, 1).click();
      await page
        .getByRole("spinbutton", { name: "Width X nm", exact: true })
        .fill("80");
      await closeSheet(page);
      await expect(widthCard(page, 1)).toHaveAccessibleName(
        "Edit Layer 1 width: X 80 nanometers, Y 60 nanometers",
      );
      await expect(page.locator(".run-button")).toBeDisabled();
      await name.fill(original.name);
      await name.blur();
      await expect(page.locator(".run-button")).toBeEnabled();
      const changed = clone(original);
      changed.layers[0].cd_x_nm = 80;
      await projectEquals(page, changed, "invalid-name-dimension-retained");
      await capture(page, report, output, "valid-dimension-after-name-repair");
    },
    { timeout: 25000 },
  );
  for (const newest of ["success", "failure"]) {
    await group(
      `reconnect-newest-${newest}`,
      async (page) => {
        let count = 0,
          release,
          reconnecting = false;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        await page.route("**/api/capabilities", async (route) => {
          if (!reconnecting) {
            // Dev StrictMode can perform two startup reads; both are offline.
            await route.fulfill({
              status: 503,
              json: { detail: "Initial offline fixture" },
            });
            return;
          }
          count++;
          const older = count === 1;
          if (older) await gate;
          const success = older ? newest === "failure" : newest === "success";
          await route
            .fulfill(
              success
                ? { json: capability }
                : {
                    status: 503,
                    json: {
                      detail: older
                        ? "Obsolete reconnect failure"
                        : "Latest reconnect failure",
                    },
                  },
            )
            .catch(() => {});
        });
        try {
          await ready(page, appUrl);
          await expect(page.locator(".connection")).toHaveText(
            "Solver offline",
          );
          reconnecting = true;
          await page
            .getByRole("button", { name: "Reconnect", exact: true })
            .click();
          await expect.poll(() => count).toBe(1);
          await page
            .getByRole("button", { name: "Reconnect", exact: true })
            .click();
          await expect.poll(() => count).toBe(2);
          await expect(page.locator(".connection")).toHaveText(
            newest === "success" ? "Solver connected" : "Solver offline",
          );
          const response = responseFor(page, (r) =>
            isResponse(r, "/capabilities"),
          );
          release();
          await response;
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          await expect(page.locator(".connection")).toHaveText(
            newest === "success" ? "Solver connected" : "Solver offline",
          );
          if (newest === "failure")
            await expect(page.locator(".message.error")).toContainText(
              "Latest reconnect failure",
            );
          else await expect(page.locator(".message.error")).toHaveCount(0);
          await projectEquals(
            page,
            original,
            `reconnect-newest-${newest}-preserved`,
          );
        } finally {
          release();
        }
      },
      { timeout: 15000 },
    );
  }
}
async function comparisonRegression() {
  await group(
    "genuine-comparison-review-ownership",
    async (page, record) => {
      assert.equal(
        liveSnapshots.length,
        2,
        "Both genuine exact-result snapshots are required; this group cannot silently skip",
      );
      await ready(page, appUrl);
      const baseline = stable(
        (await exported(page, "comparison-baseline")).data,
      );
      const comparison = page.getByRole("dialog", {
        name: "Compare candidates",
        exact: true,
      });
      async function openComparison() {
        const listing = responseFor(page, (r) => isResponse(r, "/projects"));
        await menuAction(page, "Open");
        const { snapshots: list } = await (await listing).json();
        for (const snapshot of liveSnapshots) {
          const index = list.findIndex((item) => item.id === snapshot.id);
          assert.ok(index >= 0);
          await page
            .locator(".saved-choice input[type=checkbox]")
            .nth(index)
            .check();
        }
        await page
          .getByRole("button", { name: "Compare (2)", exact: true })
          .click();
        await expect(comparison).toBeVisible();
      }
      await openComparison();
      await expect(comparison).toContainText("Wavelength grids differ.");
      await expect(comparison).toContainText("no interpolation is applied");
      await expect(comparison.locator(".comparison-plot svg")).toHaveCount(0);
      await expect(comparison.locator(".candidate-origin")).toHaveText([
        "Server-computed",
        "Server-computed",
      ]);
      await page.evaluate(() => {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        window.__qaDigestCalls = 0;
        crypto.subtle.digest = (...args) => {
          window.__qaDigestCalls++;
          return digest(...args);
        };
      });
      for (const dismissal of ["Cancel", "Escape"]) {
        // Both handlers begin in the same browser task, before either awaited
        // workspace resolves. This is a deterministic async ownership race,
        // explicitly distinct from the normal pointer/touch walkthrough above.
        await comparison.evaluate((dialog) => {
          const buttons = [...dialog.querySelectorAll("button")].filter(
            (button) => /^Review candidate /.test(button.textContent),
          );
          buttons[0].click();
          buttons[1].click();
        });
        const review = page.getByRole("dialog", {
          name: "Review saved candidate",
          exact: true,
        });
        await expect(review).toBeVisible();
        assert.deepEqual(
          JSON.parse(await review.locator("pre").nth(1).textContent()),
          liveSnapshots[1].project,
          "Newest candidate owns the pending review",
        );
        if (dismissal === "Escape") await page.keyboard.press("Escape");
        else
          await review
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
        await expect(review).not.toBeVisible();
        await expect(comparison).toBeVisible();
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await expect(review).not.toBeVisible();
      }
      assert.equal(
        await page.evaluate(() => window.__qaDigestCalls),
        0,
        "Already-bound saved result identities avoid repeated hashing during candidate review",
      );
      await comparison.evaluate((dialog) => {
        [...dialog.querySelectorAll("button")]
          .find((button) => /^Review candidate 1/.test(button.textContent))
          .click();
        dialog.querySelector('[aria-label="Close compare candidates"]').click();
      });
      await expect(comparison).not.toBeVisible();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await expect(
        page.getByRole("dialog", {
          name: "Review saved candidate",
          exact: true,
        }),
      ).not.toBeVisible();
      assert.deepEqual(
        stable((await exported(page, "comparison-cancel-preserved")).data),
        baseline,
      );
      record.checks.push(
        "Two genuine different-grid results remain non-overlaid; newest async review wins; Cancel/Escape/Comparison Close never reopen old review; bound identities avoid repeat hashing",
      );
      // All ownership races run before screenshot collection. Reopen the same
      // exact genuine snapshot pair for its required mismatch evidence image.
      await openComparison();
      await expect(comparison).toContainText("Wavelength grids differ.");
      await expect(comparison.locator(".comparison-plot svg")).toHaveCount(0);
      await capture(page, report, output, "genuine-comparison-grid-mismatch");
    },
    { timeout: 50000 },
  );
}
let watchdog;
try {
  assert.equal(
    createHash("sha256").update(originalBytes).digest("hex"),
    "8dbe8260fa61ba3ec8f82ffefc5a5749ea75587b035d9f381edf66b695755294",
  );
  assert.equal(
    createHash("sha256").update(referenceBytes).digest("hex"),
    manifest.bundle_sha256,
  );
  assert.deepEqual(reference.project, original);
  assert.equal(reference.result.metadata.input_hash, expectedHash);
  assert.equal(manifest.input_hash, expectedHash);
  assertFullResult(reference.result, original);
  capability = await http("/capabilities");
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
  watchdog = setTimeout(() => {
    report.issues.push({
      group: "suite-budget",
      error:
        "Required browser work exceeded the 280-second execution budget; closing browser and reporting unresolved groups.",
    });
    void browser.close().catch(() => {});
  }, 280000);
  // Capture stalls overlapped across two SwiftShader contexts in the first
  // combined CI run. Isolate rendering with one live page group at a time;
  // retain both genuine solves and every required semantic/screenshot gate.
  await realForward();
  await comparisonRegression();
  for (const width of [360, 390, 1440]) await staticTasks(width);
  for (const width of [360, 390]) await touchAndLayers(width);
  await fallback("context-loss", 390);
  await fallback("unavailable", 360);
  await importsAndEdges();
  await startupRace();
  await regressions();
  await transportCases();
} catch (error) {
  report.issues.push({
    group: "initialization-or-orchestration",
    error: String(error),
  });
} finally {
  clearTimeout(watchdog);
  for (const id of liveJobs) {
    try {
      const job = await http(
        `/jobs/${encodeURIComponent(id)}`,
        undefined,
        "DELETE",
      );
      report.jobs.push({
        evidence: "bounded-cleanup",
        terminal: briefJob(job),
      });
    } catch (error) {
      report.issues.push({ group: "cleanup", job: id, error: String(error) });
    }
  }
  await browser?.close().catch(() => {});
  // Final acceptance requires every requested capture to have a verified file,
  // including captures that succeeded only after an explicitly logged retry.
  for (const item of report.captures) {
    try {
      assert.ok(item.attempts.some((attempt) => attempt.status === "passed"));
      item.finalFile = await verifyCaptureFile(
        `${output}/${item.filename}`,
        item.minimum,
      );
    } catch (error) {
      report.issues.push({
        group: "final-capture-verification",
        filename: item.filename,
        error: String(error),
      });
    }
  }
  report.requiredGroups = required;
  report.elapsedMs = Date.now() - started;
  report.status =
    report.issues.length ||
    report.pageErrors.length ||
    !report.groups.length ||
    report.groups.some((g) => g.status !== "passed")
      ? "failed"
      : "passed";
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    `${output}/true-2d-browser-qa.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        status: report.status,
        elapsedMs: report.elapsedMs,
        checks: report.checks,
        issues: report.issues,
        pageErrors: report.pageErrors,
        report: "artifacts/true-2d-browser-qa.json",
      },
      null,
      2,
    ),
  );
  if (report.status !== "passed") process.exitCode = 1;
}
