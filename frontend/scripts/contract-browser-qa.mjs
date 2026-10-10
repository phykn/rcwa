// Deterministic interaction/contract checks. Real numerical computation is
// exercised separately by browser-qa.mjs and snapshot-browser-qa.mjs.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const appUrl = process.env.RCWA_APP_URL || "http://127.0.0.1:5173";
const output = new URL("../../artifacts/", import.meta.url).pathname;
const reference = JSON.parse(await fs.readFile(new URL("../public/reference-example.json", import.meta.url), "utf8"));
await fs.mkdir(output, { recursive: true });
const checks = [];
const pageErrors = [];
let browser;
let page;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function settle() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function menu() {
  const target = page.locator(".project-menu");
  if (!(await target.evaluate((element) => element.open))) await target.locator("summary").click();
}
async function openSaved() {
  await menu();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Saved projects" })).toBeVisible();
}
async function importProject(data, name = "contract-project.json") {
  await page.locator(".file-actions input[type=file]").setInputFiles({
    name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)),
  });
}
async function exportProject() {
  await menu();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const file = await downloading;
  const path = `${output}/contract-export.json`;
  await file.saveAs(path);
  return JSON.parse(await fs.readFile(path, "utf8"));
}
async function editDimension(dimension, value) {
  await page.locator(".dimension-rail").getByRole("button", { name: new RegExp(dimension) }).click();
  await expect(page.locator(`#dimension-${dimension}`)).toBeVisible();
  await page.locator(`#dimension-${dimension}`).fill(String(value));
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.locator(".inspector")).not.toBeVisible();
}
function snapshot(id, name) {
  return {
    id, name, created_at: "2026-10-10T00:00:00Z", updated_at: "2026-10-10T00:00:00Z",
    project: { ...structuredClone(reference.project), name }, result: reference.result,
    provenance: { source: "unverified_import" },
  };
}

try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(appUrl);
  await expect(page.locator(".connection")).toHaveText("Solver connected");

  const tableProject = structuredClone(reference.project);
  tableProject.name = "Contract table and exact inputs";
  tableProject.period_nm = 510;
  tableProject.layers[0].cd_nm = 201.25;
  tableProject.layers[0].thickness_nm = 175.5;
  tableProject.layers[0].material = {
    name: "Synthetic imported table", kind: "tabulated", n: 2, k: 0,
    wavelengths_nm: [200, 2500], n_values: [2, 2.4], k_values: [0, 0.1], source: "Contract test fixture",
  };
  tableProject.layers[0].background.n = 1.25;
  tableProject.ambient.n = 1.1;
  tableProject.substrate.k = 0.05;
  tableProject.illumination = { wavelengths_nm: [450, 511, 620, 700, 850], angle_deg: 21.5, polarization: "p" };
  tableProject.solver.harmonics = 9;
  await importProject(tableProject);
  await expect(page.getByLabel("Project name")).toHaveValue(tableProject.name);
  assert.deepEqual((await exportProject()).project, tableProject);
  await editDimension("width", 205.5);
  tableProject.layers[0].cd_nm = 205.5;
  assert.deepEqual((await exportProject()).project, tableProject);
  await page.getByRole("button", { name: "Edit materials", exact: true }).click();
  await expect(page.getByLabel("Ridge material name")).toHaveValue("Synthetic imported table");
  await expect(page.locator(".table-summary")).toContainText("2 samples");
  await expect(page.getByLabel("Substrate k", { exact: true })).toHaveValue("0.05");
  await page.keyboard.press("Escape");
  await expect(page.locator(".inspector")).not.toBeVisible();
  checks.push("Canonical input round trip preserves tabulated materials, absorption, nonuniform wavelength lists, polarization, harmonic order and fractional geometry");

  const invalidTable = structuredClone(tableProject);
  invalidTable.name = "Invalid table must not replace inputs";
  invalidTable.layers[0].material.n = "invalid number";
  await importProject(invalidTable);
  await expect(page.locator(".message.error")).toBeVisible();
  await expect(page.getByLabel("Project name")).toHaveValue(tableProject.name);
  assert.deepEqual((await exportProject()).project, tableProject);
  await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
  const unsupportedProject = structuredClone(tableProject);
  unsupportedProject.layers.push(structuredClone(unsupportedProject.layers[0]));
  await importProject(unsupportedProject);
  await expect(page.locator(".message.error")).toContainText("exactly one grating layer");
  await expect(page.getByLabel("Project name")).toHaveValue(tableProject.name);
  await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
  unsupportedProject.layers = [unsupportedProject.layers[0]];
  unsupportedProject.layers[0].geometry = "rectangle_2d";
  await importProject(unsupportedProject);
  await expect(page.locator(".message.error")).toContainText("rectangle_1d");
  await expect(page.getByLabel("Project name")).toHaveValue(tableProject.name);
  await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
  checks.push("Malformed tabulated placeholders and unsupported multilayer/2D imports are rejected without replacing current inputs");

  const a = snapshot("contract-a", "Contract delayed A");
  const b = snapshot("contract-b", "Contract current B");
  await page.route("**/api/projects", (route) => route.fulfill({ json: [a, b] }));
  const oldLoad = deferred();
  const loadStarted = deferred();
  await page.route("**/api/projects/contract-a", async (route) => {
    loadStarted.resolve();
    await oldLoad.promise;
    await route.fulfill({ json: a });
  });
  await page.route("**/api/projects/contract-b", (route) => route.fulfill({ json: b }));
  await openSaved();
  await page.locator(".saved-item").filter({ hasText: a.name }).click();
  await loadStarted.promise;
  await expect(page.locator(".saved-item").filter({ hasText: b.name })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Saved projects" })).not.toBeVisible();
  await openSaved();
  await page.locator(".saved-item").filter({ hasText: b.name }).click();
  await expect(page.getByLabel("Project name")).toHaveValue(b.name);
  await page.getByLabel("Project name").fill("Newer edit after dismissed load");
  const oldResponse = page.waitForResponse((response) => response.url().endsWith("/api/projects/contract-a"));
  oldLoad.resolve();
  await oldResponse;
  await settle();
  await expect(page.getByLabel("Project name")).toHaveValue("Newer edit after dismissed load");
  await expect(page.getByRole("dialog", { name: "Saved projects" })).not.toBeVisible();
  checks.push("A dismissed delayed project load cannot overwrite a newer loaded project or edits; repeated saved-item clicks are locked");

  await page.unroute("**/api/projects");
  let listCount = 0;
  const oldList = deferred();
  const listStarted = deferred();
  await page.route("**/api/projects", async (route) => {
    listCount += 1;
    if (listCount === 1) {
      listStarted.resolve();
      await oldList.promise;
      await route.fulfill({ json: [a] });
    } else await route.fulfill({ json: [b] });
  });
  await openSaved();
  await listStarted.promise;
  await page.getByRole("button", { name: "Close saved projects", exact: true }).click();
  await openSaved();
  await expect(page.locator(".saved-item")).toContainText(b.name);
  const listResponse = page.waitForResponse((response) => response.url().endsWith("/api/projects"));
  oldList.resolve();
  await listResponse;
  await settle();
  await expect(page.locator(".saved-item")).toHaveCount(1);
  await expect(page.locator(".saved-item")).toContainText(b.name);
  await page.keyboard.press("Escape");
  checks.push("A superseded saved-list response cannot replace the latest reopened list");

  const resetGate = deferred();
  const resetStarted = deferred();
  await page.route("**/api/example", async (route) => {
    resetStarted.resolve();
    await resetGate.promise;
    await route.fulfill({ json: reference.project });
  });
  await page.getByRole("button", { name: "Reset example", exact: true }).click();
  await resetStarted.promise;
  await page.getByLabel("Project name").fill("Newer edit after reset request");
  const resetResponse = page.waitForResponse((response) => response.url().endsWith("/api/example"));
  resetGate.resolve();
  await resetResponse;
  await settle();
  await expect(page.getByLabel("Project name")).toHaveValue("Newer edit after reset request");
  await page.unroute("**/api/example");
  checks.push("A delayed reset does not discard edits made while the request was in flight");

  await importProject({ ...reference, provenance: { source: "server_computed" }, resultOrigin: "server" });
  await expect(page.locator(".result-badge")).toHaveText("Unverified import");
  await editDimension("width", 202.25);
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  const beforeRun = await exportProject();
  assert.deepEqual(beforeRun.result_project, reference.project);
  assert.deepEqual(beforeRun.result, reference.result);
  let posts = 0;
  let polls = 0;
  let submitted;
  const submitGate = deferred();
  const submitStarted = deferred();
  await page.route("**/api/jobs**", async (route) => {
    if (route.request().method() === "POST") {
      posts += 1;
      submitted = route.request().postDataJSON();
      submitStarted.resolve();
      await submitGate.promise;
      await route.fulfill({ json: { id: "contract-interrupted", kind: "forward", status: "queued", result: null, error: null } });
    } else {
      polls += 1;
      await route.fulfill({ status: polls === 1 ? 503 : 404, json: { detail: polls === 1 ? "Temporary outage" : "Job no longer exists" } });
    }
  });
  await page.getByRole("button", { name: /Run simulation/ }).evaluate((button) => { button.click(); button.click(); });
  await submitStarted.promise;
  await expect(page.locator(".dimension-rail button").first()).toBeDisabled();
  assert.equal(posts, 1, "Same-turn repeated run clicks must create only one job");
  assert.deepEqual(submitted, { kind: "forward", project: beforeRun.project });
  submitGate.resolve();
  await expect(page.locator(".message.error")).toContainText("Connection interrupted", { timeout: 10000 });
  await expect(page.locator(".message.error")).toContainText("no longer exists", { timeout: 10000 });
  await expect(page.getByRole("button", { name: /Run simulation/ })).toBeEnabled();
  assert.deepEqual((await exportProject()).result, reference.result);
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  await page.unroute("**/api/jobs**");
  checks.push("Run submits the exact edited Project once, locks geometry, retries interrupted polling, recovers from a missing job and preserves stale prior results");

  await expect(page.locator(".three-canvas")).toHaveAttribute("data-ready", "true");
  const canvas = page.locator(".webgl-host canvas");
  await canvas.scrollIntoViewIfNeeded();
  await canvas.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("+");
  const pitchHandle = page.getByRole("slider", { name: "Drag pitch", exact: true });
  await pitchHandle.scrollIntoViewIfNeeded();
  const pitchStart = await pitchHandle.boundingBox();
  const oldPitch = Number(await pitchHandle.getAttribute("aria-valuenow"));
  const grabX = pitchStart.x + pitchStart.width / 2;
  const grabY = pitchStart.y + pitchStart.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 32, grabY, { steps: 8 });
  await expect.poll(async () => Number(await pitchHandle.getAttribute("aria-valuenow"))).toBeGreaterThan(oldPitch);
  const pitchDuring = await pitchHandle.boundingBox();
  assert.ok(Math.hypot(pitchDuring.x - pitchStart.x, pitchDuring.y - pitchStart.y) > 8,
    "Pitch handle must move on screen during drag instead of cancelling motion by rescaling the scene");
  await page.screenshot({ path: `${output}/contract-pitch-mid-drag.png` });
  await page.mouse.up();
  await expect(page.locator(".inspector")).not.toBeVisible();
  await expect(page.getByRole("slider", { name: "Drag width", exact: true })).toHaveAttribute("aria-valuenow", "202.25");
  await expect(page.getByRole("slider", { name: "Drag height", exact: true })).toHaveAttribute("aria-valuenow", "160");
  await page.getByRole("button", { name: "Reset 3D view", exact: true }).click();
  await editDimension("pitch", 400);
  checks.push("After orbit and zoom, dragging pitch moves its projected handle while width/height remain unchanged; gesture release opens no material sheet");
  const contextLost = await page.locator(".webgl-host canvas").evaluate((canvas) => {
    const context = canvas.getContext("webgl2");
    const extension = context?.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    extension.loseContext();
    return true;
  });
  assert.equal(contextLost, true, "Chromium should expose the WebGL context-loss test extension");
  await expect(page.locator(".webgl-fallback")).toBeVisible();
  await editDimension("width", 203.25);
  assert.equal((await exportProject()).project.layers[0].cd_nm, 203.25);
  checks.push("Actual WebGL context loss shows a fallback while exact dimension editing and export remain available");

  const fallback = await browser.newPage({ viewport: { width: 390, height: 844 } });
  fallback.on("pageerror", (error) => pageErrors.push(error.message));
  await fallback.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...options) {
      if (["webgl", "webgl2", "experimental-webgl"].includes(kind)) return null;
      return original.call(this, kind, ...options);
    };
  });
  await fallback.goto(appUrl);
  await expect(fallback.locator(".webgl-fallback")).toBeVisible();
  await fallback.locator(".dimension-rail").getByRole("button", { name: /width/ }).click();
  await fallback.locator("#dimension-width").fill("211");
  await fallback.keyboard.press("Escape");
  await expect(fallback.locator(".inspector")).not.toBeVisible();
  await expect(fallback.locator(".dimension-rail")).toContainText("211");
  await fallback.screenshot({ path: `${output}/contract-webgl-fallback.png`, fullPage: true });
  checks.push("WebGL creation failure retains a usable mobile dimension editor with normal Escape dismissal");
  assert.deepEqual(pageErrors, []);
  const report = { status: "passed", checks, pageErrors, date: new Date().toISOString() };
  await fs.writeFile(`${output}/contract-browser-qa.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page?.screenshot({ path: `${output}/contract-browser-failure.png`, fullPage: true }).catch(() => {});
  await fs.writeFile(`${output}/contract-browser-qa.json`, JSON.stringify({ status: "failed", checks, pageErrors, error: String(error), date: new Date().toISOString() }, null, 2));
  throw error;
} finally {
  await browser?.close();
}
