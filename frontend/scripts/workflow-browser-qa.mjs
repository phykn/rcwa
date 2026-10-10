// Run after the other browser QA scripts with the real local API (:8000),
// live Vite (:5173), and VITE_STATIC_PREVIEW=true preview (:4173) running.
// CHROMIUM_PATH=/usr/bin/chromium node scripts/workflow-browser-qa.mjs
// Successful numerical cases always use real, bounded server jobs. Route
// interception is confined to delayed delivery and explicitly negative cases.
/* global document, window, requestAnimationFrame, innerWidth */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, errors, expect as baseExpect } from "@playwright/test";
const expect = baseExpect.configure({ timeout: 10000 });
const displayExpect = baseExpect.configure({ timeout: 2000 });

const apiUrl = process.env.RCWA_API_URL || "http://127.0.0.1:8000";
const appUrl = process.env.RCWA_APP_URL || "http://127.0.0.1:5173";
const previewUrl = process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173";
const output = new URL("../../artifacts/", import.meta.url).pathname;
const prefix = `Workflow QA ${Date.now()}`;
const checks = [];
const pageErrors = [];
const collectedFailures = [];
let collectedFailureWaitMs = 0;
const snapshots = [];
const activeJobs = new Set();
const pendingGates = new Set();
const evidence = {
  realJobs: [],
  snapshots: [],
  screenshots: [],
  screenshotCaptures: [],
  pages: [],
  negativeCases: [],
};
let browser;
let page;
let exportNumber = 0;
await fs.mkdir(output, { recursive: true });

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function awaitStarted(signal, label) {
  let timer;
  try {
    await Promise.race([
      signal.promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          30000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function gate() {
  const value = deferred();
  pendingGates.add(value);
  return value;
}
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
function pathIs(requestOrResponse, path, method) {
  const request =
    typeof requestOrResponse.request === "function"
      ? requestOrResponse.request()
      : requestOrResponse;
  return (
    new URL(request.url()).pathname === `/api${path}` &&
    (!method || request.method() === method)
  );
}
function observe(target) {
  const calls = [];
  const record = {
    id: `page-${evidence.pages.length + 1}`,
    viewport: target.viewportSize(),
    events: [],
    droppedEvents: 0,
    closed: false,
    crashed: false,
  };
  evidence.pages.push(record);
  const requestIds = new WeakMap();
  let requestNumber = 0;
  function event(type, details = {}) {
    if (record.events.length === 100) {
      record.events.shift();
      record.droppedEvents += 1;
    }
    record.events.push({
      time: new Date().toISOString(),
      type,
      url: target.url(),
      ...details,
    });
  }
  function apiRequest(request) {
    return new URL(request.url()).pathname.startsWith("/api/");
  }
  target.on("pageerror", (error) => {
    pageErrors.push(error.message);
    event("pageerror", { message: error.message.slice(0, 2000) });
  });
  target.on("request", (request) => {
    if (apiRequest(request)) {
      const id = ++requestNumber;
      requestIds.set(request, id);
      calls.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        body: request.postData(),
      });
      event("api-request", {
        id,
        method: request.method(),
        path: new URL(request.url()).pathname,
      });
    }
  });
  target.on("response", (response) => {
    const request = response.request();
    if (apiRequest(request))
      event("api-response", {
        id: requestIds.get(request),
        method: request.method(),
        path: new URL(request.url()).pathname,
        status: response.status(),
      });
  });
  target.on("requestfailed", (request) => {
    if (apiRequest(request))
      event("api-request-failed", {
        id: requestIds.get(request),
        method: request.method(),
        path: new URL(request.url()).pathname,
        error: request.failure()?.errorText,
      });
  });
  target.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      event(`console-${message.type()}`, {
        message: message.text().slice(0, 2000),
        location: message.location(),
      });
  });
  target.on("crash", () => {
    record.crashed = true;
    event("crash");
  });
  target.on("close", () => {
    record.closed = true;
    event("close");
  });
  event("created");
  return calls;
}
async function newPage(url = appUrl, viewport = { width: 1440, height: 1100 }) {
  const target = await browser.newPage({ viewport });
  page = target;
  const calls = observe(target);
  await target.goto(url);
  await expect(target.locator(".connection")).toHaveText(
    url === previewUrl ? "Static preview" : "Solver connected",
  );
  return { target, calls };
}
async function settle(target) {
  await target.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function menu(target) {
  const container = target.locator(".project-menu");
  if (!(await container.evaluate((node) => node.open)))
    await container.locator("summary").click();
}
async function history(target, direction) {
  await menu(target);
  const button = target.getByRole("button", {
    name: direction === "undo" ? /↶\s*Undo/ : /↷\s*Redo/,
  });
  await expect(button).toBeEnabled();
  await button.click();
  await settle(target);
}
async function importJson(target, data, filename = "workflow-import.json") {
  await target.locator(".file-actions input[type=file]").setInputFiles({
    name: filename,
    mimeType: "application/json",
    buffer: Buffer.from(typeof data === "string" ? data : JSON.stringify(data)),
  });
}
async function exportJson(target) {
  await menu(target);
  const pending = target.waitForEvent("download");
  await target.getByRole("button", { name: "Export", exact: true }).click();
  const download = await pending;
  const filename = `${output}/workflow-export-${++exportNumber}.json`;
  await download.saveAs(filename);
  const data = JSON.parse(await fs.readFile(filename, "utf8"));
  assert.equal(data.format, "lattice-project/1.0");
  assert.ok(
    Object.hasOwn(data, "project") &&
      Object.hasOwn(data, "result") &&
      Object.hasOwn(data, "result_project"),
  );
  assert.equal(
    data.provenance,
    undefined,
    "A portable JSON export cannot assert server provenance",
  );
  return {
    project: data.project,
    result: data.result,
    result_project: data.result_project,
  };
}
async function widthSession(target, values) {
  await target
    .locator(".dimension-rail")
    .getByRole("button", { name: /width/ })
    .click();
  const input = target.locator("#dimension-width");
  await expect(input).toBeFocused();
  for (const value of values) await input.fill(String(value));
  await target
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
}
async function screenshot(target, name) {
  const filename = `workflow-${name}.png`;
  const capture = { filename, attempts: [], recovered: false };
  const captureStarted = Date.now();
  evidence.screenshotCaptures.push(capture);
  // A previous timeout was immediately followed by a successful identical
  // catch capture. Retry only that transient error, with no page mutation or
  // extra frame wait: both attempts together stay below the former 30 seconds.
  // Native dialogs are viewport surfaces. Mobile chart evidence is captured
  // separately after scrolling the dialog, without offscreen page capture.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await target.screenshot({
        path: `${output}/${filename}`,
        fullPage: false,
        timeout: 10000,
      });
      capture.attempts.push({ attempt, status: "passed" });
      capture.recovered = attempt > 1;
      evidence.screenshots.push(filename);
      return;
    } catch (error) {
      const timedOut = error instanceof errors.TimeoutError;
      capture.attempts.push({
        attempt,
        status: "failed",
        timedOut,
        error: error.stack || String(error),
      });
      if (!timedOut) throw error;
      if (attempt === 2) {
        collectedFailureWaitMs += Date.now() - captureStarted;
        await collectReadOnly(`screenshot: ${filename}`, async () => {
          throw new Error(
            "Screenshot timed out on both bounded capture attempts.",
            { cause: error },
          );
        });
      }
    }
  }
}
async function openSaved(target) {
  await menu(target);
  await target.getByRole("button", { name: "Open", exact: true }).click();
  const dialog = target.getByRole("dialog", {
    name: "Saved projects",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function loadSnapshot(target, snapshot) {
  const dialog = await openSaved(target);
  await dialog
    .locator(".saved-item")
    .filter({ hasText: snapshot.name })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(target.getByLabel("Project name")).toHaveValue(
    snapshot.project.name,
  );
  await expect(target.locator(".result-badge")).toHaveText("Server-computed");
}
async function compare(target, candidates) {
  const saved = await openSaved(target);
  for (const candidate of candidates)
    await saved
      .getByRole("checkbox", { name: `Compare ${candidate.name}`, exact: true })
      .check();
  await saved
    .getByRole("button", {
      name: `Compare (${candidates.length})`,
      exact: true,
    })
    .click();
  const comparison = target.getByRole("dialog", {
    name: "Compare candidates",
    exact: true,
  });
  await expect(comparison).toBeVisible();
  assert.equal(await comparison.evaluate((node) => node.tagName), "DIALOG");
  await expect(comparison.locator(".candidate-card")).toHaveCount(
    candidates.length,
  );
  for (let i = 0; i < candidates.length; i += 1) {
    const card = comparison.locator(".candidate-card").nth(i);
    await expect(card).toContainText(candidates[i].name);
    await expect(card).toContainText("Server-computed");
    await card.getByText("Run details", { exact: true }).click();
    await expect(card).toContainText(`Snapshot ${candidates[i].id}`);
    assert.deepEqual(
      JSON.parse(await card.locator("pre").textContent()),
      candidates[i].project,
    );
    await card.getByText("Run details", { exact: true }).click();
  }
  return comparison;
}
// Only independent, read-only presentation assertions are collected. Core
// state, response identity and action preconditions remain fail-fast. Bound
// failures and their retry time so a broken display cannot exhaust CI silently.
async function collectReadOnly(label, assertion) {
  const began = Date.now();
  try {
    await assertion();
    return true;
  } catch (error) {
    collectedFailureWaitMs += Date.now() - began;
    collectedFailures.push({ label, error: error.stack || String(error) });
    console.error(`Collected read-only assertion failure: ${label}\n${error}`);
    if (collectedFailures.length >= 40 || collectedFailureWaitMs >= 60000)
      throw new Error(
        "Read-only assertion collection reached its bounded failure budget.",
        { cause: error },
      );
    return false;
  }
}
async function presentationContext(target, dialog, kind) {
  const viewport = target.viewportSize();
  const title = dialog ? await dialog.getAttribute("aria-label") : "page";
  return `${kind}: ${title || "dialog"}, ${viewport?.width}x${viewport?.height}`;
}
async function assertNoOverflow(target, dialog) {
  const context = await presentationContext(target, dialog, "overflow");
  await collectReadOnly(`${context}: page width`, async () => {
    assert.equal(
      await target.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "Page has no horizontal overflow",
    );
  });
  if (dialog) {
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    const viewport = target.viewportSize();
    await collectReadOnly(`${context}: dialog bounds`, async () => {
      assert.ok(
        box && box.x >= -1 && box.x + box.width <= viewport.width + 1,
        "Dialog fits the viewport",
      );
    });
    await collectReadOnly(`${context}: dialog content width`, async () => {
      assert.equal(
        await dialog.evaluate(
          (node) => node.scrollWidth > node.clientWidth + 1,
        ),
        false,
        "Dialog has no horizontal overflow",
      );
    });
  }
}
async function assertFocusInside(target, dialog, count = 12) {
  await expect(dialog).toBeVisible();
  const context = await presentationContext(target, dialog, "focus");
  async function restoreFocus() {
    // Restoration is a hard precondition before any later keyboard actions.
    await dialog.getByRole("button").first().focus();
    assert.equal(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
      true,
      "Focus must be restored inside the current dialog before continuing",
    );
  }
  if (
    !(await collectReadOnly(`${context}: initial focus`, async () => {
      assert.equal(
        await dialog.evaluate((node) => node.contains(document.activeElement)),
        true,
        "Modal receives focus",
      );
    }))
  )
    await restoreFocus();
  for (const key of ["Tab", "Shift+Tab"]) {
    // Starting at the first control makes the reverse boundary deterministic.
    if (key === "Shift+Tab") await restoreFocus();
    for (let i = 0; i < count; i += 1) {
      await target.keyboard.press(key);
      const contained = await collectReadOnly(
        `${context}: ${key} ${i + 1}/${count}`,
        async () => {
          assert.equal(
            await dialog.evaluate((node) =>
              node.contains(document.activeElement),
            ),
            true,
            `${key} stays within the modal`,
          );
        },
      );
      if (!contained) await restoreFocus();
    }
  }
}
function exactPair(snapshot) {
  return {
    project: snapshot.project,
    result: snapshot.result,
    result_project: snapshot.project,
  };
}
async function boundedProject(
  example,
  suffix,
  {
    width = 180,
    waves = [511, 623, 739],
    polarization = "both",
    angle = 0,
  } = {},
) {
  const input = structuredClone(example);
  input.name = `${prefix} ${suffix}`;
  input.layers[0].cd_nm = width;
  input.illumination = {
    ...input.illumination,
    wavelengths_nm: waves,
    polarization,
    angle_deg: angle,
  };
  input.solver.harmonics = 3;
  const validated = await request("/validate", input);
  assert.equal(validated.valid, true, JSON.stringify(validated.diagnostics));
  return validated.project;
}
async function completedJob(input) {
  let job = await request("/jobs", { kind: "forward", project: input });
  activeJobs.add(job.id);
  const id = job.id;
  const deadline = Date.now() + 90000;
  while (["running", "queued"].includes(job.status)) {
    assert.ok(Date.now() < deadline, `Real job ${id} exceeded 90 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    job = await request(`/jobs/${encodeURIComponent(id)}`);
    assert.equal(job.id, id);
  }
  assert.equal(job.status, "succeeded", JSON.stringify(job));
  assert.equal(job.kind, "forward");
  assert.deepEqual(
    job.result.wavelengths_nm,
    input.illumination.wavelengths_nm,
  );
  activeJobs.delete(id);
  evidence.realJobs.push({
    id,
    project: input.name,
    wavelengths: input.illumination.wavelengths_nm,
    harmonics: input.solver.harmonics,
  });
  return job;
}
async function createSnapshot(input) {
  const job = await completedJob(input);
  const saved = await request("/snapshots", { job_id: job.id });
  assert.equal(saved.provenance.source, "server_computed");
  assert.equal(saved.provenance.job_id, job.id);
  assert.equal(saved.provenance.input_hash, job.input_hash);
  assert.deepEqual(saved.project, input);
  assert.deepEqual(saved.result, job.result);
  snapshots.push(saved);
  evidence.snapshots.push({ id: saved.id, name: saved.name, jobId: job.id });
  return saved;
}
async function assertComparisonValues(
  dialog,
  candidates,
  quantity,
  polarization,
  sample,
) {
  await dialog
    .getByLabel("Comparison quantity", { exact: true })
    .selectOption(quantity);
  await dialog
    .getByLabel("Comparison polarization", { exact: true })
    .selectOption(polarization);
  const range = dialog.getByLabel("Compare exact wavelength sample", {
    exact: true,
  });
  await range.focus();
  await range.press("Home");
  for (let i = 0; i < sample; i += 1) await range.press("ArrowRight");
  const context = `${await presentationContext(dialog.page(), dialog, "comparison")}: ${quantity}, ${polarization}, sample ${sample}`;
  await collectReadOnly(`${context}: exact wavelength label`, async () => {
    await displayExpect(dialog.locator(".comparison-sample strong")).toHaveText(
      `${candidates[0].result.wavelengths_nm[sample]} nm`,
    );
  });
  const names = {
    R: "Total reflectance",
    T: "Total transmittance",
    R_specular: "Specular reflectance",
    T_specular: "Specular transmittance",
  };
  await collectReadOnly(
    `${context}: quantity/polarization chart label`,
    async () => {
      await displayExpect(
        dialog.locator(".comparison-plot svg"),
      ).toHaveAttribute(
        "aria-label",
        `${names[quantity]}, ${polarization} polarization, for ${candidates.length} saved candidates. Exact samples are listed below.`,
      );
    },
  );
  const rows = dialog.locator(".comparison-values > p");
  await expect(rows).toHaveCount(candidates.length);
  for (let i = 0; i < candidates.length; i += 1) {
    await expect(rows.nth(i)).toContainText(candidates[i].name);
    await collectReadOnly(
      `${context}: ${candidates[i].id} exact stored value`,
      async () => {
        await displayExpect(rows.nth(i).locator("strong")).toHaveText(
          `${(candidates[i].result.spectra[polarization][quantity][sample] * 100).toFixed(3)}%`,
        );
      },
    );
  }
}
async function dismissError(target) {
  const dismiss = target.getByRole("button", {
    name: "Dismiss error",
    exact: true,
  });
  if (await dismiss.isVisible()) await dismiss.click();
}
async function localProposal(target, proposal) {
  const focus = target.locator(".project-menu > summary");
  await focus.focus();
  await importJson(target, proposal, "workflow-proposal.json");
  const review = target.getByRole("dialog", {
    name: "Review geometry changes",
    exact: true,
  });
  await expect(review).toBeVisible();
  assert.equal(await review.evaluate((node) => node.tagName), "DIALOG");
  return { review, focus };
}

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: [
      "--no-sandbox",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  const live = await newPage();
  page = live.target;
  const calls = live.calls;
  const example = await request("/example");
  const inputA = await boundedProject(example, "candidate A", { width: 181 });
  await importJson(page, inputA);
  await expect(page.getByLabel("Project name")).toHaveValue(inputA.name);

  // Real browser-submitted calculation. Delay only the real snapshot response
  // to assert same-turn duplicate Save gating, then accept the unchanged body.
  const startedResponse = page.waitForResponse((response) =>
    pathIs(response, "/jobs", "POST"),
  );
  await page.getByRole("button", { name: /Run simulation/ }).click();
  const started = await (await startedResponse).json();
  activeJobs.add(started.id);
  await expect(page.locator(".result-badge")).toHaveText("Computed", {
    timeout: 90000,
  });
  const realAJob = await request(`/jobs/${encodeURIComponent(started.id)}`);
  assert.equal(realAJob.status, "succeeded");
  assert.equal(realAJob.kind, "forward");
  assert.deepEqual((await exportJson(page)).project, inputA);
  assert.deepEqual((await exportJson(page)).result, realAJob.result);
  activeJobs.delete(started.id);
  evidence.realJobs.push({
    id: started.id,
    project: inputA.name,
    wavelengths: inputA.illumination.wavelengths_nm,
    harmonics: 3,
  });
  const saveGate = gate(),
    saveStarted = deferred();
  let savePosts = 0;
  let savedA;
  await page.route("**/api/snapshots", async (route) => {
    savePosts += 1;
    assert.deepEqual(route.request().postDataJSON(), { job_id: started.id });
    const response = await route.fetch();
    savedA = await response.json();
    assert.equal(response.status(), 201);
    saveStarted.resolve();
    await saveGate.promise;
    await route.fulfill({ response, json: savedA });
  });
  const savesBefore = calls.length;
  await menu(page);
  await page.getByLabel("Save project to local server").evaluate((button) => {
    button.click();
    button.click();
  });
  await awaitStarted(saveStarted, "saveStarted");
  assert.equal(savePosts, 1, "Repeated Save produces one snapshot request");
  const savedResponse = page.waitForResponse((response) =>
    pathIs(response, "/snapshots", "POST"),
  );
  saveGate.resolve();
  await savedResponse;
  await expect(page.locator(".result-badge")).toHaveText("Server-computed");
  await expect(page.locator(".message.success")).toContainText("saved");
  assert.equal(savedA.provenance.job_id, started.id);
  assert.equal(savedA.provenance.input_hash, realAJob.input_hash);
  assert.deepEqual(savedA.project, inputA);
  assert.deepEqual(savedA.result, realAJob.result);
  assert.equal(
    calls
      .slice(savesBefore)
      .filter((call) => call.method === "POST" && call.path === "/api/projects")
      .length,
    0,
  );
  snapshots.push(savedA);
  evidence.snapshots.push({
    id: savedA.id,
    name: savedA.name,
    jobId: started.id,
  });
  await page.unroute("**/api/snapshots");
  const alreadySavedCalls = calls.length;
  await menu(page);
  await page.getByLabel("Save project to local server").click();
  await expect(page.locator(".message.success")).toContainText("already saved");
  assert.equal(
    calls.length,
    alreadySavedCalls,
    "Saving an existing server snapshot preserves its durable identity",
  );
  assert.deepEqual(await exportJson(page), exactPair(savedA));
  checks.push(
    "Real UI forward run is saved by exact job ID and hash through /snapshots, repeated Save is gated, and an already saved run preserves its identity without a compatibility POST",
  );

  const savedB = await createSnapshot(
    await boundedProject(example, "candidate B", { width: 195, angle: 7 }),
  );
  const savedC = await createSnapshot(
    await boundedProject(example, "candidate C", { width: 207 }),
  );
  const singleA = await createSnapshot(
    await boundedProject(example, "single sample A", {
      width: 185,
      waves: [623],
      polarization: "s",
    }),
  );
  const singleB = await createSnapshot(
    await boundedProject(example, "single sample B", {
      width: 199,
      waves: [623],
      polarization: "s",
    }),
  );
  const baseline = await exportJson(page);
  const baselineOrigin = await page.locator(".result-badge").textContent();

  // Each focus session, pointer gesture, and held-key sequence is one edit.
  const localCalls = calls.length;
  await widthSession(page, [182, 184, 189]);
  const fieldEdit = await exportJson(page);
  assert.equal(fieldEdit.project.layers[0].cd_nm, 189);
  await history(page, "undo");
  assert.deepEqual(
    await exportJson(page),
    baseline,
    "One Undo restores all values in one field-edit session",
  );
  await expect(page.locator(".result-badge")).toHaveText(baselineOrigin);
  await history(page, "redo");
  assert.deepEqual(await exportJson(page), fieldEdit);
  await history(page, "undo");
  await widthSession(page, [188]);
  await menu(page);
  await expect(page.getByRole("button", { name: /↷\s*Redo/ })).toBeDisabled();
  await history(page, "undo");
  assert.deepEqual(await exportJson(page), baseline);
  await expect(page.locator(".three-canvas")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect(page.locator(".three-canvas")).toHaveAttribute(
    "data-fallback",
    "false",
  );
  const handle = page.getByRole("slider", { name: "Drag width", exact: true });
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  assert.ok(box, "Width handle is rendered");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  const dragged = await exportJson(page);
  assert.notEqual(
    dragged.project.layers[0].cd_nm,
    baseline.project.layers[0].cd_nm,
  );
  await history(page, "undo");
  assert.deepEqual(
    await exportJson(page),
    baseline,
    "One Undo restores an entire multi-move pointer drag",
  );
  await history(page, "redo");
  assert.deepEqual(await exportJson(page), dragged);
  await history(page, "undo");
  await handle.focus();
  for (let i = 0; i < 4; i += 1) await page.keyboard.down("ArrowRight");
  await page.keyboard.up("ArrowRight");
  await expect(handle).toHaveAttribute(
    "aria-valuenow",
    String(baseline.project.layers[0].cd_nm + 4),
  );
  const keyed = await exportJson(page);
  await history(page, "undo");
  assert.deepEqual(
    await exportJson(page),
    baseline,
    "One Undo restores an entire held-key sequence",
  );
  await history(page, "redo");
  assert.deepEqual(await exportJson(page), keyed);
  await history(page, "undo");
  await widthSession(page, [186]);
  await page.locator(".project-menu > summary").focus();
  await page.keyboard.press("Control+z");
  assert.deepEqual(await exportJson(page), baseline);
  await page.locator(".project-menu > summary").focus();
  await page.keyboard.press("Control+Shift+z");
  assert.equal((await exportJson(page)).project.layers[0].cd_nm, 186);
  await history(page, "undo");
  assert.deepEqual(await exportJson(page), baseline);
  const nameField = page.getByLabel("Project name");
  await nameField.focus();
  await nameField.press("End");
  // One native insertion creates one native undo unit. Per-key word entry may
  // legitimately split whitespace into a separate Chromium undo unit.
  await page.keyboard.insertText(" native undo");
  await expect(nameField).toHaveValue(`${baseline.project.name} native undo`);
  await nameField.press("Control+z");
  await expect(nameField).toHaveValue(baseline.project.name);
  await page.locator(".project-menu > summary").focus();
  assert.deepEqual(
    await exportJson(page),
    baseline,
    "Native text Undo stays in the focused input instead of restoring an older workspace",
  );
  // Two range gestures intentionally retain focus in the same sheet.
  await page
    .locator(".dimension-rail")
    .getByRole("button", { name: /width/ })
    .click();
  const range = page.getByRole("slider", { name: "width range", exact: true });
  const rangeBox = await range.boundingBox();
  assert.ok(rangeBox);
  const minimum = Number(await range.getAttribute("min"));
  const maximum = Number(await range.getAttribute("max"));
  async function dragRange(delta) {
    const current = Number(await range.inputValue());
    const x =
      rangeBox.x +
      8 +
      ((current - minimum) / (maximum - minimum)) * (rangeBox.width - 16);
    const y = rangeBox.y + rangeBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 8 });
    await page.mouse.up();
    await expect(range).toBeFocused();
    return Number(await range.inputValue());
  }
  const rangeFirst = await dragRange(18);
  const rangeSecond = await dragRange(18);
  assert.ok(
    rangeSecond > rangeFirst && rangeFirst > baseline.project.layers[0].cd_nm,
  );
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await history(page, "undo");
  assert.equal(
    (await exportJson(page)).project.layers[0].cd_nm,
    rangeFirst,
    "Undo only the second range gesture, although focus never left the range",
  );
  await history(page, "undo");
  assert.deepEqual(await exportJson(page), baseline);
  await history(page, "redo");
  assert.equal((await exportJson(page)).project.layers[0].cd_nm, rangeFirst);
  await history(page, "redo");
  assert.equal((await exportJson(page)).project.layers[0].cd_nm, rangeSecond);
  await history(page, "undo");
  await history(page, "undo");
  assert.deepEqual(await exportJson(page), baseline);
  checks.push(
    "Two separate range drags in one open sheet, with no intervening blur, create two distinct Undo/Redo steps",
  );
  assert.equal(
    calls.length,
    localCalls,
    "Local history and direct geometry edits make no API calls",
  );
  checks.push(
    "Field focus sessions, multi-move handle drags and held arrow keys each Undo/Redo in one step; new edits clear Redo, shortcuts work outside text controls, and exact inputs/result/origin are restored without API traffic",
  );

  const proposal = await request("/change-preview", {
    base_project: baseline.project,
    changes: { period_nm: 410, cd_nm: 194, thickness_nm: 170 },
  });
  assert.equal(proposal.schema_version, "rcwa-change-proposal/1.0");
  assert.equal(proposal.valid, true);
  const proposalCalls = calls.length;
  let { review, focus } = await localProposal(page, proposal);
  await expect(review.locator(".change-list")).toContainText("Width");
  await expect(review.locator(".change-list")).toContainText("Height");
  await expect(review.locator(".change-list")).toContainText("Pitch");
  await expect(review).toContainText("No new spectrum has been calculated");
  await expect(page.locator(".width-handle")).toHaveAttribute(
    "aria-valuenow",
    String(baseline.project.layers[0].cd_nm),
  );
  await expect(page.locator(".result-badge")).toHaveText(baselineOrigin);
  await review.getByText("Full inputs", { exact: true }).click();
  assert.deepEqual(
    JSON.parse(await review.locator("pre").nth(1).textContent()),
    proposal.candidate_project,
  );
  await review.getByText("Full inputs", { exact: true }).click();
  await assertFocusInside(page, review);
  await screenshot(page, "proposal-review-desktop");
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(review).not.toBeVisible();
  await expect(focus).toBeFocused();
  assert.deepEqual(
    await exportJson(page),
    baseline,
    "Cancel leaves the complete workspace unchanged",
  );
  ({ review, focus } = await localProposal(page, proposal));
  await page.keyboard.press("Escape");
  await expect(review).not.toBeVisible();
  await expect(focus).toBeFocused();
  assert.deepEqual(await exportJson(page), baseline);
  ({ review, focus } = await localProposal(page, proposal));
  const desktopReviewBox = await review.boundingBox();
  assert.ok(
    desktopReviewBox && desktopReviewBox.x > 1 && desktopReviewBox.y > 1,
  );
  await page.mouse.click(1, 1);
  await expect(review).not.toBeVisible();
  await expect(focus).toBeFocused();
  assert.deepEqual(
    await exportJson(page),
    baseline,
    "Backdrop dismissal leaves the workspace unchanged",
  );
  ({ review } = await localProposal(page, proposal));
  await review
    .getByRole("button", { name: "Apply changes", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect(review).not.toBeVisible();
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  const applied = await exportJson(page);
  assert.deepEqual(applied.project, proposal.candidate_project);
  assert.deepEqual(applied.result_project, baseline.result_project);
  assert.deepEqual(applied.result, baseline.result);
  await history(page, "undo");
  assert.deepEqual(
    await exportJson(page),
    baseline,
    "Repeated Apply installs one history step and preserves the prior exact run pair",
  );
  await expect(page.locator(".result-badge")).toHaveText(baselineOrigin);
  await history(page, "redo");
  assert.deepEqual(await exportJson(page), applied);
  await history(page, "undo");
  assert.equal(
    calls.length,
    proposalCalls,
    "Proposal import, review, cancellation, apply and history never invoke API computation or saving",
  );
  checks.push(
    "Actual /change-preview output opens review without mutation, shows complete geometry changes, restores focus on Cancel/Escape, applies once without compute, marks old output stale, and Undo restores the exact server-origin pair",
  );

  // Proposal envelopes are untrusted. Change only explicit negative fixtures.
  for (const [label, mutate, error] of [
    [
      "unknown-envelope-key",
      (data) => {
        data.result = baseline.result;
      },
      /unknown field result/,
    ],
    [
      "numeric-string",
      (data) => {
        data.changes.cd_nm = "194";
      },
      /finite number/,
    ],
    [
      "boolean-number",
      (data) => {
        data.changes.cd_nm = true;
      },
      /finite number/,
    ],
    [
      "outside-patch",
      (data) => {
        data.candidate_project.layers[0].material.n += 0.1;
      },
      /outside.*geometry patch/,
    ],
  ]) {
    const invalid = structuredClone(proposal);
    mutate(invalid);
    await importJson(page, invalid, `workflow-invalid-${label}.json`);
    await expect(page.locator(".message.error")).toContainText(error);
    await expect(
      page.getByRole("dialog", { name: "Review geometry changes" }),
    ).toHaveCount(0);
    assert.deepEqual(await exportJson(page), baseline);
    await dismissError(page);
    evidence.negativeCases.push(`proposal:${label}`);
  }
  await importJson(
    page,
    `${JSON.stringify(proposal)}${" ".repeat(2_000_001)}`,
    "workflow-oversized-proposal.json",
  );
  await expect(page.locator(".message.error")).toContainText("2 MB");
  assert.deepEqual(await exportJson(page), baseline);
  await dismissError(page);
  await widthSession(page, [187]);
  const mismatchedBase = await exportJson(page);
  ({ review } = await localProposal(page, proposal));
  await expect(review.getByRole("alert")).toContainText("different inputs");
  await expect(
    review.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeDisabled();
  await assertFocusInside(page, review);
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(await exportJson(page), mismatchedBase);
  await history(page, "undo");
  assert.deepEqual(await exportJson(page), baseline);
  const noOp = await request("/change-preview", {
    base_project: baseline.project,
    changes: { cd_nm: baseline.project.layers[0].cd_nm },
  });
  ({ review } = await localProposal(page, noOp));
  await expect(review.getByRole("alert")).toContainText("no changes");
  await expect(
    review.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  checks.push(
    "Strict proposal imports reject result/provenance-like extras, numeric strings, booleans, off-patch material changes and >2 MB files; mismatched bases and no-op proposals cannot apply",
  );

  const warningBase = await boundedProject(example, "near-cutoff warning", {
    waves: [650],
  });
  const warningProposal = await request("/change-preview", {
    base_project: warningBase,
    changes: { period_nm: 650.01 },
  });
  assert.equal(warningProposal.valid, true);
  assert.ok(
    warningProposal.diagnostics.some(
      (item) =>
        item.code === "near_rayleigh_cutoff" && item.severity === "warning",
    ),
  );
  await importJson(page, warningBase);
  await expect(page.getByLabel("Project name")).toHaveValue(warningBase.name);
  ({ review } = await localProposal(page, warningProposal));
  await expect(
    review.getByRole("note", { name: "Proposal warnings", exact: true }),
  ).toContainText("Input warnings");
  await expect(
    review.getByRole("note", { name: "Proposal warnings", exact: true }),
  ).toContainText(/near a Rayleigh cutoff/);
  await expect(
    review.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeEnabled();
  await screenshot(page, "proposal-input-warnings");
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await history(page, "undo");
  assert.deepEqual(await exportJson(page), baseline);
  checks.push(
    "A real valid 650 nm / 650.01 nm near-cutoff preview visibly exposes Input warnings before the enabled Apply action",
  );

  // Delay actual File.text() completion, edit then undo to equal inputs, and
  // verify revision ownership prevents a late proposal from opening anyway.
  await page.evaluate(() => {
    const original = File.prototype.text;
    window.__workflowFileStarted = false;
    window.__workflowFileFinished = false;
    const waiting = new Promise((resolve) => {
      window.__workflowReleaseFile = resolve;
    });
    File.prototype.text = async function () {
      if (this.name === "workflow-delayed-proposal.json") {
        window.__workflowFileStarted = true;
        await waiting;
      }
      const text = await original.call(this);
      if (this.name === "workflow-delayed-proposal.json")
        window.__workflowFileFinished = true;
      return text;
    };
    window.__workflowRestoreFile = () => {
      File.prototype.text = original;
    };
  });
  await importJson(page, proposal, "workflow-delayed-proposal.json");
  await page.waitForFunction(() => window.__workflowFileStarted);
  await widthSession(page, [183]);
  await history(page, "undo");
  assert.deepEqual(await exportJson(page), baseline);
  await page.evaluate(() => {
    window.__workflowReleaseFile();
    window.__workflowRestoreFile();
  });
  await page.waitForFunction(() => window.__workflowFileFinished);
  await settle(page);
  await expect(
    page.getByRole("dialog", { name: "Review geometry changes" }),
  ).toHaveCount(0);
  assert.deepEqual(await exportJson(page), baseline);
  checks.push(
    "Delayed proposal-file parsing cannot supersede an intervening edit, even after Undo returns to numerically equal inputs",
  );

  let comparison = await compare(page, [savedA, savedB]);
  await assertComparisonValues(comparison, [savedA, savedB], "R", "s", 0);
  await assertComparisonValues(comparison, [savedA, savedB], "T", "p", 1);
  await expect(comparison.locator(".comparison-warning")).toContainText(
    "Incidence angle",
  );
  await assertFocusInside(page, comparison);
  await page.keyboard.press("Escape");
  assert.deepEqual(
    await exportJson(page),
    baseline,
    "Inspecting candidates does not replace the editor",
  );
  comparison = await compare(page, [savedA, savedB, savedC]);
  for (const quantity of ["R", "T", "R_specular", "T_specular"])
    for (const polarization of ["s", "p"])
      await assertComparisonValues(
        comparison,
        [savedA, savedB, savedC],
        quantity,
        polarization,
        2,
      );
  await screenshot(page, "comparison-three-desktop");
  await page.keyboard.press("Escape");
  assert.deepEqual(await exportJson(page), baseline);
  comparison = await compare(page, [savedA, savedC]);
  await expect(comparison.locator(".candidate-card").nth(0)).toContainText(
    savedA.name,
  );
  await page.keyboard.press("Escape");
  checks.push(
    "Two and three distinct real server snapshots reopen by exact ID; all four quantities and both polarizations display the exact stored wavelength/value, conditions differences remain visible, and comparison never changes the editor",
  );

  // Candidate 1 must differ from current editor to make adoption observable.
  const candidateCalls = calls.length;
  comparison = await compare(page, [savedB, savedC]);
  await comparison
    .getByRole("button", { name: "Review candidate 1", exact: true })
    .click();
  review = page.getByRole("dialog", {
    name: "Review saved candidate",
    exact: true,
  });
  await expect(review).toBeVisible();
  await expect(page.getByLabel("Project name")).toHaveValue(savedA.name);
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(await exportJson(page), baseline);
  comparison = await compare(page, [savedB, savedC]);
  await comparison
    .getByRole("button", { name: "Review candidate 1", exact: true })
    .click();
  await expect(review).toBeVisible();
  await review
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(review).not.toBeVisible();
  await expect(page.locator(".result-badge")).toHaveText("Server-computed");
  assert.deepEqual(await exportJson(page), exactPair(savedB));
  await history(page, "undo");
  assert.deepEqual(await exportJson(page), baseline);
  await expect(page.locator(".result-badge")).toHaveText(baselineOrigin);
  await history(page, "redo");
  assert.deepEqual(await exportJson(page), exactPair(savedB));
  await history(page, "undo");
  assert.equal(
    calls.slice(candidateCalls).filter((call) => call.method !== "GET").length,
    0,
    "Review/adopt/undo uses only stored candidate reads",
  );
  checks.push(
    "Review candidate 1 is cancellable; Apply installs that candidate’s exact saved input/result/server-origin pair in one undoable edit and never runs physics",
  );

  comparison = await compare(page, [savedA, singleA]);
  await expect(comparison.getByRole("alert")).toContainText(
    "Wavelength grids differ",
  );
  await expect(comparison.getByRole("alert")).toContainText("no interpolation");
  await expect(comparison.locator(".comparison-plot svg")).toHaveCount(0);
  await expect(comparison.locator(".comparison-values")).toHaveCount(0);
  await page.keyboard.press("Escape");
  comparison = await compare(page, [singleA, singleB]);
  await assertComparisonValues(comparison, [singleA, singleB], "R", "s", 0);
  await expect(comparison.locator(".comparison-plot circle")).toHaveCount(2);
  const pointPaths = await comparison
    .locator(".comparison-plot path")
    .evaluateAll((paths) => paths.map((node) => node.getAttribute("d")));
  for (const path of pointPaths)
    assert.match(
      path,
      /^M[\d.e+-]+,[\d.e+-]+$/,
      "A one-wavelength spectrum is a single finite point, not an interpolated line",
    );
  await screenshot(page, "comparison-single-sample");
  await comparison
    .getByLabel("Comparison polarization", { exact: true })
    .selectOption("p");
  await expect(comparison.getByRole("alert")).toContainText(
    "no p-polarized spectrum",
  );
  await expect(comparison.locator(".comparison-plot svg")).toHaveCount(0);
  await expect(comparison.locator(".comparison-values")).toHaveCount(0);
  await page.keyboard.press("Escape");
  checks.push(
    "Actual different wavelength grids suppress overlay without interpolation, real single-sample results render points, and selecting an absent polarization gives an explicit message instead of invented values",
  );

  // Unavailable/invalid response bodies are deliberate negative fixtures;
  // no positive numerical result or server provenance is synthesized.
  const savedPath = `**/api/projects/${savedA.id}`;
  await page.route(savedPath, (route) =>
    route.fulfill({
      json: {
        ...savedA,
        result: null,
        provenance: { source: "unverified_import" },
      },
    }),
  );
  let savedDialog = await openSaved(page);
  for (const candidate of [savedA, savedB])
    await savedDialog
      .getByRole("checkbox", { name: `Compare ${candidate.name}`, exact: true })
      .check();
  await savedDialog
    .getByRole("button", { name: "Compare (2)", exact: true })
    .click();
  await expect(savedDialog.getByRole("alert")).toContainText(
    "no saved spectrum",
  );
  await expect(
    page.getByRole("dialog", { name: "Compare candidates" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.unroute(savedPath);
  await page.route(savedPath, (route) =>
    route.fulfill({
      status: 404,
      json: { detail: "Snapshot no longer exists" },
    }),
  );
  savedDialog = await openSaved(page);
  await savedDialog
    .locator(".saved-item")
    .filter({ hasText: savedA.name })
    .click();
  await expect(savedDialog.getByRole("alert")).toContainText(
    "Snapshot no longer exists",
  );
  await page.keyboard.press("Escape");
  await page.unroute(savedPath);
  await page.route(savedPath, (route) => route.fulfill({ json: savedB }));
  savedDialog = await openSaved(page);
  await savedDialog
    .locator(".saved-item")
    .filter({ hasText: savedA.name })
    .click();
  await expect(savedDialog.getByRole("alert")).toContainText(
    "different saved project",
  );
  await page.keyboard.press("Escape");
  await page.unroute(savedPath);
  for (const [label, modify, expected] of [
    [
      "alternate-result-inputs",
      (data) => {
        data.result_project = data.project;
      },
      /cannot supply alternate result inputs/,
    ],
    [
      "empty-snapshot-id",
      (data) => {
        data.id = "";
      },
      /different saved project/,
    ],
    [
      "wrong-type-snapshot-id",
      (data) => {
        data.id = 123;
      },
      /different saved project/,
    ],
    [
      "wrong-type-source-job-id",
      (data) => {
        data.provenance.job_id = 123;
      },
      /missing its server identity/,
    ],
  ]) {
    const invalid = structuredClone(savedA);
    modify(invalid);
    await page.route(savedPath, (route) => route.fulfill({ json: invalid }));
    savedDialog = await openSaved(page);
    await savedDialog
      .locator(".saved-item")
      .filter({ hasText: savedA.name })
      .click();
    await expect(savedDialog.getByRole("alert")).toContainText(expected);
    await page.keyboard.press("Escape");
    await page.unroute(savedPath);
    assert.deepEqual(await exportJson(page), baseline);
    evidence.negativeCases.push(`snapshot:${label}`);
  }
  assert.deepEqual(await exportJson(page), baseline);
  evidence.negativeCases.push(
    "missing spectrum",
    "unknown snapshot 404",
    "wrong snapshot identity",
  );
  checks.push(
    "Missing spectra, unknown snapshots and mismatched response IDs fail truthfully without opening a plot or overwriting the editor",
  );

  const compareGate = gate(),
    compareStarted = deferred();
  const comparePath = `**/api/projects/${savedB.id}`;
  await page.route(comparePath, async (route) => {
    const response = await route.fetch();
    compareStarted.resolve();
    await compareGate.promise;
    await route.fulfill({ response });
  });
  savedDialog = await openSaved(page);
  for (const candidate of [savedB, savedC])
    await savedDialog
      .getByRole("checkbox", { name: `Compare ${candidate.name}`, exact: true })
      .check();
  await savedDialog
    .getByRole("button", { name: "Compare (2)", exact: true })
    .click();
  await awaitStarted(compareStarted, "delayed comparison detail");
  await page.keyboard.press("Escape");
  const compareResponse = page.waitForResponse((response) =>
    pathIs(response, `/projects/${savedB.id}`),
  );
  compareGate.resolve();
  await compareResponse;
  await settle(page);
  await expect(
    page.getByRole("dialog", { name: "Compare candidates", exact: true }),
  ).toHaveCount(0);
  assert.deepEqual(await exportJson(page), baseline);
  await page.unroute(comparePath);
  checks.push(
    "Closing comparison while real snapshot details are loading prevents a late response from reopening the comparison",
  );

  const loadGate = gate(),
    loadStarted = deferred();
  await page.route(savedPath, async (route) => {
    const response = await route.fetch();
    loadStarted.resolve();
    await loadGate.promise;
    await route.fulfill({ response });
  });
  savedDialog = await openSaved(page);
  await savedDialog
    .locator(".saved-item")
    .filter({ hasText: savedA.name })
    .click();
  await awaitStarted(loadStarted, "loadStarted");
  await page.keyboard.press("Escape");
  await widthSession(page, [190]);
  const afterClosedLoad = await exportJson(page);
  const loadResponse = page.waitForResponse((response) =>
    pathIs(response, `/projects/${savedA.id}`),
  );
  loadGate.resolve();
  await loadResponse;
  await settle(page);
  assert.deepEqual(await exportJson(page), afterClosedLoad);
  await page.unroute(savedPath);
  await history(page, "undo");
  assert.deepEqual(await exportJson(page), baseline);
  checks.push(
    "Closing an in-flight real snapshot load and editing prevents the delayed response from replacing newer inputs",
  );

  // Use real completed envelopes as adversarial response sources. A wrong
  // hash, kind, pol/grid, or polled ID must preserve the prior saved run.
  await page.close();
  const rejection = await newPage();
  const rejectionPage = rejection.target;
  await importJson(rejectionPage, exactPair(savedA));
  await expect(rejectionPage.locator(".result-badge")).toHaveText(
    "Unverified import",
  );
  const rejectedBaseline = await exportJson(rejectionPage);
  for (const [label, alter, expected] of [
    [
      "hash",
      (job) => {
        job.input_hash = "0".repeat(64);
      },
      /different or invalid forward job/,
    ],
    [
      "kind",
      (job) => {
        job.kind = "fit";
      },
      /different or invalid forward job/,
    ],
    [
      "empty-id",
      (job) => {
        job.id = "";
      },
      /different or invalid forward job/,
    ],
    [
      "wrong-type-id",
      (job) => {
        job.id = 123;
      },
      /different or invalid forward job/,
    ],
    [
      "grid",
      (job) => {
        job.result.wavelengths_nm[0] += 0.25;
      },
      /wavelength/,
    ],
    [
      "polarization",
      (job) => {
        delete job.result.spectra.p;
      },
      /polarization/,
    ],
  ]) {
    const bad = structuredClone(realAJob);
    alter(bad);
    await rejectionPage.route("**/api/jobs", (route) =>
      route.fulfill({ json: bad }),
    );
    await rejectionPage.getByRole("button", { name: /Run simulation/ }).click();
    await expect(rejectionPage.locator(".message.error")).toContainText(
      expected,
    );
    assert.deepEqual(await exportJson(rejectionPage), rejectedBaseline);
    await expect(rejectionPage.locator(".result-badge")).toHaveText(
      "Unverified import",
    );
    await rejectionPage.unroute("**/api/jobs");
    await dismissError(rejectionPage);
    evidence.negativeCases.push(`forward binding:${label}`);
  }
  const wrongPollId = `workflow-wrong-poll-${Date.now()}`;
  await rejectionPage.route("**/api/jobs", (route) =>
    route.fulfill({
      json: { ...realAJob, id: wrongPollId, status: "running", result: null },
    }),
  );
  await rejectionPage.route(`**/api/jobs/${wrongPollId}`, (route) =>
    route.fulfill({ json: { ...realAJob, id: "unrelated-job" } }),
  );
  await rejectionPage.getByRole("button", { name: /Run simulation/ }).click();
  await expect(rejectionPage.locator(".message.error")).toContainText(
    "different or invalid forward job",
  );
  assert.deepEqual(await exportJson(rejectionPage), rejectedBaseline);
  await rejectionPage.unroute("**/api/jobs");
  await rejectionPage.unroute(`**/api/jobs/${wrongPollId}`);
  await dismissError(rejectionPage);
  evidence.negativeCases.push("forward binding:polled job ID");
  const pollGate = gate(),
    pollStarted = deferred();
  const pollId = `workflow-delayed-${Date.now()}`;
  await rejectionPage.route("**/api/jobs", (route) =>
    route.fulfill({
      json: { ...realAJob, id: pollId, status: "running", result: null },
    }),
  );
  await rejectionPage.route(`**/api/jobs/${pollId}`, async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({
        json: { ...realAJob, id: pollId, status: "cancelled", result: null },
      });
      return;
    }
    pollStarted.resolve();
    await pollGate.promise;
    await route.fulfill({ json: { ...realAJob, id: "wrong-delayed-job" } });
  });
  await rejectionPage.getByRole("button", { name: /Run simulation/ }).click();
  await awaitStarted(pollStarted, "pollStarted");
  await menu(rejectionPage);
  await expect(
    rejectionPage.getByRole("button", { name: /↶\s*Undo/ }),
  ).toBeDisabled();
  await expect(
    rejectionPage.getByRole("button", { name: /↷\s*Redo/ }),
  ).toBeDisabled();
  await expect(
    rejectionPage.locator(".dimension-rail button").first(),
  ).toBeDisabled();
  await rejectionPage
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(rejectionPage.locator(".message.success")).toContainText(
    "cancelled",
  );
  await widthSession(rejectionPage, [192]);
  const afterCancellation = await exportJson(rejectionPage);
  const pollResponse = rejectionPage.waitForResponse((response) =>
    pathIs(response, `/jobs/${pollId}`, "GET"),
  );
  pollGate.resolve();
  await pollResponse;
  await settle(rejectionPage);
  assert.deepEqual(await exportJson(rejectionPage), afterCancellation);
  await rejectionPage.unroute("**/api/jobs");
  await rejectionPage.unroute(`**/api/jobs/${pollId}`);
  await rejectionPage.close();
  checks.push(
    "Wrong job hash/kind/result grid/channel are rejected; pending jobs lock history/geometry, and a delayed wrong-job response after cancellation cannot replace a newer edit",
  );

  // Save races run against an actual browser-computed job. 404 and corrupt
  // metadata are negative fixtures; delayed success forwards the real API.
  const savingCase = await newPage();
  const savingPage = savingCase.target;
  const inputSave = await boundedProject(example, "save ownership", {
    width: 203,
    waves: [623],
  });
  await importJson(savingPage, inputSave);
  const startSaveResponse = savingPage.waitForResponse((response) =>
    pathIs(response, "/jobs", "POST"),
  );
  await savingPage.getByRole("button", { name: /Run simulation/ }).click();
  const saveJob = await (await startSaveResponse).json();
  activeJobs.add(saveJob.id);
  await expect(savingPage.locator(".result-badge")).toHaveText("Computed", {
    timeout: 90000,
  });
  activeJobs.delete(saveJob.id);
  const saveBaseline = await exportJson(savingPage);
  evidence.realJobs.push({
    id: saveJob.id,
    project: inputSave.name,
    wavelengths: [623],
    harmonics: 3,
  });
  let expiredPosts = 0;
  await savingPage.route("**/api/snapshots", (route) => {
    expiredPosts += 1;
    return route.fulfill({
      status: 404,
      json: { detail: "Job no longer exists" },
    });
  });
  const expiredCalls = savingCase.calls.length;
  await menu(savingPage);
  await savingPage.getByLabel("Save project to local server").click();
  await expect(savingPage.locator(".message.error")).toContainText("expired");
  assert.equal(expiredPosts, 1);
  assert.equal(
    savingCase.calls
      .slice(expiredCalls)
      .some((call) => call.method === "POST" && call.path === "/api/projects"),
    false,
    "Expired trusted Save never falls back to unverified /projects",
  );
  assert.deepEqual(await exportJson(savingPage), saveBaseline);
  await expect(savingPage.locator(".result-badge")).toHaveText("Computed");
  await savingPage.unroute("**/api/snapshots");
  await dismissError(savingPage);
  const durableSave = await request("/snapshots", { job_id: saveJob.id });
  evidence.snapshots.push({
    id: durableSave.id,
    name: durableSave.name,
    jobId: saveJob.id,
  });
  await savingPage.route("**/api/snapshots", (route) =>
    route.fulfill({
      json: {
        ...durableSave,
        provenance: {
          ...durableSave.provenance,
          job_id: savedB.provenance.job_id,
        },
      },
    }),
  );
  await menu(savingPage);
  await savingPage.getByLabel("Save project to local server").click();
  await expect(savingPage.locator(".message.error")).toContainText(
    "does not match this exact run",
  );
  await expect(savingPage.locator(".result-badge")).toHaveText("Computed");
  assert.deepEqual(await exportJson(savingPage), saveBaseline);
  await savingPage.unroute("**/api/snapshots");
  await dismissError(savingPage);
  for (const invalidId of ["", 123]) {
    await savingPage.route("**/api/snapshots", (route) =>
      route.fulfill({ json: { ...durableSave, id: invalidId } }),
    );
    await menu(savingPage);
    await savingPage.getByLabel("Save project to local server").click();
    await expect(savingPage.locator(".message.error")).toContainText(
      "different saved project",
    );
    await expect(savingPage.locator(".result-badge")).toHaveText("Computed");
    assert.deepEqual(await exportJson(savingPage), saveBaseline);
    await savingPage.unroute("**/api/snapshots");
    await dismissError(savingPage);
  }
  const lateSaveGate = gate(),
    lateSaveStarted = deferred();
  await savingPage.route("**/api/snapshots", async (route) => {
    const response = await route.fetch();
    lateSaveStarted.resolve();
    await lateSaveGate.promise;
    await route.fulfill({ response });
  });
  await menu(savingPage);
  await savingPage.getByLabel("Save project to local server").click();
  await awaitStarted(lateSaveStarted, "lateSaveStarted");
  await widthSession(savingPage, [204]);
  await history(savingPage, "undo");
  assert.deepEqual(await exportJson(savingPage), saveBaseline);
  const lateSaveResponse = savingPage.waitForResponse((response) =>
    pathIs(response, "/snapshots", "POST"),
  );
  lateSaveGate.resolve();
  await lateSaveResponse;
  await settle(savingPage);
  await expect(savingPage.locator(".result-badge")).toHaveText("Computed");
  assert.deepEqual(await exportJson(savingPage), saveBaseline);
  assert.deepEqual(
    await request(`/projects/${durableSave.id}`),
    durableSave,
    "The real late save may be durable but must not relabel a newer workspace",
  );
  await savingPage.unroute("**/api/snapshots");
  await savingPage.close();
  evidence.negativeCases.push(
    "expired snapshot save 404",
    "wrong snapshot job binding",
    "save response after edit-then-undo",
  );
  checks.push(
    "Expired real-run Save gives an actionable error with no /projects fallback; wrong snapshot job binding is rejected; a delayed real successful save cannot relabel even an edit-then-undo workspace",
  );

  for (const width of [360, 390]) {
    const mobile = await newPage(appUrl, { width, height: 844 });
    const target = mobile.target;
    await loadSnapshot(target, savedA);
    comparison = await compare(target, [savedA, savedB, savedC]);
    await assertComparisonValues(
      comparison,
      [savedA, savedB, savedC],
      "T_specular",
      "p",
      1,
    );
    await assertNoOverflow(target, comparison);
    await assertFocusInside(target, comparison, 20);
    await screenshot(target, `comparison-${width}`);
    await comparison
      .locator(".comparison-plot")
      .scrollIntoViewIfNeeded({ timeout: 5000 });
    await screenshot(target, `comparison-${width}-chart`);
    await target.keyboard.press("Escape");
    ({ review, focus } = await localProposal(target, proposal));
    await assertNoOverflow(target, review);
    await assertFocusInside(target, review);
    await screenshot(target, `proposal-${width}`);
    await target.keyboard.press("Escape");
    await expect(focus).toBeFocused();
    assert.deepEqual(await exportJson(target), baseline);
    await target.close();
    checks.push(
      `${width}px real three-candidate comparison and proposal review fit without page/dialog overflow, retain exact sample values, trap keyboard focus and dismiss with Escape`,
    );
  }

  // Static proposal review uses the actual server preview file but must make
  // no API requests in the browser, including export/import/history controls.
  for (const width of [360, 390]) {
    const staticCase = await newPage(previewUrl, { width, height: 844 });
    const target = staticCase.target;
    await expect(target.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    const staticBaseline = await exportJson(target);
    const staticProposal = await request("/change-preview", {
      base_project: staticBaseline.project,
      changes: { cd_nm: staticBaseline.project.layers[0].cd_nm + 9 },
    });
    await widthSession(target, [
      staticBaseline.project.layers[0].cd_nm + 2,
      staticBaseline.project.layers[0].cd_nm + 3,
    ]);
    await history(target, "undo");
    assert.deepEqual(await exportJson(target), staticBaseline);
    ({ review, focus } = await localProposal(target, staticProposal));
    await assertNoOverflow(target, review);
    await assertFocusInside(target, review);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(focus).toBeFocused();
    assert.deepEqual(await exportJson(target), staticBaseline);
    ({ review } = await localProposal(target, staticProposal));
    await review
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect(target.locator(".result-badge")).toHaveText("Inputs changed");
    const staticApplied = await exportJson(target);
    assert.deepEqual(staticApplied.project, staticProposal.candidate_project);
    assert.deepEqual(staticApplied.result, staticBaseline.result);
    assert.deepEqual(
      staticApplied.result_project,
      staticBaseline.result_project,
    );
    await history(target, "undo");
    assert.deepEqual(await exportJson(target), staticBaseline);
    await expect(target.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    await history(target, "redo");
    assert.deepEqual(await exportJson(target), staticApplied);
    await history(target, "undo");
    await importJson(
      target,
      {
        ...exactPair(savedA),
        provenance: savedA.provenance,
        resultOrigin: "server",
      },
      "workflow-static-forged-origin.json",
    );
    await expect(target.locator(".result-badge")).toHaveText(
      "Unverified import",
    );
    await history(target, "undo");
    await expect(target.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    await menu(target);
    await expect(
      target.getByRole("button", { name: "Open", exact: true }),
    ).toBeDisabled();
    await expect(
      target.getByLabel("Save project to local server"),
    ).toBeDisabled();
    await expect(
      target.getByRole("button", { name: /Run simulation/ }),
    ).toHaveCount(0);
    await expect(target.locator(".history-scope").first()).toContainText(
      "browser session",
    );
    await target.keyboard.press("Escape");
    await assertNoOverflow(target);
    await screenshot(target, `static-history-${width}`);
    assert.deepEqual(
      staticCase.calls,
      [],
      "Static build never calls /api through history, proposals or stored-candidate controls",
    );
    await target.close();
    checks.push(
      `${width}px static preview imports actual proposals, cancels/applies locally, restores the exact reference run and origin with Undo/Redo, rejects imported provenance claims, disables server actions and makes zero API calls`,
    );
  }

  assert.deepEqual(pageErrors, [], "No uncaught browser errors");
  assert.equal(
    collectedFailures.length,
    0,
    `${collectedFailures.length} independent read-only assertions failed; see collectedFailures in workflow-browser-qa.json`,
  );
  const report = {
    status: "passed",
    checks,
    pageErrors,
    collectedFailures,
    evidence,
    date: new Date().toISOString(),
  };
  await fs.writeFile(
    `${output}/workflow-browser-qa.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page
    ?.screenshot({
      path: `${output}/workflow-browser-failure.png`,
      fullPage: false,
    })
    .catch(() => {});
  const report = {
    status: "failed",
    checks,
    pageErrors,
    collectedFailures,
    evidence,
    error: error.stack || String(error),
    date: new Date().toISOString(),
  };
  await fs.writeFile(
    `${output}/workflow-browser-qa.json`,
    JSON.stringify(report, null, 2),
  );
  console.error(JSON.stringify(report, null, 2));
  throw error;
} finally {
  for (const pending of pendingGates) pending.resolve();
  for (const id of activeJobs)
    await request(`/jobs/${encodeURIComponent(id)}`, undefined, "DELETE").catch(
      () => {},
    );
  await browser?.close();
}
