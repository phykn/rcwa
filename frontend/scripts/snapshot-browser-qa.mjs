// Run with the local API (:8000), Vite dev (:5173), and a separately built
// VITE_STATIC_PREVIEW=true preview (:4173) already running. No API mocks.
// CHROMIUM_PATH=/usr/bin/chromium node scripts/snapshot-browser-qa.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const apiUrl = process.env.RCWA_API_URL || "http://127.0.0.1:8000";
const appUrl = process.env.RCWA_APP_URL || "http://127.0.0.1:5173";
const previewUrl = process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const checks = [];
const pageErrors = [];
let activeJob;
let page;
let browser;

async function request(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(`${apiUrl}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  assert.ok(
    response.ok,
    `${method} ${path}: ${response.status} ${JSON.stringify(data)}`,
  );
  return data;
}

async function widthField(target, value, check = false) {
  await target.locator(".dimension-rail button").first().click();
  if (check)
    await expect(target.locator("#dimension-width")).toHaveValue(value);
  else await target.locator("#dimension-width").fill(value);
  await target.getByRole("button", { name: "Close settings" }).click();
}

async function openSaved() {
  const menu = page.locator(".project-menu");
  if (!(await menu.evaluate((node) => node.open)))
    await menu.locator("summary").click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function exportFile(name) {
  const menu = page.locator(".project-menu");
  if (!(await menu.evaluate((node) => node.open)))
    await menu.locator("summary").click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloading;
  const path = `${output}/${name}`;
  await download.saveAs(path);
  return { path, data: JSON.parse(await fs.readFile(path, "utf8")) };
}

try {
  // Act like an HTTP-only agent: obtain inputs, compute, and save by job ID.
  const project = await request("/example");
  project.name = `Agent snapshot QA ${Date.now()}`;
  project.layers[0].cd_nm = 196;
  let job = await request("/jobs", { kind: "forward", project });
  activeJob = job.id;
  const deadline = Date.now() + 130000;
  let delay = 150;
  while (["queued", "running"].includes(job.status)) {
    assert.ok(Date.now() < deadline, "Forward job exceeded the QA deadline");
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(1000, delay * 1.5);
    job = await request(`/jobs/${encodeURIComponent(job.id)}`);
  }
  assert.equal(job.status, "succeeded", JSON.stringify(job));
  activeJob = undefined;
  const saved = await request("/snapshots", { job_id: job.id });
  assert.equal(saved.provenance.source, "server_computed");
  const snapshot = await request(`/projects/${encodeURIComponent(saved.id)}`);
  assert.deepEqual(snapshot.project, project);
  assert.deepEqual(snapshot.result, job.result);
  assert.ok((await request("/projects")).some((item) => item.id === saved.id));
  checks.push(
    "Real HTTP job produces a server-owned saved snapshot with exact inputs and result",
  );

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
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(appUrl);
  await expect(page.locator(".connection")).toHaveText("Solver connected");
  await openSaved();
  const item = page.locator(".saved-item").filter({ hasText: project.name });
  await expect(item).toContainText("Server-computed");
  await item.click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByLabel("Project name")).toHaveValue(project.name);
  await widthField(page, "196", true);
  await expect(page.locator(".result-badge")).toHaveText("Server-computed");
  await expect(page.locator(".result-badge")).toHaveAttribute(
    "title",
    /does not certify/,
  );
  await expect(page.locator(".spectrum-svg")).toBeVisible();
  await page.screenshot({
    path: `${output}/snapshot-loaded.png`,
    fullPage: true,
  });
  checks.push(
    "Saved-list UI loads the agent snapshot and labels its local server origin without certification",
  );

  await widthField(page, "197");
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  const edited = await exportFile("snapshot-edited-export.json");
  assert.equal(edited.data.project.layers[0].cd_nm, 197);
  assert.deepEqual(edited.data.result_project, snapshot.project);
  assert.deepEqual(edited.data.result, snapshot.result);
  assert.equal(edited.data.provenance, undefined);
  await page.locator("input[type=file]").first().setInputFiles(edited.path);
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  await widthField(page, "196");
  await expect(page.locator(".result-badge")).toHaveText("Unverified import");
  assert.deepEqual(
    await request(`/projects/${encodeURIComponent(saved.id)}`),
    snapshot,
  );
  checks.push(
    "Edits mark output stale; JSON export/reimport preserves exact original result inputs and leaves the saved snapshot unchanged",
  );

  const importName = `Imported snapshot QA ${Date.now()}`;
  const forged = {
    ...snapshot,
    project: { ...snapshot.project, name: importName },
    provenance: { ...snapshot.provenance, source: "server_computed" },
    source: "server_computed",
    resultOrigin: "server",
  };
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "forged-server-source.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(forged)),
    });
  await expect(page.locator(".result-badge")).toHaveText("Unverified import");
  await expect(page.locator(".result-badge")).toHaveAttribute(
    "title",
    /not trusted/,
  );
  checks.push(
    "Importing an exact snapshot copy with forged provenance/origin fields remains an unverified import",
  );

  // Saving client JSON through the compatibility endpoint never promotes it.
  const menu = page.locator(".project-menu");
  if (!(await menu.evaluate((node) => node.open)))
    await menu.locator("summary").click();
  await page.getByLabel("Save project to local server").click();
  await expect(page.getByRole("status")).toContainText("Project saved");
  await openSaved();
  const importedItem = page
    .locator(".saved-item")
    .filter({ hasText: importName });
  await expect(importedItem).toContainText("Unverified import");
  await importedItem.click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".result-badge")).toHaveText("Unverified import");
  await expect(page.locator(".spectrum-svg")).toBeVisible();
  await openSaved();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  checks.push(
    "Compatibility Save/list/reload retains the spectrum as unverified; saved-project dialog still dismisses with Escape",
  );

  for (const width of [360, 390, 1440]) {
    const preview = await browser.newPage({
      viewport: {
        width,
        height: width === 360 ? 800 : width === 390 ? 844 : 1000,
      },
      isMobile: width < 650,
      hasTouch: width < 650,
    });
    preview.on("pageerror", (error) => pageErrors.push(error.message));
    const apiRequests = [];
    preview.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        apiRequests.push(request.url());
    });
    await preview.goto(previewUrl);
    await expect(preview.locator(".connection")).toHaveText("Static preview");
    await expect(preview.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    await expect(
      preview.getByRole("link", { name: "View example spectrum" }),
    ).toHaveAttribute("href", "#spectrum");
    await widthField(preview, "197");
    await expect(preview.locator(".result-badge")).toHaveText("Inputs changed");
    await preview
      .locator("input[type=file]")
      .first()
      .setInputFiles({
        name: "forged-preview-source.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(forged)),
      });
    await expect(preview.locator(".result-badge")).toHaveText(
      "Unverified import",
    );
    await expect(
      preview.getByRole("button", { name: /Run simulation/ }),
    ).toHaveCount(0);
    await expect(
      preview.getByRole("link", { name: "View spectrum", exact: true }),
    ).toHaveAttribute("href", "#spectrum");
    await expect(
      preview.getByRole("link", { name: "View example spectrum" }),
    ).toHaveCount(0);
    await preview.screenshot({
      path: `${output}/snapshot-static-${width}-imported.png`,
      fullPage: true,
    });
    await preview
      .locator("input[type=file]")
      .first()
      .setInputFiles({
        name: "project-only.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ project: forged.project })),
      });
    await expect(
      preview.getByRole("link", { name: "View spectrum", exact: true }),
    ).toHaveAttribute("href", "#spectrum");
    await expect(
      preview.getByRole("link", { name: "View example spectrum" }),
    ).toHaveCount(0);
    await expect(preview.locator(".spectrum-svg")).toHaveCount(0);
    await expect(preview.locator(".empty-spectrum")).toContainText(
      "Import a saved result or choose Project → Reset example.",
    );
    await preview.screenshot({
      path: `${output}/snapshot-static-${width}-empty.png`,
      fullPage: true,
    });
    assert.deepEqual(apiRequests, []);
    await preview.close();
  }
  checks.push(
    "Static mobile preview edits/imports locally with zero API requests and no compute action",
  );

  assert.deepEqual(pageErrors, []);
  const report = {
    status: "passed",
    checks,
    pageErrors,
    snapshotId: saved.id,
    date: new Date().toISOString(),
  };
  await fs.writeFile(
    `${output}/snapshot-browser-qa.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page
    ?.screenshot({
      path: `${output}/snapshot-browser-failure.png`,
      fullPage: true,
    })
    .catch(() => {});
  const report = {
    status: "failed",
    checks,
    pageErrors,
    error: String(error),
    date: new Date().toISOString(),
  };
  await fs.writeFile(
    `${output}/snapshot-browser-qa.json`,
    JSON.stringify(report, null, 2),
  );
  throw error;
} finally {
  if (activeJob)
    await request(
      `/jobs/${encodeURIComponent(activeJob)}`,
      undefined,
      "DELETE",
    ).catch(() => {});
  await browser?.close();
}
