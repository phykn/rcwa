/* global window, document, getComputedStyle */
// Real static editing -> input-only download -> local import and solver result.
// Recovery never imports results or provenance from sessionStorage.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { recordNativeModalKeyboard } from "./browser-native-dialog-focus.mjs";
import { capture, closeSheet, menuAction, importText, applyImportedDesign, assertFullResult } from "./browser-2d-controls.mjs";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, {recursive: true});
const previewUrl = process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173";
const appUrl = process.env.RCWA_APP_URL || "http://127.0.0.1:5173";
const key = "rcwa:input-draft:1:circle";
const original = JSON.parse(await fs.readFile(new URL("../src/fixtures/default-project-circular.json", import.meta.url), "utf8"));
const report = {status: "running", checks: [], captures: [], screenshots: [], pageErrors: [], issues: [], keyboard: [], limitations: ["Chromium touch emulation is not a real-device or spoken screen-reader test."]};
let browser;
const diameter = (page) => page.getByRole("button", {name: /^Edit Layer 1 diameter:/});
const handoff = (page) => page.getByRole("button", {name: "Use this design locally", exact: true});
async function editDiameter(page, value, close = true) {
  await diameter(page).click();
  await page.getByRole("spinbutton", {name: "Diameter nm", exact: true}).fill(String(value));
  if (close) await closeSheet(page);
}
async function downloaded(page, button, name) {
  const pending = page.waitForEvent("download");
  pending.catch(() => {});
  await button();
  const file = await pending;
  const path = `${output}/design-handoff-${name}.json`;
  await file.saveAs(path);
  return {path, data: JSON.parse(await fs.readFile(path, "utf8"))};
}
const exportMenu = (page, name) => downloaded(page, () => menuAction(page, "Export"), name);
async function fresh(width = 360, setup) {
  const context = await browser.newContext({viewport: {width, height: width === 1440 ? 1000 : 844}, isMobile: width < 700, hasTouch: width < 700});
  if (setup) await context.addInitScript(setup);
  const page = await context.newPage(), calls = [];
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) calls.push(request.url());
  });
  await page.goto(previewUrl);
  await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
  await page.evaluate(() => document.fonts.ready);
  return {context, page, calls};
}
async function savedDraft(page, expected) {
  await expect.poll(() => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || "null")?.project || null, key)).toEqual(expected);
  const envelope = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), key);
  assert.deepEqual(Object.keys(envelope).sort(), ["format", "project"]);
  assert.equal(envelope.format, "rcwa-input-draft/1");
}
async function shot(page, name) {
  await capture(page, report, output, name, {prefix: "design-handoff", full: false, top: false});
}
try {
  browser = await chromium.launch({headless: true, args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
  let transferred;
  for (const width of [360, 390, 1440]) {
    const {context, page, calls} = await fresh(width);
    await expect(page.getByRole("link", {name: "View example spectrum"})).toHaveAttribute("href", "#spectrum");
    const edited = structuredClone(original);
    edited.layers[0].diameter_nm = 70;
    await editDiameter(page, 70);
    edited.name = `Local handoff ${width}`;
    await page.getByRole("textbox", {name: "Project name", exact: true}).fill(edited.name);
    await page.getByRole("textbox", {name: "Project name", exact: true}).blur();
    await page.getByRole("button", {name: "Layer settings ↗", exact: true}).click();
    await page.getByRole("button", {name: "Edit materials", exact: true}).click();
    await page.getByRole("button", {name: "Host material", exact: true}).click();
    await page.getByRole("spinbutton", {name: "Host n", exact: true}).fill("2.3");
    edited.layers[0].background.n = 2.3;
    await closeSheet(page, "Close settings");
    // Keep the genuine compute check bounded without altering exported inputs
    // between static download and local import.
    await page.getByRole("button", {name: "Edit light", exact: true}).click();
    await page.getByRole("spinbutton", {name: "Wavelength samples", exact: true}).fill("1");
    edited.illumination.wavelengths_nm = [original.illumination.wavelengths_nm[0]];
    await closeSheet(page, "Close settings");
    await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
    await handoff(page).click(); // Action 1.
    const dialog = page.getByRole("dialog", {name: "Use this design locally", exact: true});
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", {name: "Export current inputs", exact: true})).toBeInViewport();
    assert.equal(await dialog.evaluate((node) => getComputedStyle(node, "::backdrop").backdropFilter), "none");
    const file = await downloaded(page, () => dialog.getByRole("button", {name: "Export current inputs", exact: true}).click(), `${width}-inputs`); // Action 2.
    assert.deepEqual(file.data.project, edited);
    assert.equal(file.data.result, null);
    assert.equal(file.data.result_project, null);
    transferred = file;
    await shot(page, `${width}-dialog`);
    try {
      await recordNativeModalKeyboard(page, dialog, report, width);
      report.keyboard.at(-1).status = "passed";
    } catch (error) {
      // Preserve this independent failure while collecting the remaining real
      // handoff evidence. Any recorded issue still fails the suite below.
      report.issues.push(`${width}px keyboard: ${String(error?.stack || error)}`);
      if (report.keyboard.at(-1)?.width === width) report.keyboard.at(-1).status = "failed";
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(handoff(page)).toBeFocused();
    await handoff(page).click();
    await dialog.getByRole("button", {name: "Back to design", exact: true}).click();
    await expect(handoff(page)).toBeFocused();
    await savedDraft(page, edited);
    // No debounce wait: reload while the numeric inspector is still open.
    edited.layers[0].diameter_nm = 71;
    await editDiameter(page, 71, false);
    await page.reload();
    await expect(diameter(page)).toHaveAttribute("aria-label", "Edit Layer 1 diameter: 71 nanometers");
    await expect(page.locator(".result-badge")).toHaveText("No result yet");
    await expect(page.locator(".message.success")).toContainText("No result or undo history was restored");
    assert.deepEqual((await exportMenu(page, `${width}-restored`)).data.project, edited);
    await page.locator(".project-menu summary").click();
    await expect(page.getByRole("button", {name: "↶ Undo", exact: true})).toBeDisabled();
    await page.locator(".project-menu summary").click();
    await shot(page, `${width}-restored`);
    // Another independently opened tab does not inherit the design.
    const other = await context.newPage();
    await other.goto(previewUrl);
    await expect(other.locator(".result-badge")).toHaveText("Precomputed example");
    await expect(diameter(other)).toHaveAttribute("aria-label", `Edit Layer 1 diameter: ${original.layers[0].diameter_nm} nanometers`);
    await other.close();
    await menuAction(page, "Reset example");
    await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
    await savedDraft(page, original);
    await page.reload();
    assert.deepEqual((await exportMenu(page, `${width}-reset-reloaded`)).data.project, original);
    await expect(page.locator(".result-badge")).toHaveText("No result yet");
    assert.equal(calls.length, 0);
    report.checks.push(`${width}px: edited name/diameter/material, two-action current-input export, Escape/trigger-focus/reopen, pagehide recovery, no restored result/history, isolated new tab, reset replacement, no API requests; keyboard traces are reported separately`);
    await context.close();
  }
  for (const [name, raw] of [
    ["corrupt", "{"],
    ["unsupported", JSON.stringify({format: "rcwa-input-draft/99", project: original})],
    ["forged-result", JSON.stringify({format: "rcwa-input-draft/1", project: original, result: {source: "server_computed"}})],
  ]) {
    const context = await browser.newContext();
    await context.addInitScript(({key, raw}) => sessionStorage.setItem(key, raw), {key, raw});
    const page = await context.newPage();
    await page.goto(previewUrl);
    await expect(page.locator(".draft-warning")).toContainText("could not be restored");
    await expect(diameter(page)).toHaveAttribute("aria-label", `Edit Layer 1 diameter: ${original.layers[0].diameter_nm} nanometers`);
    await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
    report.checks.push(`${name}: ignored untrusted draft, verified example remains editable`);
    await context.close();
  }
  {
    const {context, page, calls} = await fresh(360, () => Object.defineProperty(window, "sessionStorage", {get() {throw new DOMException("blocked", "SecurityError");}}));
    await expect(page.locator(".draft-warning")).toContainText("Tab recovery is unavailable");
    await editDiameter(page, 72);
    const exported = await downloaded(page, () => page.getByRole("button", {name: "Export inputs", exact: true}).click(), "blocked-storage-inputs");
    assert.equal(exported.data.project.layers[0].diameter_nm, 72);
    await shot(page, "360-blocked-storage");
    assert.equal(calls.length, 0);
    report.checks.push("Blocked sessionStorage does not block editing or current-input export");
    await context.close();
  }
  for (const failure of ["quota", "oversize"]) {
    const {context, page, calls} = await fresh();
    const edited = structuredClone(original);
    edited.layers[0].diameter_nm = 73;
    await editDiameter(page, 73);
    await savedDraft(page, edited);
    if (failure === "quota") {
      await page.evaluate(() => {Storage.prototype.setItem = () => {throw new DOMException("quota", "QuotaExceededError");};});
      await editDiameter(page, 74);
      await expect(page.locator(".draft-warning")).toContainText("Tab recovery is unavailable");
    } else {
      const table = {name: "Large valid table", kind: "tabulated", n: 1, k: 0, wavelengths_nm: Array.from({length: 2000}, (_, i) => 200 + i), n_values: Array(2000).fill(1.123456789123456), k_values: Array(2000).fill(0.1234567891234567), source: "Synthetic recovery boundary fixture"};
      edited.layers = Array.from({length: 8}, () => ({...structuredClone(original.layers[0]), material: structuredClone(table), background: structuredClone(table)}));
      assert.ok(Buffer.byteLength(JSON.stringify(edited)) > 512 * 1024);
      await importText(page, {project: edited}, "valid-large-inputs");
      await applyImportedDesign(page);
      await expect(page.locator(".draft-warning")).toContainText("exceed the tab recovery limit");
      assert.deepEqual((await exportMenu(page, "oversize-export")).data.project, edited);
    }
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), key), null);
    await page.reload();
    await expect(diameter(page)).toHaveAttribute("aria-label", `Edit Layer 1 diameter: ${original.layers[0].diameter_nm} nanometers`);
    await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
    assert.equal(calls.length, 0);
    report.checks.push(`${failure} after a saved edit removes the outdated draft; reload never falsely recovers it as the latest input`);
    await context.close();
  }
  // Complete the actual downloaded design on the real local solver.
  {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    await page.goto(appUrl);
    await expect(page.locator(".connection")).toHaveText("Solver connected");
    await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
    await page.locator(".project-menu input[type=file]").setInputFiles(transferred.path);
    await applyImportedDesign(page);
    await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
    assert.deepEqual((await exportMenu(page, "local-import")).data.project, transferred.data.project);
    const validation = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/validate" && response.request().method() === "POST");
    validation.catch(() => {});
    await page.getByRole("button", {name: /Run simulation/}).click();
    const validated = await (await validation).json();
    assert.equal(validated.valid, true);
    assert.deepEqual(validated.project, transferred.data.project);
    await expect(page.locator(".result-badge")).toHaveText("Computed", {timeout: 90000});
    const computed = (await exportMenu(page, "local-computed")).data;
    assert.deepEqual(computed.result_project, transferred.data.project);
    assertFullResult(computed.result, transferred.data.project);
    assert.equal(computed.result.metadata.input_hash, validated.input_hash);
    report.inputHash = validated.input_hash;
    await savedDraft(page, transferred.data.project);
    await shot(page, "desktop-local-computed");
    await page.reload();
    await expect(page.locator(".result-badge")).toHaveText("No result yet");
    assert.deepEqual((await exportMenu(page, "local-recovered-inputs")).data.project, transferred.data.project);
    report.checks.push("Downloaded Pages design imports exactly, validates and computes on the real local API with the same input hash; subsequent recovery restores no result/provenance");
    await context.close();
  }
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.issues, [], "Every independent keyboard check must pass; failures remain in the report");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.issues.push(String(error?.stack || error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fs.writeFile(`${output}/design-handoff-browser-qa.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
