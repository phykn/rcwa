// Production schema-1.2 SVG fallback acceptance, with the genuine stored results.
// Run against an isolated VITE_STATIC_PREVIEW=true build. No API or solver mocks.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium, expect as baseExpect } from "@playwright/test";
import {
  canvas2D,
  capture,
  activeCapture,
  verifyCaptureFile,
  closeSheet,
  menuAction,
  exportWorkspace,
  importText,
  pitchCard,
  assertFullResult,
  assertScene,
  replayTouch,
} from "./browser-2d-controls.mjs";

const expect = baseExpect.configure({ timeout: 5000 });
const previewUrl = process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const fixtures = {};
for (const kind of ["circular", "rectangle"]) {
  const suffix = kind === "circular" ? "circular" : "2d";
  const bytes = await fs.readFile(
    new URL(`../public/reference-${suffix}.json`, import.meta.url),
  );
  const manifest = JSON.parse(
    await fs.readFile(
      new URL(
        `../src/fixtures/reference-${suffix}-manifest.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const data = JSON.parse(bytes);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    manifest.bundle_sha256,
  );
  assert.equal(data.result.metadata.input_hash, manifest.input_hash);
  assertFullResult(data.result, data.project);
  fixtures[kind] = data;
}
const started = Date.now();
const report = {
  status: "running",
  browserLaunched: false,
  startedAt: new Date().toISOString(),
  source:
    "Production static preview; genuine circular and rectangular fixture bundles",
  limitations: [
    "Chromium touch emulation is not a real-phone or spoken screen-reader test.",
    "SVG assertions verify actual rendered physical dimensions; no new numerical solve is claimed.",
  ],
  groups: [],
  checks: [],
  captures: [],
  screenshots: [],
  pageErrors: [],
  issues: [],
  api: [],
  geometry: [],
  artifacts: [],
};
const urlFor = (kind) => {
  const url = new URL(previewUrl);
  if (kind === "rectangle") url.searchParams.set("example", "rectangle");
  else url.searchParams.delete("example");
  return url.href;
};
const chip = (page, layer) =>
  page.getByRole("button", { name: new RegExp(`^Select layer ${layer + 1}:`) });
const dimension = (page, kind, layer) =>
  page.getByRole("button", {
    name: new RegExp(
      `^Edit Layer ${layer + 1} ${kind === "circular" ? "diameter" : "width"}:`,
    ),
  });
const xy = (page) => page.locator('.s2-fallback svg[data-projection="xy"]');
const xz = (page) => page.locator('.s2-fallback svg[data-projection="xz"]');
const total = (project) =>
  project.layers.reduce((sum, layer) => sum + layer.thickness_nm, 0);
const near = (actual, expected, message, tolerance = 1e-6) =>
  assert.ok(
    Number.isFinite(actual) &&
      Math.abs(actual - expected) <=
        tolerance * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} vs ${expected}`,
  );
let browser, watchdog;
async function group(name, width, run) {
  const record = { name, width, status: "running", checks: [] };
  report.groups.push(record);
  const context = await browser.newContext({
    viewport: {
      width,
      height: width === 360 ? 800 : width === 390 ? 844 : 1000,
    },
    isMobile: width < 700,
    hasTouch: width < 700,
    acceptDownloads: true,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(15000);
  page.on("pageerror", (error) =>
    report.pageErrors.push({ group: name, error: error.message }),
  );
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      report.api.push({
        group: name,
        method: request.method(),
        url: request.url(),
      });
  });
  const groupStart = Date.now();
  const timer = setTimeout(() => {
    record.timeout = true;
    const pending = activeCapture(page);
    if (pending) void pending.then(() => context.close().catch(() => {}));
    else void context.close().catch(() => {});
  }, 75000);
  try {
    await run(page, record);
    assert.equal(
      record.timeout,
      undefined,
      "Required group completed within its bounded budget",
    );
    assert.deepEqual(
      report.api.filter((entry) => entry.group === name),
      [],
      "Static fallback never calls an API",
    );
    record.status = "passed";
    report.checks.push(name);
  } catch (error) {
    record.status = "failed";
    record.error = String(error);
    report.issues.push({ group: name, error: String(error) });
    if (!page.isClosed() && !record.timeout)
      await shot(page, `${name}-failure`).catch((failure) => {
        record.failureCaptureError = String(failure);
      });
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
    record.elapsedMs = Date.now() - groupStart;
    await fs.writeFile(
      `${output}/svg-fallback-browser-qa.json`,
      JSON.stringify(report, null, 2),
    );
  }
}
async function shot(page, name) {
  await capture(page, report, output, name, { prefix: "svg-fallback" });
}
async function exactExport(
  page,
  fixture,
  project,
  name,
  result = fixture.result,
  resultProject = fixture.project,
) {
  const value = await exportWorkspace(page, output, `svg-fallback-${name}`);
  report.artifacts.push(value.path.split("/").at(-1));
  assert.deepEqual(
    value.data.project,
    project,
    "Every exported input remains exact",
  );
  assert.deepEqual(
    value.data.result,
    result,
    "Full result, outgoing channels, metadata and hash are unchanged",
  );
  assert.deepEqual(
    value.data.result_project,
    resultProject,
    "Spectrum stays bound to its original input",
  );
  if (result)
    assert.equal(
      value.data.result.metadata.input_hash,
      fixture.result.metadata.input_hash,
    );
  const menu = page.locator(".project-menu");
  if (await menu.evaluate((node) => node.open))
    await menu.locator("summary").click();
  return value.data;
}
async function blockStartupWebGL(page) {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (/^(webgl2?|experimental-webgl)$/.test(type)) return null;
      return getContext.call(this, type, ...args);
    };
  });
}
async function ready(page, kind, fallback = true) {
  await page.goto(urlFor(kind));
  await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
  await expect(page.locator(".connection")).toHaveText("Static preview");
  if (fallback) await fallbackVisible(page);
  else await expect(canvas2D(page)).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => document.fonts.ready);
}
async function fallbackVisible(page) {
  await expect(page.locator(".s2-webgl")).toHaveAttribute(
    "data-fallback",
    "true",
  );
  await expect(page.locator(".s2-fallback-notice")).toHaveAttribute(
    "role",
    "status",
  );
  await expect(page.locator(".s2-fallback-notice")).toContainText(
    "2D view · 3D unavailable.",
  );
  // Direct locators also verify transitions behind an open modal, whose
  // background is intentionally omitted from the accessibility tree.
  await expect(xy(page)).toBeVisible();
  await expect(xy(page)).toHaveAttribute("role", "img");
  await expect(xy(page)).toHaveAttribute(
    "aria-label",
    "Selected layer top view, X–Y",
  );
  await expect(xz(page)).toBeVisible();
  await expect(xz(page)).toHaveAttribute("role", "img");
  await expect(xz(page)).toHaveAttribute(
    "aria-label",
    "Stack center section, X–Z at Y=0",
  );
  await expect(
    page.getByRole("combobox", { name: "Structure view", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reset view", exact: true }),
  ).toHaveCount(0);
  const canvas = canvas2D(page);
  if (await canvas.count()) {
    await expect(canvas).toHaveAttribute("tabindex", "-1");
    await expect(canvas).toHaveAttribute("aria-hidden", "true");
  }
}
async function assertProjection(page, project, selected, name) {
  await expect(page.locator(".s2-selection")).toHaveText(
    `Selected: Layer ${selected + 1}`,
  );
  const state = await page.locator(".s2-fallback").evaluate((node) => {
    const project = (svg) => {
      const shapes = [...svg.querySelectorAll("[data-role]")].map((shape) => {
        const box = shape.getBBox();
        const rendered = shape.getBoundingClientRect();
        const matrix = shape.getScreenCTM();
        return {
          tag: shape.tagName.toLowerCase(),
          ...shape.dataset,
          layerIndex: Number(
            shape.closest("[data-layer-index]")?.dataset.layerIndex,
          ),
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          rendered: { width: rendered.width, height: rendered.height },
          screenCTM: {
            a: matrix.a,
            b: matrix.b,
            c: matrix.c,
            d: matrix.d,
            e: matrix.e,
            f: matrix.f,
          },
          renderedScale: {
            x: Math.hypot(matrix.a, matrix.b),
            y: Math.hypot(matrix.c, matrix.d),
          },
          radius:
            shape.tagName.toLowerCase() === "circle"
              ? Number(shape.getAttribute("r"))
              : null,
        };
      });
      return { ...svg.dataset, shapes };
    };
    return {
      xy: project(node.querySelector('svg[data-projection="xy"]')),
      xz: project(node.querySelector('svg[data-projection="xz"]')),
    };
  });
  for (const projection of [state.xy, state.xz]) {
    assert.equal(Number(projection.selectedLayer), selected);
    near(
      Number(projection.periodX),
      project.period_nm,
      "Displayed X pitch metadata",
    );
    near(
      Number(projection.periodY),
      project.period_y_nm,
      "Displayed Y pitch metadata",
    );
    near(
      Number(projection.totalThickness),
      total(project),
      "Displayed total thickness metadata",
    );
    for (const shape of projection.shapes) {
      // Screen transforms remain exact even when true slabs are subpixel-thin.
      near(
        shape.renderedScale.x,
        shape.renderedScale.y,
        "Both physical axes share the actual screen scale",
        1e-6,
      );
      assert.ok(
        shape.renderedScale.x > 0 &&
          shape.box.width > 0 &&
          shape.box.height > 0,
        "Physical regions retain positive dimensions and scale",
      );
      if (shape.rendered.width >= 1 && shape.rendered.height >= 1)
        near(
          shape.rendered.width / shape.box.width,
          shape.rendered.height / shape.box.height,
          "Measurable screen bounds agree with the common scale",
          1e-4,
        );
    }
  }
  const layer = project.layers[selected];
  const patternWidth = (entry) =>
    entry.geometry === "homogeneous"
      ? project.period_nm
      : entry.geometry === "circular_hole_2d"
        ? entry.diameter_nm
        : entry.geometry === "rectangle_2d"
          ? entry.cd_x_nm
          : entry.cd_nm;
  const topMaterial = state.xy.shapes.filter(
    (shape) => shape.role === "material",
  );
  const hasTopPattern =
    layer.thickness_nm > 0 &&
    patternWidth(layer) > 0 &&
    (layer.geometry !== "rectangle_2d" || layer.cd_y_nm > 0);
  assert.equal(
    topMaterial.length,
    hasTopPattern ? 1 : 0,
    "Selected layer top view uses one physical repeat cell",
  );
  if (hasTopPattern) {
    const shape = topMaterial[0];
    near(shape.box.width, patternWidth(layer), "Top pattern physical width");
    near(
      shape.box.height,
      layer.geometry === "circular_hole_2d"
        ? layer.diameter_nm
        : layer.geometry === "rectangle_2d"
          ? layer.cd_y_nm
          : project.period_y_nm,
      "Top pattern physical height",
    );
    if (layer.geometry === "circular_hole_2d") {
      assert.equal(
        shape.tag,
        "circle",
        "Round holes use an actual circle, never a rectangular placeholder",
      );
      near(shape.radius, layer.diameter_nm / 2, "Analytic circle radius");
      if (shape.rendered.width >= 1 && shape.rendered.height >= 1)
        near(
          shape.rendered.width,
          shape.rendered.height,
          "Rendered hole stays circular under common scale",
          1e-4,
        );
    }
  }
  for (const [index, entry] of project.layers.entries()) {
    const shapes = state.xz.shapes.filter(
      (shape) => shape.layerIndex === index,
    );
    if (entry.thickness_nm === 0) {
      assert.equal(
        shapes.length,
        0,
        "Zero-thickness layer has no false region area",
      );
      continue;
    }
    assert.ok(
      shapes.length > 0,
      `Layer ${index + 1} remains represented in the center section`,
    );
    for (const shape of shapes) {
      near(
        shape.box.height,
        entry.thickness_nm,
        `Layer ${index + 1} exact section thickness`,
      );
      assert.ok(
        shape.box.width > 0,
        "Rendered section region has positive width",
      );
    }
    const material = shapes.filter((shape) => shape.role === "material");
    const hasMaterial =
      patternWidth(entry) > 0 &&
      (entry.geometry !== "rectangle_2d" || entry.cd_y_nm > 0);
    assert.equal(
      material.length,
      hasMaterial ? 1 : 0,
      "Center section intersects the real pattern",
    );
    if (hasMaterial)
      near(
        material[0].box.width,
        patternWidth(entry),
        "Center section pattern width",
      );
  }
  report.geometry.push({
    name,
    selected,
    periodX: project.period_nm,
    periodY: project.period_y_nm,
    total: total(project),
    ...state,
  });
}
async function checkLayoutAndGuide(page, width) {
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
  const bounds = await page.locator(".s2-fallback").evaluate((node) => {
    const result = [];
    for (const svg of node.querySelectorAll("svg")) {
      const bounds = svg.getBoundingClientRect();
      const description = document.getElementById(
        svg.getAttribute("aria-describedby"),
      );
      result.push({
        description: description?.textContent,
        labels: [...svg.querySelectorAll("text")].map((text) => {
          const box = text.getBoundingClientRect();
          return {
            text: text.textContent,
            visibleWithinSvg:
              box.left >= bounds.left - 1 &&
              box.right <= bounds.right + 1 &&
              box.top >= bounds.top - 1 &&
              box.bottom <= bounds.bottom + 1,
          };
        }),
      });
    }
    return result;
  });
  for (const projection of bounds) {
    assert.ok(
      projection.description?.includes("physical scale"),
      "Accessible projection description explains scale",
    );
    assert.ok(
      projection.labels.every((label) => label.visibleWithinSvg),
      `Axis and boundary labels stay inside projection: ${JSON.stringify(projection.labels)}`,
    );
  }
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
    "No page horizontal overflow",
  );
  for (const projection of [xy(page), xz(page)]) {
    const box = await projection.boundingBox();
    assert.ok(
      box &&
        box.width > 0 &&
        box.height > 0 &&
        box.x >= 0 &&
        box.x + box.width <= width + 1,
      "Complete projection fits mobile width",
    );
    const describedBy = await projection.getAttribute("aria-describedby");
    const labelledBy = await projection.getAttribute("aria-labelledby");
    assert.ok(
      describedBy || labelledBy || (await projection.locator("desc").count()),
      "Projection supplies a readable description",
    );
  }
  const guide = page.getByLabel("View guide", { exact: true });
  await guide.focus();
  await page.keyboard.press("Enter");
  const details = page.getByRole("region", {
    name: "View guide details",
    exact: true,
  });
  await expect(details).toBeVisible();
  await expect(details).toContainText(/center|section/i);
  await expect(details).not.toContainText(
    /Drag to rotate|pinch to zoom|A corner is hidden/i,
  );
  await page.keyboard.press("Escape");
  await expect(details).not.toBeVisible();
  await expect(guide).toBeFocused();
}
async function editPattern(page, kind, selected, first, second) {
  await chip(page, selected).click();
  await dimension(page, kind, selected).click();
  if (kind === "circular")
    await page
      .getByRole("spinbutton", { name: "Diameter nm", exact: true })
      .fill(String(first));
  else {
    await page
      .getByRole("spinbutton", { name: "Width X nm", exact: true })
      .fill(String(first));
    await page
      .getByRole("spinbutton", { name: "Width Y nm", exact: true })
      .fill(String(second));
  }
  await closeSheet(page);
}
async function loseContext(page) {
  const actual = await canvas2D(page).evaluate((canvas) => {
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const extension = gl?.getExtension("WEBGL_lose_context");
    canvas.__qaLossExtension = extension;
    extension?.loseContext();
    return Boolean(extension);
  });
  assert.equal(
    actual,
    true,
    "Real WEBGL_lose_context is available; no synthetic event fallback",
  );
  await fallbackVisible(page);
}
async function restoreContext(page) {
  await canvas2D(page).evaluate((canvas) =>
    canvas.__qaLossExtension.restoreContext(),
  );
  await expect(canvas2D(page)).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".s2-fallback")).toHaveCount(0);
  await expect(canvas2D(page)).toHaveAttribute("tabindex", "0");
  await expect(canvas2D(page)).not.toHaveAttribute("aria-hidden", "true");
  await expect(
    page.locator('.s2-view-control select[aria-label="Structure view"]'),
  ).toBeVisible();
}
async function startup(kind, width) {
  await group(`${kind}-startup-${width}`, width, async (page, record) => {
    const fixture = fixtures[kind],
      original = fixture.project;
    await blockStartupWebGL(page);
    await ready(page, kind);
    await exactExport(page, fixture, original, record.name);
    await assertProjection(page, original, 0, `${record.name}-initial`);
    await checkLayoutAndGuide(page, width);
    await chip(page, 2).focus();
    await page.keyboard.press("Space");
    await expect(chip(page, 2)).toBeFocused();
    await assertProjection(page, original, 2, `${record.name}-keyboard-space`);
    await chip(page, 1).focus();
    await page.keyboard.press("Enter");
    await expect(chip(page, 1)).toBeFocused();
    await assertProjection(page, original, 1, `${record.name}-keyboard-enter`);
    const selectable = xz(page).locator(
      '[data-layer-index="0"][data-selectable="true"]',
    );
    await expect(selectable).toHaveCount(1);
    await selectable.locator('[data-layer-pick="0"]').tap();
    await expect(chip(page, 0)).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => window.scrollTo(0, 0));
    const scrollStart = await page.evaluate(() => scrollY);
    const swipeTarget = await xz(page)
      .locator('[data-layer-pick="2"]')
      .boundingBox();
    assert.ok(
      swipeTarget,
      "Distinct lower section is available for touch-scroll evidence",
    );
    const touchX = swipeTarget.x + swipeTarget.width / 2;
    const touchY = swipeTarget.y + swipeTarget.height / 2;
    await replayTouch(
      page,
      [{ x: touchX, y: touchY, id: 1 }],
      Array.from({ length: 8 }, (_, i) => [
        { x: touchX, y: touchY - (i + 1) * 14, id: 1 },
      ]),
    );
    await expect
      .poll(() => page.evaluate(() => scrollY))
      .toBeGreaterThan(scrollStart + 10);
    await expect(chip(page, 0)).toHaveAttribute("aria-pressed", "true");
    await expect(xy(page)).toHaveAttribute("data-selected-layer", "0");
    record.verticalSwipe = {
      initialScrollY: scrollStart,
      finalScrollY: await page.evaluate(() => scrollY),
      selectedLayer: 0,
    };
    await exactExport(
      page,
      fixture,
      original,
      `${record.name}-read-only-selection`,
    );
    await page.locator(".project-menu summary").click();
    await expect(
      page.getByRole("button", { name: "↶ Undo", exact: true }),
    ).toBeDisabled();
    await page.locator(".project-menu summary").click();
    await shot(page, `${record.name}-initial`);
    const changed = structuredClone(original);
    await editPattern(page, kind, 0, kind === "circular" ? 72 : 73, 64);
    if (kind === "circular") changed.layers[0].diameter_nm = 72;
    else Object.assign(changed.layers[0], { cd_x_nm: 73, cd_y_nm: 64 });
    await pitchCard(page).click();
    await page
      .getByRole("spinbutton", { name: "Pitch X nm", exact: true })
      .fill("170");
    await page
      .getByRole("spinbutton", { name: "Pitch Y nm", exact: true })
      .fill("190");
    await closeSheet(page);
    Object.assign(changed, { period_nm: 170, period_y_nm: 190 });
    await page
      .getByRole("button", { name: /^Edit Layer 1 thickness:/ })
      .click();
    await page.locator("#dimension-height").fill("105");
    await closeSheet(page);
    changed.layers[0].thickness_nm = 105;
    await assertProjection(page, changed, 0, `${record.name}-edited`);
    await exactExport(page, fixture, changed, `${record.name}-edited`);
    await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
    await expect(page.locator(".stale-note")).toHaveText(
      "This stored spectrum no longer matches your inputs.",
    );
    await shot(page, `${record.name}-edited`);
    record.checks.push(
      "Startup failure; exact circles/rectangles and per-layer center section; read-only keyboard (Space/Enter) chip and section tap selection; vertical touch-scroll without selection/input mutation; mobile labels, descriptions and guide; editable dimensions; complete unchanged result/hash and stale binding",
    );
  });
}
async function contextLifecycle(kind, width) {
  await group(
    `${kind}-context-lifecycle-${width}`,
    width,
    async (page, record) => {
      const fixture = fixtures[kind],
        changed = structuredClone(fixture.project);
      await ready(page, kind, false);
      const canvas = await canvas2D(page).elementHandle();
      await dimension(page, kind, 0).focus();
      await loseContext(page);
      await expect(dimension(page, kind, 0)).toBeFocused();
      await editPattern(page, kind, 0, 74, 63);
      if (kind === "circular") changed.layers[0].diameter_nm = 74;
      else Object.assign(changed.layers[0], { cd_x_nm: 74, cd_y_nm: 63 });
      await assertProjection(page, changed, 0, `${record.name}-lost-edited`);
      await shot(page, `${record.name}-lost-edited`);
      await dimension(page, kind, 0).focus();
      await restoreContext(page);
      await expect(dimension(page, kind, 0)).toBeFocused();
      assert.equal(
        await canvas.evaluate(
          (node) => node === document.querySelector(".s2-webgl canvas"),
        ),
        true,
        "Context restoration retains the same canvas",
      );
      if (kind === "rectangle") await assertScene(page, changed, true);
      else {
        const regions = JSON.parse(
          await canvas2D(page).getAttribute("data-circular-geometry"),
        );
        assert.ok(
          regions.some(
            (region) => region.layerIndex === 0 && region.diameterNm === 74,
          ),
          "Restored 3D uses edited circular geometry",
        );
      }
      await exactExport(
        page,
        fixture,
        changed,
        `${record.name}-first-restored`,
      );
      // A second genuine loss/restoration while a modal input owns focus must not steal it.
      await dimension(page, kind, 0).click();
      const field = page.getByRole("spinbutton", {
        name: kind === "circular" ? "Diameter nm" : "Width X nm",
        exact: true,
      });
      await field.focus();
      await loseContext(page);
      await expect(field).toBeFocused();
      await field.fill("76");
      if (kind === "circular") changed.layers[0].diameter_nm = 76;
      else changed.layers[0].cd_x_nm = 76;
      await assertProjection(page, changed, 0, `${record.name}-second-lost`);
      await restoreContext(page);
      await expect(field).toBeFocused();
      await closeSheet(page);
      await expect(dimension(page, kind, 0)).toBeFocused();
      await exactExport(
        page,
        fixture,
        changed,
        `${record.name}-second-restored`,
      );
      await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
      await expect(canvas2D(page)).toHaveCount(1);
      if (kind === "rectangle") await assertScene(page, changed, true);
      await shot(page, `${record.name}-restored`);
      record.checks.push(
        "Two actual context loss/restoration cycles; live edited SVG/3D geometry; same canvas; external and modal-input focus preserved; exact result/hash, stale binding and zero API calls",
      );
    },
  );
}
async function importAndHistory() {
  await group("mixed-import-edges-reorder-undo", 1440, async (page, record) => {
    const fixture = fixtures.circular;
    await blockStartupWebGL(page);
    await ready(page, "circular");
    const mixed = structuredClone(fixture.project);
    mixed.name = "SVG fallback physical edge browser QA";
    mixed.period_nm = 173;
    mixed.period_y_nm = 211;
    mixed.layers[0].diameter_nm = 0;
    mixed.layers[1].diameter_nm = 173;
    mixed.layers[1].material = {
      ...mixed.layers[1].material,
      name: "Non-air hole fill",
      n: 1.2,
    };
    mixed.layers[2].thickness_nm = 0;
    mixed.layers.push(structuredClone(fixtures.rectangle.project.layers[1]));
    mixed.layers.push({
      name: "Invariant Y ridge",
      geometry: "rectangle_1d",
      thickness_nm: 27,
      cd_nm: 68,
      material: structuredClone(fixtures.rectangle.project.layers[0].material),
      background: structuredClone(
        fixtures.rectangle.project.layers[0].background,
      ),
    });
    mixed.layers.push({
      ...structuredClone(fixtures.rectangle.project.layers[0]),
      name: "Zero Y rectangle",
      thickness_nm: 31,
      cd_x_nm: 74,
      cd_y_nm: 0,
    });
    // The imported genuine result remains bound to its real, unchanged reference input.
    await importText(
      page,
      {
        project: mixed,
        result: fixture.result,
        result_project: fixture.project,
      },
      "svg-fallback-mixed",
    );
    await expect(page.locator(".message.success")).toContainText(
      "JSON loaded.",
    );
    await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
    for (const selected of [0, 1, 2, 3, 4, 5]) {
      await chip(page, selected).click();
      await assertProjection(
        page,
        mixed,
        selected,
        `${record.name}-layer-${selected + 1}`,
      );
    }
    await chip(page, 1).click();
    await expect(
      xy(page).locator('circle[data-role="material"]'),
    ).toHaveAttribute("data-air", "false");
    await shot(page, `${record.name}-non-air-hole`);
    await exactExport(page, fixture, mixed, `${record.name}-imported`);
    await page
      .getByRole("button", { name: "Layer settings ↗", exact: true })
      .click();
    await page.getByLabel("Layer actions", { exact: true }).click();
    await page
      .getByRole("button", { name: "Move layer 2 down", exact: true })
      .click();
    await closeSheet(page, "Close settings");
    const reordered = structuredClone(mixed);
    [reordered.layers[1], reordered.layers[2]] = [
      reordered.layers[2],
      reordered.layers[1],
    ];
    await assertProjection(page, reordered, 2, `${record.name}-reordered`);
    await exactExport(page, fixture, reordered, `${record.name}-reordered`);
    await menuAction(page, "↶ Undo");
    await chip(page, 1).click();
    await assertProjection(page, mixed, 1, `${record.name}-undo`);
    await exactExport(page, fixture, mixed, `${record.name}-undo`);
    await menuAction(page, "↷ Redo");
    await chip(page, 2).click();
    await assertProjection(page, reordered, 2, `${record.name}-redo`);
    await exactExport(page, fixture, reordered, `${record.name}-redo`);
    await shot(page, `${record.name}-redo`);
    // A 20 × 5000 nm cell through a >6000 nm stack is intentionally narrow.
    // Its real subpixel widths and thin film must never become enlarged targets.
    const extreme = structuredClone(fixtures.rectangle.project);
    extreme.name = "Extreme unequal pitch with exact thin slab";
    extreme.period_nm = 20;
    extreme.period_y_nm = 5000;
    extreme.layers[0].thickness_nm = 2000;
    extreme.layers[0].cd_x_nm = 12;
    extreme.layers[0].cd_y_nm = 2400;
    extreme.layers[1].thickness_nm = 0.001;
    extreme.layers[2].thickness_nm = 2000;
    extreme.layers[2].cd_x_nm = 8;
    extreme.layers[2].cd_y_nm = 5000;
    extreme.layers.push({
      ...structuredClone(fixtures.rectangle.project.layers[1]),
      name: "Tall homogeneous film",
      thickness_nm: 2000,
    });
    extreme.layers.push({
      ...structuredClone(fixtures.rectangle.project.layers[1]),
      name: "Zero-thickness interface",
      thickness_nm: 0,
    });
    await importText(page, extreme, "svg-fallback-extreme");
    await expect(page.locator(".result-badge")).toHaveText("No result yet");
    await expect(xz(page)).toHaveAttribute("data-period-y", "5000");
    await chip(page, 1).focus();
    await page.keyboard.press("Enter");
    await assertProjection(page, extreme, 1, `${record.name}-extreme-thin`);
    await expect(xz(page).locator("[data-layer-pick]")).toHaveCount(0);
    await expect(xz(page).locator('[data-layer-index="1"]')).toHaveAttribute(
      "data-thickness-nm",
      "0.001",
    );
    await expect(xz(page).locator('[data-layer-index="4"]')).toHaveAttribute(
      "data-thickness-nm",
      "0",
    );
    await checkLayoutAndGuide(page, 1440);
    await exactExport(
      page,
      fixture,
      extreme,
      `${record.name}-extreme-thin`,
      null,
      null,
    );
    await shot(page, `${record.name}-extreme-thin`);
    const allZero = structuredClone(reordered);
    allZero.layers.forEach((layer) => {
      layer.thickness_nm = 0;
    });
    await importText(page, allZero, "svg-fallback-all-zero");
    await expect(page.locator(".result-badge")).toHaveText("No result yet");
    await expect(xz(page)).toHaveAttribute("data-total-thickness", "0");
    await chip(page, 0).click();
    await assertProjection(page, allZero, 0, `${record.name}-all-zero`);
    await exactExport(
      page,
      fixture,
      allZero,
      `${record.name}-all-zero`,
      null,
      null,
    );
    await expect(page.locator(".result-badge")).toHaveText("No result yet");
    await shot(page, `${record.name}-all-zero`);
    record.checks.push(
      "Exact import, zero diameter/thickness/width, full diameter, non-air fill, homogeneous film, invariant-Y ridge, all-zero stack; 20 × 5000 nm pitch with a 0.001 nm slab and no expanded pick targets; per-layer selection; reorder/Undo/Redo update physical SVG; unchanged stored spectrum on edits and no fabricated result for input-only imports",
    );
  });
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
  report.browserLaunched = true;
  watchdog = setTimeout(() => {
    report.issues.push({
      group: "suite-budget",
      error: "Required fallback browser coverage exceeded 280 seconds.",
    });
    void browser.close().catch(() => {});
  }, 280000);
  for (const kind of ["circular", "rectangle"])
    for (const width of [360, 390]) await startup(kind, width);
  await contextLifecycle("circular", 390);
  await contextLifecycle("rectangle", 360);
  await importAndHistory();
} catch (error) {
  report.issues.push({
    group: "initialization-or-orchestration",
    error: String(error),
  });
} finally {
  clearTimeout(watchdog);
  await browser?.close().catch(() => {});
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
  report.status =
    report.issues.length ||
    report.pageErrors.length ||
    report.groups.length !== 7 ||
    report.groups.some((item) => item.status !== "passed")
      ? "failed"
      : "passed";
  report.elapsedMs = Date.now() - started;
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    `${output}/svg-fallback-browser-qa.json`,
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
        report: "artifacts/svg-fallback-browser-qa.json",
      },
      null,
      2,
    ),
  );
  if (report.status !== "passed") process.exitCode = 1;
}
