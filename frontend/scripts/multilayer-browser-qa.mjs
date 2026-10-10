// Run against the real local API, live Vite app and a separately built static app.
// No successful numerical responses are mocked. Screenshots are mandatory and
// captured in fresh browser processes before state/gesture stress cases.
/* global document, innerWidth, window */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect as baseExpect, errors } from "@playwright/test";
const expect = baseExpect.configure({ timeout: 10000 });
const apiUrl = process.env.RCWA_API_URL || "http://127.0.0.1:8000";
const appUrl = process.env.RCWA_APP_URL || "http://127.0.0.1:5173";
const staticUrl = process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const checks = [],
  pageErrors = [],
  activeJobs = new Set();
const evidence = { jobs: [], snapshots: [], screenshots: [], captures: [] };
let browser,
  page,
  exports = 0;
async function request(
  path,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(`${apiUrl}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  assert.ok(
    response.ok,
    `${method} ${path}: ${response.status} ${JSON.stringify(data)}`,
  );
  return data;
}
async function solve(project) {
  const accepted = await request("/validate", project);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.diagnostics));
  let job = await request("/jobs", {
    kind: "forward",
    project: accepted.project,
  });
  activeJobs.add(job.id);
  const deadline = Date.now() + 130000;
  while (["running", "queued"].includes(job.status)) {
    assert.ok(
      Date.now() < deadline,
      "Real multilayer solve exceeded its deadline",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    job = await request(`/jobs/${job.id}`);
  }
  activeJobs.delete(job.id);
  assert.equal(job.status, "succeeded", JSON.stringify(job));
  assert.equal(job.result.schema_version, "1.1");
  assert.equal(job.result.metadata.layer_count, project.layers.length);
  assert.equal(
    job.result.metadata.total_thickness_nm,
    project.layers.reduce((sum, layer) => sum + layer.thickness_nm, 0),
  );
  const snapshot = await request("/snapshots", { job_id: job.id });
  assert.equal(snapshot.provenance.source, "server_computed");
  assert.deepEqual(snapshot.project, accepted.project);
  assert.deepEqual(snapshot.result, job.result);
  evidence.jobs.push({
    id: job.id,
    inputHash: job.input_hash,
    metadata: job.result.metadata,
  });
  evidence.snapshots.push({ id: snapshot.id, project: snapshot.project });
  return snapshot;
}
async function launch(viewport, url = appUrl) {
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
  page = await browser.newPage({ viewport });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const calls = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      calls.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
      });
  });
  await page.goto(url);
  await expect(page.locator(".connection")).toHaveText(
    url === staticUrl ? "Static preview" : "Solver connected",
  );
  return calls;
}
async function menu() {
  const host = page.locator(".project-menu");
  if (!(await host.evaluate((node) => node.open)))
    await host.locator("summary").click();
}
async function exportJson() {
  await menu();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await pending,
    target = `${output}/multilayer-export-${++exports}.json`;
  await download.saveAs(target);
  const result = JSON.parse(await fs.readFile(target, "utf8"));
  assert.equal(result.provenance, undefined);
  return {
    project: result.project,
    result: result.result,
    result_project: result.result_project,
  };
}
async function importJson(data, filename = "multilayer.json") {
  await page.locator(".file-actions input[type=file]").setInputFiles({
    name: filename,
    mimeType: "application/json",
    buffer: Buffer.from(typeof data === "string" ? data : JSON.stringify(data)),
  });
}
async function load(snapshot) {
  await menu();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Saved projects",
    exact: true,
  });
  await dialog
    .locator(".saved-item")
    .filter({ hasText: snapshot.name })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel("Project name")).toHaveValue(
    snapshot.project.name,
  );
  await expect(page.locator(".result-badge")).toHaveText("Server-computed");
}
async function openPicker() {
  const picker = page.getByTestId("layer-stack");
  if (!(await picker.evaluate((node) => node.open)))
    await page.getByTestId("layer-picker-toggle").click();
  return picker;
}
async function openAddChoices() {
  const picker = await openPicker();
  const toggle = picker.locator('summary[aria-label="Add layer"]');
  if (!(await toggle.evaluate((node) => node.parentElement.open)))
    await toggle.click();
  return picker;
}
async function addLayer(label) {
  await openAddChoices();
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByTestId("layer-stack")).not.toHaveAttribute("open");
  await expect(page.getByTestId("layer-picker-toggle")).toBeFocused();
}
async function openLayerActions() {
  await openPicker();
  await page
    .getByRole("button", { name: "Edit selected layer", exact: true })
    .click();
  const inspector = page.locator(".inspector");
  await expect(inspector).toBeVisible();
  const toggle = inspector.locator('summary[aria-label="Layer actions"]');
  if (!(await toggle.evaluate((node) => node.parentElement.open)))
    await toggle.click();
  return inspector;
}
async function layerAction(label) {
  await openLayerActions();
  await page.getByRole("button", { name: label, exact: true }).click();
  if (await page.locator(".inspector").isVisible()) await closeSettings();
}
async function select(index, name) {
  await openPicker();
  await page
    .getByRole("button", {
      name: `Select layer ${index + 1}: ${name}`,
      exact: true,
    })
    .click();
  await expect(page.getByTestId("layer-stack")).not.toHaveAttribute("open");
  await expect(page.getByTestId("layer-picker-toggle")).toBeFocused();
}
async function history(direction) {
  await menu();
  await page
    .getByRole("button", {
      name: direction === "undo" ? /↶\s*Undo/ : /↷\s*Redo/,
    })
    .click();
}
async function dimension(name, value) {
  await page
    .locator(".dimension-rail")
    .getByRole("button", {
      name: new RegExp(name === "height" ? "height|thickness" : name, "i"),
    })
    .click();
  const input = page.locator(`#dimension-${name}`);
  if (value !== undefined) await input.fill(String(value));
  return input;
}
async function closeSettings() {
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
}
async function proposalReview(proposal) {
  await importJson(proposal, "multilayer-proposal.json");
  const dialog = page.getByRole("dialog").filter({
    has: page.getByRole("button", { name: "Apply changes", exact: true }),
  });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function noOverflow(dialog) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "Page must fit the viewport",
  );
  if (dialog)
    assert.equal(
      await dialog.evaluate((node) => node.scrollWidth > node.clientWidth + 1),
      false,
      "Dialog content must not overflow",
    );
}
async function capture(name) {
  const filename = `multilayer-${name}.png`,
    result = { filename, attempts: [] };
  evidence.captures.push(result);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.screenshot({
        path: `${output}/${filename}`,
        fullPage: false,
        timeout: 10000,
      });
      result.attempts.push({ attempt, status: "passed" });
      evidence.screenshots.push(filename);
      return;
    } catch (error) {
      result.attempts.push({ attempt, status: "failed", error: String(error) });
      if (!(error instanceof errors.TimeoutError) || attempt === 2) throw error;
    }
  }
}
try {
  const base = await request("/example"),
    stamp = Date.now();
  const uniform = {
    name: "Spacer",
    geometry: "homogeneous",
    thickness_nm: 95,
    material: {
      ...structuredClone(base.layers[0].material),
      name: "Synthetic spacer",
      n: 1.45,
    },
  };
  const stack = {
    ...structuredClone(base),
    schema_version: "1.1",
    name: `Stack QA ${stamp}`,
    layers: [
      {
        ...structuredClone(base.layers[0]),
        name: "Top grating",
        thickness_nm: 110,
      },
      uniform,
      {
        ...structuredClone(base.layers[0]),
        name: "Bottom grating",
        cd_nm: 230,
        thickness_nm: 80,
        material: {
          ...structuredClone(base.layers[0].material),
          n: 2.4,
          k: 0.02,
        },
      },
    ],
    illumination: {
      ...base.illumination,
      wavelengths_nm: [470, 530, 610, 710, 830],
    },
    solver: { harmonics: 7 },
  };
  const saved = await solve(stack),
    alternative = structuredClone(saved.project);
  alternative.name = `Stack alternative ${stamp}`;
  alternative.layers[2].material.n = 2.55;
  const savedOther = await solve(alternative);
  checks.push(
    "Real three-layer jobs and snapshots retain exact normalized stack, current result metadata and server-owned provenance",
  );
  const changes = structuredClone(saved.project.layers);
  changes[1].thickness_nm = 123;
  changes[1].material.n = 1.7;
  changes[2].cd_nm = 215;
  const proposal = await request("/stack-change-preview", {
    base_project: saved.project,
    changes: { period_nm: 420, layers: changes },
  });
  assert.equal(proposal.schema_version, "rcwa-change-proposal/1.1");
  assert.equal(proposal.valid, true);
  // Required pixels in short-lived fresh renderers, before edit stress.
  for (const width of [1440, 360, 390]) {
    await launch({ width, height: width > 500 ? 1100 : 844 });
    await load(saved);
    await select(2, "Bottom grating");
    await expect(page.locator(".width-handle")).toHaveAttribute(
      "aria-valuenow",
      "230",
    );
    await expect(
      page.getByTestId("layer-stack").locator(".stack-rows"),
    ).not.toBeVisible();
    await expect(page.locator(".setup-rows > button")).toHaveCount(2);
    await expect(page.locator(".scene-material")).toContainText("Layer 3");
    await page.evaluate(() => window.scrollTo(0, 0));
    await noOverflow();
    await capture(`scene-${width}`);
    await openPicker();
    await page.getByTestId("layer-stack").scrollIntoViewIfNeeded();
    await noOverflow();
    await capture(`stack-${width}`);
    await select(1, "Spacer");
    await expect(page.locator(".width-handle")).toHaveCount(0);
    const height = await dimension("height");
    await expect(height).toHaveValue("95");
    await noOverflow();
    await capture(`uniform-${width}`);
    await closeSettings();
    const actions = await openLayerActions();
    await noOverflow(actions);
    await capture(`actions-${width}`);
    await page.keyboard.press("Escape");
    await expect(actions).toBeVisible();
    await expect(actions.locator(".layer-actions")).not.toHaveAttribute("open");
    await expect(
      actions.locator('summary[aria-label="Layer actions"]'),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(actions).not.toBeVisible();
    await openAddChoices();
    await page.getByTestId("layer-stack").scrollIntoViewIfNeeded();
    await noOverflow();
    await capture(`add-${width}`);
    await page.keyboard.press("Escape");
    await expect(page.locator(".stack-add")).not.toHaveAttribute("open");
    await expect(page.getByTestId("layer-stack")).toHaveAttribute("open");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("layer-stack")).not.toHaveAttribute("open");
    await expect(page.getByTestId("layer-picker-toggle")).toBeFocused();
    const eight = structuredClone(saved.project);
    eight.layers = Array.from({ length: 8 }, (_, i) => ({
      ...structuredClone(saved.project.layers[i % 3]),
      name: `Layer ${i + 1}`,
    }));
    eight.layers[6].name = "L".repeat(100);
    await importJson(eight, "eight-layer-visual.json");
    await openPicker();
    await expect(
      page.getByTestId("layer-stack").locator("[data-layer-index]"),
    ).toHaveCount(8);
    await page.getByTestId("layer-stack").scrollIntoViewIfNeeded();
    await noOverflow();
    await capture(`picker-eight-${width}`);
    await select(6, eight.layers[6].name);
    await page.locator(".scene-material").click();
    const longNameInspector = page.locator(".inspector");
    await expect(longNameInspector.locator("h2")).toContainText(
      eight.layers[6].name,
    );
    await noOverflow(longNameInspector);
    await expect(
      page.getByRole("button", { name: "Close settings", exact: true }),
    ).toBeInViewport();
    await capture(`long-name-${width}`);
    await closeSettings();
    await load(saved);
    const review = await proposalReview(proposal);
    await expect(review.locator(".geometry-preview-card")).toHaveCount(2);
    await expect(review).toContainText("No new spectrum has been calculated");
    await noOverflow(review);
    await capture(`proposal-${width}`);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await browser.close();
    browser = undefined;
  }
  checks.push(
    "Desktop, 360px and 390px show all three physical layers, selected lower-layer handles, uniform film inspector and same-scale stack proposal cross-sections; closed first screen, contextual actions/add choices, open eight-layer picker and 100-character unbroken inspector name; all twenty-four required screenshots captured",
  );
  const calls = await launch({ width: 1440, height: 1100 });
  await load(saved);
  const baseline = await exportJson(),
    beforeLocal = calls.length;
  await select(2, "Bottom grating");
  await dimension("width", 237);
  await closeSettings();
  const edited = await exportJson();
  assert.equal(edited.project.layers[2].cd_nm, 237);
  assert.equal(edited.project.layers[0].cd_nm, 180);
  assert.deepEqual(edited.result_project, baseline.result_project);
  assert.deepEqual(edited.result, baseline.result);
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  await history("undo");
  assert.deepEqual(await exportJson(), baseline);
  await history("redo");
  assert.deepEqual(await exportJson(), edited);
  await history("undo");
  checks.push(
    "Selected lower-layer exact editing changes only its CD; stale output retains original stack and Undo/Redo restores exact project/result pairs",
  );
  await select(1, "Spacer");
  await layerAction("Move layer 2 up");
  assert.deepEqual(
    (await exportJson()).project.layers.map((layer) => layer.name),
    ["Spacer", "Top grating", "Bottom grating"],
  );
  await history("undo");
  assert.deepEqual(await exportJson(), baseline);
  await select(1, "Spacer");
  await layerAction("Remove layer 2");
  assert.deepEqual(
    (await exportJson()).project.layers.map((layer) => layer.name),
    ["Top grating", "Bottom grating"],
  );
  await history("undo");
  assert.deepEqual(await exportJson(), baseline);
  await select(2, "Bottom grating");
  for (const action of [
    "Duplicate layer 3",
    "Add uniform layer",
    "Add patterned layer",
  ]) {
    if (action.startsWith("Add")) await addLayer(action);
    else await layerAction(action);
    assert.equal((await exportJson()).project.layers.length, 4);
    await history("undo");
    assert.deepEqual(await exportJson(), baseline);
  }
  assert.equal(
    calls.length,
    beforeLocal,
    "Local stack and history operations must not call the API",
  );
  checks.push(
    "Reordering, removal, duplication and both layer additions are one-step undoable local changes with no solver or persistence request",
  );
  await page.locator("#fit > summary").click();
  await expect(
    page.getByRole("button", { name: "Run synthetic recovery", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#fit")).toContainText(/one|single|exactly/);
  await page.locator("#fit > summary").click();
  checks.push(
    "Synthetic CD recovery is explicitly disabled for a multilayer stack",
  );
  let review = await proposalReview(proposal);
  await review.getByText("Full inputs", { exact: true }).click();
  assert.deepEqual(
    JSON.parse(await review.locator("pre").nth(1).textContent()),
    proposal.candidate_project,
  );
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(await exportJson(), baseline);
  review = await proposalReview(proposal);
  await review
    .getByRole("button", { name: "Apply changes", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect(review).not.toBeVisible();
  const applied = await exportJson();
  assert.deepEqual(applied.project, proposal.candidate_project);
  assert.deepEqual(applied.result_project, baseline.result_project);
  assert.deepEqual(applied.result, baseline.result);
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  await history("undo");
  assert.deepEqual(await exportJson(), baseline);
  assert.equal(calls.length, beforeLocal);
  checks.push(
    "Actual stack proposal displays full exact inputs, cancels without mutation and repeated Apply installs one undoable edit while retaining stale original output",
  );
  await select(2, "Bottom grating");
  await dimension("width", 231);
  await closeSettings();
  review = await proposalReview(proposal);
  await expect(
    review.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeDisabled();
  await expect(review.getByRole("alert")).toContainText(
    /different inputs|changed/,
  );
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await history("undo");
  assert.deepEqual(await exportJson(), baseline);
  const forged = structuredClone(proposal);
  forged.candidate_project.ambient.n = 1.1;
  await importJson(forged, "multilayer-forged.json");
  await expect(page.locator(".message.error")).toBeVisible();
  assert.deepEqual(await exportJson(), baseline);
  checks.push(
    "Stale stack proposals cannot apply and off-patch ambient changes are rejected",
  );
  // Reset the page to clear the deliberately invalid import before snapshot comparison.
  await page.reload();
  await expect(page.locator(".connection")).toHaveText("Solver connected");
  await load(saved);
  await menu();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "Saved projects",
    exact: true,
  });
  for (const candidate of [saved, savedOther])
    await dialog
      .getByRole("checkbox", { name: `Compare ${candidate.name}`, exact: true })
      .check();
  await dialog.getByRole("button", { name: /Compare \(2\)/ }).click();
  dialog = page.getByRole("dialog", {
    name: "Compare candidates",
    exact: true,
  });
  await expect(dialog.locator(".candidate-card")).toHaveCount(2);
  await expect(dialog.locator(".comparison-warning")).toBeVisible();
  for (let index = 0; index < 2; index++) {
    const card = dialog.locator(".candidate-card").nth(index),
      candidate = [saved, savedOther][index];
    await card.getByText("Run details", { exact: true }).click();
    assert.deepEqual(
      JSON.parse(await card.locator("pre").textContent()),
      candidate.project,
    );
  }
  await page.keyboard.press("Escape");
  assert.deepEqual(await exportJson(), baseline);
  checks.push(
    "Stored stack comparison includes full layer data and warns about a material change confined to the bottom layer",
  );
  // Min/max editing bounds and schema migration are checked through actual controls.
  await importJson(base, "multilayer-legacy-project.json");
  assert.equal((await exportJson()).project.schema_version, "1.0");
  await openLayerActions();
  await expect(
    page.getByRole("button", { name: "Remove layer 1", exact: true }),
  ).toBeDisabled();
  await closeSettings();
  await addLayer("Add uniform layer");
  assert.equal((await exportJson()).project.schema_version, "1.1");
  for (let count = 2; count < 8; count++) await addLayer("Add uniform layer");
  assert.equal((await exportJson()).project.layers.length, 8);
  await select(0, base.layers[0].name);
  await openPicker();
  await expect(page.locator(".stack-add > summary")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  for (const label of ["Add uniform layer", "Add patterned layer"])
    await expect(
      page.locator(`.stack-add button[aria-label="${label}"]`),
    ).toBeDisabled();
  await openLayerActions();
  await expect(
    page.getByRole("button", { name: "Duplicate layer 1", exact: true }),
  ).toBeDisabled();
  await closeSettings();
  checks.push(
    "Legacy projects stay schema1.0 until stack addition; UI enforces one-to-eight finite layers",
  );
  // Reproduce a real response larger than the old 2 MB proposal cap, without
  // storing a multi-megabyte fixture or expanding table rows into review diffs.
  const rows = 1000,
    table = {
      ...structuredClone(base.layers[0].material),
      name: "Dense synthetic table",
      kind: "tabulated",
      n: 1,
      k: 0,
      wavelengths_nm: Array.from(
        { length: rows },
        (_, i) => 400 + (500 * i) / (rows - 1),
      ),
      n_values: Array.from(
        { length: rows },
        (_, i) => 1.25 + i * 0.00000123456789,
      ),
      k_values: Array.from(
        { length: rows },
        (_, i) => 0.001 + i * 0.000000023456789,
      ),
    };
  const dense = structuredClone(base);
  dense.schema_version = "1.1";
  dense.layers = Array.from({ length: 8 }, (_, i) => ({
    ...structuredClone(base.layers[0]),
    name: `Dense layer ${i + 1}`,
    thickness_nm: 100,
    material: structuredClone(table),
    background: structuredClone(table),
  }));
  const denseBase = (await request("/validate", dense)).project;
  const denseLayers = structuredClone(denseBase.layers);
  denseLayers[4].material.n_values[17] += 0.0001;
  const denseRequest = {
    base_project: denseBase,
    changes: { layers: denseLayers },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(denseRequest)) < 2_000_000);
  const denseProposal = await request("/stack-change-preview", denseRequest);
  const denseText = JSON.stringify(denseProposal);
  assert.ok(
    Buffer.byteLength(denseText) > 2_000_000 &&
      Buffer.byteLength(denseText) < 8_000_000,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(denseProposal.diff)) < 2000);
  await importJson(denseBase, "dense-stack-base.json");
  review = await proposalReview(denseProposal);
  await expect(
    review.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeEnabled();
  await expect(review.locator(".change-list")).toContainText(/1000|table/i);
  await review
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  assert.deepEqual(
    (await exportJson()).project,
    denseProposal.candidate_project,
  );
  await history("undo");
  assert.deepEqual((await exportJson()).project, denseBase);
  await importJson(
    `${denseText}${" ".repeat(8_000_001)}`,
    "oversized-stack-proposal.json",
  );
  await expect(page.locator(".message.error")).toContainText("8 MB");
  assert.deepEqual((await exportJson()).project, denseBase);
  // A legitimate pretty-printed input/result bundle can exceed 8 MB. Keep
  // the pre-existing 20 MiB ordinary import cap distinct from proposal limits.
  const largeRows = 2000;
  const largeTable = {
    ...structuredClone(base.layers[0].material),
    name: "Synthetic material",
    kind: "tabulated",
    n: 1,
    k: 0,
    wavelengths_nm: Array.from(
      { length: largeRows },
      (_, i) => 400 + (500 * i) / (largeRows - 1),
    ),
    n_values: Array.from(
      { length: largeRows },
      (_, i) => 1.25 + i * 0.00000123456789,
    ),
    k_values: Array.from(
      { length: largeRows },
      (_, i) => 0.001 + i * 0.000000023456789,
    ),
  };
  const genuine = structuredClone(base);
  genuine.schema_version = "1.1";
  genuine.name = `Large genuine stack ${stamp}`;
  genuine.layers = Array.from({ length: 8 }, (_, i) => ({
    ...structuredClone(base.layers[0]),
    name: `Large layer ${i + 1}`,
    thickness_nm: 100,
    material: structuredClone(largeTable),
    background: structuredClone(largeTable),
  }));
  genuine.ambient = {
    ...structuredClone(largeTable),
    name: "Air",
    n_values: Array(largeRows).fill(1),
    k_values: Array(largeRows).fill(0),
  };
  genuine.substrate = {
    ...structuredClone(largeTable),
    name: "Synthetic substrate",
    n_values: Array(largeRows).fill(1.5),
    k_values: Array(largeRows).fill(0),
  };
  genuine.illumination.wavelengths_nm = Array.from(
    { length: 81 },
    (_, i) => 450 + 5 * i,
  );
  genuine.solver.harmonics = 20;
  assert.ok(
    Buffer.byteLength(JSON.stringify({ kind: "forward", project: genuine })) <
      2_000_000,
  );
  const genuineSnapshot = await solve(genuine);
  await page.reload();
  await expect(page.locator(".connection")).toHaveText("Solver connected");
  await load(genuineSnapshot);
  const genuineExport = await exportJson();
  const genuinePath = `${output}/multilayer-export-${exports}.json`,
    genuineBytes = (await fs.stat(genuinePath)).size;
  assert.ok(
    genuineBytes > 8_000_000 && genuineBytes < 20 * 1024 * 1024,
    `Unexpected genuine export size ${genuineBytes}`,
  );
  await page
    .locator(".file-actions input[type=file]")
    .setInputFiles(genuinePath);
  await expect(page.locator(".result-badge")).toHaveText("Unverified import");
  assert.deepEqual(await exportJson(), genuineExport);
  evidence.genuineExportBytes = genuineBytes;
  checks.push(
    "A real maximal-grid eight-layer result exports and reimports a >8 MB ordinary bundle exactly under the preserved20MiB cap without promoting provenance",
  );
  evidence.largeProposalBytes = Buffer.byteLength(denseText);
  checks.push(
    "A real >2 MB dense-table stack proposal imports, reviews compactly and applies exactly; >8 MB is rejected without mutation",
  );
  await browser.close();
  browser = undefined;
  const staticCalls = await launch({ width: 390, height: 844 }, staticUrl);
  const reference = await exportJson();
  await importJson({
    project: saved.project,
    result: saved.result,
    result_project: saved.project,
  });
  await expect(page.locator(".result-badge")).toHaveText("Unverified import");
  await addLayer("Add uniform layer");
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  await history("undo");
  assert.deepEqual((await exportJson()).project, saved.project);
  await history("undo");
  assert.deepEqual(await exportJson(), reference);
  assert.deepEqual(staticCalls, []);
  await noOverflow();
  checks.push(
    "Static preview edits/imports stacks locally, never promotes provenance, restores the precomputed reference and makes zero API requests",
  );
  assert.deepEqual(pageErrors, [], "No uncaught browser errors");
  const report = {
    status: "passed",
    checks,
    pageErrors,
    evidence,
    date: new Date().toISOString(),
  };
  await fs.writeFile(
    `${output}/multilayer-browser-qa.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page
    ?.screenshot({
      path: `${output}/multilayer-browser-failure.png`,
      fullPage: false,
      timeout: 10000,
    })
    .catch(() => {});
  const report = {
    status: "failed",
    checks,
    pageErrors,
    evidence,
    error: error.stack || String(error),
    date: new Date().toISOString(),
  };
  await fs.writeFile(
    `${output}/multilayer-browser-qa.json`,
    JSON.stringify(report, null, 2),
  );
  console.error(JSON.stringify(report, null, 2));
  throw error;
} finally {
  for (const id of activeJobs)
    await request(`/jobs/${id}`, undefined, "DELETE").catch(() => {});
  await browser?.close();
}
