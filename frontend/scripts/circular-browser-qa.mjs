// Genuine ordinary circular default: static UI + real local API, with retained
// rectangular and 1D regressions in their separate existing suites.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import {
  canvas2D,
  closeSheet,
  menuAction,
  importText,
  capture,
  assertFullResult,
} from "./browser-2d-controls.mjs";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const previewUrl = process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173";
const appUrl = process.env.RCWA_APP_URL || "http://127.0.0.1:5173";
const original = JSON.parse(
  await fs.readFile(
    new URL("../src/fixtures/default-project-circular.json", import.meta.url),
    "utf8",
  ),
);
const referenceBytes = await fs.readFile(
  new URL("../public/reference-circular.json", import.meta.url),
);
const reference = JSON.parse(referenceBytes);
const manifest = JSON.parse(
  await fs.readFile(
    new URL(
      "../src/fixtures/reference-circular-manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const report = {
  status: "running",
  checks: [],
  captures: [],
  screenshots: [],
  pageErrors: [],
  issues: [],
  limitations: [
    "CI Chromium touch emulation is not a real-device or spoken screen-reader test.",
    "Circle meshes illustrate the analytic shape; the solver metadata separately identifies bounded midpoint-strip discretization.",
  ],
};
const diameter = (page, layer = 1) =>
  page.getByRole("button", {
    name: new RegExp(`^Edit Layer ${layer} diameter:`),
  });
async function assertInspectorBackdrop(page) {
  const inspector = page.locator("dialog.inspector[open]");
  await expect(inspector).toHaveClass(/structure2d-inspector/);
  await expect
    .poll(() =>
      inspector.evaluate((node) => {
        const style = getComputedStyle(node, "::backdrop");
        return {
          filter: style.backdropFilter,
          background: style.backgroundColor,
        };
      }),
    )
    .toEqual({ filter: "none", background: "rgba(24, 24, 27, 0.35)" });
}
async function shot(page, name) {
  if (await page.locator("dialog.inspector[open]").count())
    await assertInspectorBackdrop(page);
  await capture(page, report, output, name, { prefix: "circular" });
}
async function exported(page, name) {
  const pending = page.waitForEvent("download");
  await menuAction(page, "Export");
  const download = await pending,
    path = `${output}/circular-${name}.json`;
  await download.saveAs(path);
  return JSON.parse(await fs.readFile(path, "utf8"));
}
async function imported(page, data, name) {
  const dismiss = page.getByRole("button", {
    name: "Dismiss notification",
    exact: true,
  });
  if (await dismiss.isVisible()) await dismiss.click();
  await importText(page, data, name);
  await expect(page.locator(".message.success")).toContainText("JSON loaded.");
}
async function ready(page, url = previewUrl) {
  await page.goto(url);
  await expect(canvas2D(page)).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
  await page.evaluate(() => document.fonts.ready);
}
async function inspectCircleScene(page, project, cutaway = true) {
  const scene = await canvas2D(page).evaluate((n) => ({ ...n.dataset }));
  assert.equal(scene.cutaway, String(cutaway));
  const regions = JSON.parse(scene.circularGeometry),
    meshes = JSON.parse(scene.renderedMeshes);
  project.layers.forEach((l, i) => {
    if (
      l.geometry !== "circular_hole_2d" ||
      l.thickness_nm === 0 ||
      l.diameter_nm === 0
    )
      return;
    const pair = regions.filter((r) => r.layerIndex === i);
    assert.equal(pair.length, 2);
    const fraction = cutaway ? 0.75 : 1,
      area = Math.PI * (l.diameter_nm / 2) ** 2;
    for (const role of ["material", "background"]) {
      const r = pair.find((r) => r.role === role);
      assert.ok(r);
      assert.equal(r.diameterNm, l.diameter_nm);
      const expected =
        9 *
        fraction *
        l.thickness_nm *
        (role === "material"
          ? area
          : project.period_nm * project.period_y_nm - area);
      assert.ok(
        Math.abs(r.analyticVolumeNm3 - expected) < 1e-7 * Math.max(1, expected),
      );
      assert.ok(
        Math.abs(r.meshVolumeNm3 - expected) < 0.002 * Math.max(1, expected),
        "Mesh follows circle, not a square",
      );
      assert.ok(r.radialSegments >= 64);
    }
    assert.ok(
      meshes.some(
        (m) => m.layerIndex === i && m.role === "background" && m.circular,
      ),
      "Real host cutout mesh",
    );
    const fill = l.material;
    if (fill.kind === "constant" && fill.n === 1 && fill.k === 0)
      assert.ok(
        !meshes.some((m) => m.layerIndex === i && m.role === "material"),
        "Air hole remains open",
      );
  });
}
let browser;
try {
  assert.equal(
    createHash("sha256").update(referenceBytes).digest("hex"),
    manifest.bundle_sha256,
  );
  assert.deepEqual(reference.project, original);
  assert.equal(reference.result.metadata.adapter_version, "1.3.0");
  assert.equal(reference.result.metadata.circular_geometry.strips, 64);
  assertFullResult(reference.result, original);
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  for (const [width, height] of [
    [360, 800],
    [390, 844],
    [1440, 1000],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: width < 700,
      hasTouch: width < 700,
    });
    const page = await context.newPage(),
      apiCalls = [];
    page.on("pageerror", (e) => report.pageErrors.push(e.message));
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/")) apiCalls.push(r.url());
    });
    await ready(page);
    await expect(diameter(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Edit Layer 1 width:/ }),
    ).toHaveCount(0);
    const primary = page.getByRole("link", { name: "View example spectrum" });
    const box = await primary.boundingBox();
    assert.ok(
      box && box.y >= 0 && box.y + box.height <= height,
      "Main action on the first screen",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await inspectCircleScene(page, original);
    await shot(page, `${width}-initial`);
    await page.getByRole("button", { name: /^Select layer 3:/ }).click();
    await expect(diameter(page, 3)).toBeVisible();
    await page.getByRole("button", { name: /^Select layer 1:/ }).click();
    await diameter(page).click();
    const input = page.getByRole("spinbutton", {
      name: "Diameter nm",
      exact: true,
    });
    await expect(input).toHaveValue(String(original.layers[0].diameter_nm));
    await input.fill(
      String(Math.min(original.period_nm, original.period_y_nm) + 1),
    );
    await expect(page.getByRole("alert")).toContainText("not applied");
    await shot(page, `${width}-diameter-invalid`);
    await closeSheet(page, "Close settings");
    await expect(diameter(page)).toBeFocused();
    assert.deepEqual(
      (await exported(page, `${width}-invalid-preserved`)).project,
      original,
    );
    await diameter(page).click();
    const changed = original.layers[0].diameter_nm + 3;
    await input.fill(String(changed));
    await closeSheet(page, "Escape");
    await expect(diameter(page)).toBeFocused();
    await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
    await menuAction(page, "↶ Undo");
    assert.deepEqual((await exported(page, `${width}-undo`)).project, original);
    await menuAction(page, "↷ Redo");
    const edited = await exported(page, `${width}-diameter-edited`);
    assert.equal(edited.project.layers[0].diameter_nm, changed);
    assert.deepEqual(edited.result_project, original);
    assert.deepEqual(edited.result, reference.result);
    await page.getByRole("button", { name: /^Edit shared pitch:/ }).click();
    const largest = Math.max(...original.layers.map((l) => l.diameter_nm));
    await page
      .getByRole("spinbutton", { name: "Pitch Y nm", exact: true })
      .fill(String(largest - 1));
    await expect(page.getByRole("alert")).toContainText("because of Layer");
    await closeSheet(page);
    assert.equal(
      (await exported(page, `${width}-pitch-rejected`)).project.period_y_nm,
      original.period_y_nm,
    );
    await page
      .getByRole("button", { name: "Layer settings ↗", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit materials", exact: true })
      .click();
    const holeTab = page.getByRole("button", {
      name: "Hole material",
      exact: true,
    });
    const hostTab = page.getByRole("button", {
      name: "Host material",
      exact: true,
    });
    await expect(holeTab).toHaveAttribute("aria-pressed", "true");
    await expect(hostTab).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.getByRole("textbox", { name: "Hole material name", exact: true }),
    ).toHaveValue(original.layers[0].material.name);
    await hostTab.click();
    await expect(hostTab).toHaveAttribute("aria-pressed", "true");
    await expect(holeTab).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.getByRole("textbox", { name: "Host material name", exact: true }),
    ).toHaveValue(original.layers[0].background.name);
    // Native selection state changes before the inherited 160ms button color
    // transition ends. Capture only the matching settled visual state.
    await expect(hostTab).toHaveCSS("background-color", "rgb(238, 242, 255)");
    await expect(hostTab).toHaveCSS("color", "rgb(79, 70, 229)");
    await expect(holeTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(holeTab).toHaveCSS("color", "rgb(24, 24, 27)");
    await assertInspectorBackdrop(page);
    await shot(page, `${width}-host-material`);
    await closeSheet(page, "Close settings");
    await page.getByRole("button", { name: /^Select layer 2:/ }).click();
    await page
      .getByRole("button", { name: /^Edit Layer 2 thickness:/ })
      .click();
    await page
      .locator("#dimension-height")
      .fill(String(original.layers[1].thickness_nm + 1.5));
    await closeSheet(page, "Close settings");
    const depthEdit = await exported(page, `${width}-independent-depth`);
    assert.equal(
      depthEdit.project.layers[1].thickness_nm,
      original.layers[1].thickness_nm + 1.5,
    );
    assert.equal(
      depthEdit.project.layers[0].thickness_nm,
      original.layers[0].thickness_nm,
    );
    await imported(page, edited, `${width}-circle-roundtrip`);
    assert.deepEqual(
      (await exported(page, `${width}-roundtrip`)).project,
      edited.project,
    );
    await page.getByRole("button", { name: /^Select layer 1:/ }).click();
    await page
      .getByRole("button", { name: "Layer settings ↗", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Layer type", exact: true })
      .selectOption("rectangle_2d");
    await expect(
      page.getByRole("spinbutton", { name: /^Width X\s*nm$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("spinbutton", { name: "Diameter nm", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("combobox", { name: "Layer type", exact: true })
      .selectOption("homogeneous");
    await page
      .getByRole("combobox", { name: "Layer type", exact: true })
      .selectOption("circular_hole_2d");
    await expect(
      page.getByRole("spinbutton", { name: "Diameter nm", exact: true }),
    ).toBeVisible();
    await closeSheet(page, "Close settings");
    await menuAction(page, "Reset example");
    await expect(page.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    assert.deepEqual(
      (await exported(page, `${width}-reset`)).project,
      original,
    );
    await page
      .getByRole("combobox", { name: "Structure view", exact: true })
      .selectOption("full");
    await inspectCircleScene(page, original, false);
    await shot(page, `${width}-full-stack`);
    if (width === 1440) {
      const endpoint = structuredClone(original);
      endpoint.layers[0].diameter_nm = Math.min(
        endpoint.period_nm,
        endpoint.period_y_nm,
      );
      await imported(page, { project: endpoint }, "max-diameter");
      await inspectCircleScene(page, endpoint, false);
      await shot(page, "desktop-max-diameter-host-corners");
      endpoint.layers[0].material = {
        ...endpoint.layers[0].material,
        name: "Synthetic filled hole",
        n: 1.2,
      };
      await imported(page, { project: endpoint }, "filled-hole");
      const filled = JSON.parse(
        await canvas2D(page).getAttribute("data-rendered-meshes"),
      );
      assert.ok(
        filled.some(
          (mesh) =>
            mesh.layerIndex === 0 && mesh.role === "material" && mesh.circular,
        ),
        "Non-air hole fill remains a real solid",
      );
      await shot(page, "desktop-nonair-hole-fill");
      endpoint.layers[0].diameter_nm = 0;
      await imported(page, { project: endpoint }, "zero-diameter");
      await expect(
        page.getByText(
          "Layer 1 has zero hole diameter; its host fills the layer.",
          { exact: true },
        ),
      ).toBeVisible();
      await shot(page, "desktop-zero-diameter-host");
    }
    assert.deepEqual(
      apiCalls,
      [],
      "Static preview never calls local computation",
    );
    report.checks.push(
      `${width} px: real cutout, first-screen action, selection, invalid/valid diameter, Close/Escape focus, undo/redo, pitch bounds, material roles, conversions, import/export, truthful stale result`,
    );
    await context.close();
  }
  // Actual calculation on ordinary route with a bounded one-wavelength edited input.
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  page.on("pageerror", (e) => report.pageErrors.push(e.message));
  await ready(page, appUrl);
  await expect(page.locator(".connection")).toHaveText("Solver connected");
  const runProject = structuredClone(original);
  runProject.illumination.wavelengths_nm = [
    original.illumination.wavelengths_nm[0],
  ];
  runProject.layers[0].diameter_nm += 2;
  runProject.name = "Circular browser real calculation";
  await imported(page, { project: runProject }, "real-run");
  await page.getByRole("button", { name: /Run simulation/ }).click();
  await expect(page.locator(".result-badge")).toHaveText(
    /^(Computed|Server-computed)$/,
    { timeout: 60000 },
  );
  const computed = await exported(page, "real-run-result");
  assert.deepEqual(computed.result_project, runProject);
  assertFullResult(computed.result, runProject);
  assert.equal(computed.result.metadata.adapter_version, "1.3.0");
  assert.equal(computed.result.metadata.circular_geometry.strips, 64);
  assert.notEqual(computed.result.metadata.input_hash, manifest.input_hash);
  await shot(page, "desktop-real-computation");
  report.checks.push(
    "Actual local API circle solve, full result binding, edited hash and no inherited convergence claim",
  );
  // A double click starts exactly one real job. Cancellation preserves the
  // previous complete spectrum and its input snapshot without fabricating data.
  const cancelProject = structuredClone(runProject);
  cancelProject.illumination.wavelengths_nm = Array.from(
    { length: 31 },
    (_, i) => 450 + 10 * i,
  );
  await imported(
    page,
    { ...computed, project: cancelProject },
    "cancel-with-previous-spectrum",
  );
  const creations = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/jobs" &&
      request.method() === "POST"
    )
      creations.push(request.url());
  });
  const createdResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/jobs" &&
      response.request().method() === "POST",
  );
  createdResponse.catch(() => {});
  await page
    .getByRole("button", { name: /Run simulation/ })
    .dblclick({ force: true });
  const created = await (await createdResponse).json();
  await expect(diameter(page)).toBeDisabled();
  await expect(page.locator(".run-button")).toBeDisabled();
  const cancelButton = page.getByRole("button", {
    name: "Cancel",
    exact: true,
  });
  await expect(cancelButton).toBeEnabled();
  const cancelledResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/jobs/${created.id}` &&
      response.request().method() === "DELETE",
  );
  cancelledResponse.catch(() => {});
  await cancelButton.click();
  const terminal = await (await cancelledResponse).json();
  assert.equal(
    terminal.status,
    "cancelled",
    "A genuine in-progress circular job was cancelled",
  );
  await expect(page.locator(".run-button")).toBeEnabled();
  assert.equal(creations.length, 1, "Repeated Run clicks create only one job");
  const cancelled = await exported(page, "cancel-preserved-spectrum");
  assert.deepEqual(cancelled.result, computed.result);
  assert.deepEqual(cancelled.result_project, computed.result_project);
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  report.checks.push(
    "Double-click submission created one real circle job; cancellation preserved the complete prior spectrum",
  );
  // Genuine WebGL context loss leaves numeric editing usable.
  await canvas2D(page).evaluate((canvas) =>
    (() => {
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      const extension = gl?.getExtension("WEBGL_lose_context");
      if (!extension) throw new Error("WEBGL_lose_context unavailable");
      extension.loseContext();
    })(),
  );
  await expect(
    page.getByText("3D view is unavailable.", { exact: true }),
  ).toBeVisible();
  await diameter(page).click();
  await expect(
    page.getByRole("spinbutton", { name: "Diameter nm", exact: true }),
  ).toBeEnabled();
  const fallbackDiameter = cancelProject.layers[0].diameter_nm + 1;
  await page
    .getByRole("spinbutton", { name: "Diameter nm", exact: true })
    .fill(String(fallbackDiameter));
  await closeSheet(page);
  const fallback = await exported(page, "fallback-diameter-edited");
  assert.equal(fallback.project.layers[0].diameter_nm, fallbackDiameter);
  assert.deepEqual(fallback.result, computed.result);
  await shot(page, "desktop-webgl-fallback");
  await context.close();
  assert.deepEqual(report.pageErrors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.issues.push(String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fs.writeFile(
    `${output}/circular-browser-report.json`,
    JSON.stringify(report, null, 2),
  );
}
