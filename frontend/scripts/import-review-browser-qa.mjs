/* global window, document, File, requestAnimationFrame, getComputedStyle, innerWidth */
// CI-only browser acceptance for schema-1.2 input-only import review.
// Uses real exports and stored spectra. Only local File.text timing is controlled;
// no numerical response, React state or successful solver output is synthesized.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import {
  closeSheet,
  menuAction,
  applyImportedDesign,
  capture,
} from "./browser-2d-controls.mjs";
import { dimensionProposalBrowserCases } from "./dimension-proposal-browser-cases.mjs";
import { recordNativeModalKeyboard } from "./browser-native-dialog-focus.mjs";

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
const reference = JSON.parse(
  await fs.readFile(
    new URL("../public/reference-circular.json", import.meta.url),
    "utf8",
  ),
);
const rectangle = JSON.parse(
  await fs.readFile(
    new URL("../src/fixtures/default-project-2d.json", import.meta.url),
    "utf8",
  ),
);
const legacy = JSON.parse(
  await fs.readFile(
    new URL("../public/reference-example.json", import.meta.url),
    "utf8",
  ),
);
const report = {
  status: "running",
  groups: [],
  checks: [],
  keyboard: [],
  api: [],
  screenshots: [],
  captures: [],
  artifacts: [],
  pageErrors: [],
  issues: [],
  limitations: [
    "Prepared for CI Chromium. Touch emulation and accessibility-tree checks do not replace real-device, visual or spoken screen-reader review.",
    "No new calculation or numerical-accuracy claim is made by this suite.",
  ],
};
let browser,
  serial = 0;
const review = (page) =>
  page.getByRole("dialog", { name: "Review imported design", exact: true });
const summary = (page) => page.locator(".project-menu > summary");
const diameter = (page) =>
  page.getByRole("button", { name: /^Edit Layer 1 diameter:/ });
const stable = ({ exported_at: _time, ...workspace }) => workspace;
const editedInputs = (diameter = 73, pitchY = 163) => {
  const project = structuredClone(original);
  project.layers[0].diameter_nm = diameter;
  project.period_y_nm = pitchY;
  return project;
};
async function exported(page, name) {
  const pending = page.waitForEvent("download", { timeout: 6000 });
  pending.catch(() => {});
  await menuAction(page, "Export");
  const download = await pending;
  const filename = `import-review-${++serial}-${name}.json`;
  await download.saveAs(`${output}/${filename}`);
  report.artifacts.push(filename);
  return stable(JSON.parse(await fs.readFile(`${output}/${filename}`, "utf8")));
}
async function importFile(page, data, name = "inputs") {
  await page.locator(".project-menu input[type=file]").setInputFiles({
    name: `${name}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(typeof data === "string" ? data : JSON.stringify(data)),
  });
}
async function openReview(page, data, name) {
  await summary(page).focus();
  await importFile(page, data, name);
  const dialog = review(page);
  await expect(dialog).toBeVisible();
  assert.equal(
    await dialog.evaluate(
      (node) => node.tagName === "DIALOG" && node.matches(":modal"),
    ),
    true,
  );
  await expect(
    dialog.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeEnabled();
  return dialog;
}
async function fullInputs(dialog, before, after) {
  const disclosure = dialog.getByText("Full inputs", { exact: true });
  await disclosure.focus();
  await disclosure.press("Enter");
  await expect(dialog.locator(".workflow-details")).toHaveAttribute("open", "");
  assert.deepEqual(
    JSON.parse(await dialog.locator("pre").nth(0).textContent()),
    before,
  );
  assert.deepEqual(
    JSON.parse(await dialog.locator("pre").nth(1).textContent()),
    after,
  );
  await disclosure.press("Enter");
  await expect(dialog.locator(".workflow-details")).not.toHaveAttribute("open");
  await expect(dialog).toBeVisible(); // Enter toggles disclosure; never applies.
}
async function shot(page, name) {
  await capture(page, report, output, name, {
    prefix: "import-review",
    full: false,
    top: false,
  });
}
async function reset(page) {
  await menuAction(page, "Reset example");
  await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
  await expect(page.locator("#project-name")).toHaveValue(original.name);
}
async function editName(page, name) {
  await page.locator("#project-name").fill(name);
  await page.locator("#project-name").blur();
}
async function ready(page, url) {
  await page.goto(url);
  await expect(page.locator(".result-badge")).toHaveText("Precomputed example");
  await page.evaluate(() => document.fonts.ready);
  if (url === appUrl)
    await expect(page.locator(".connection")).toHaveText("Solver connected");
}
async function group(name, width, operation, live = false) {
  const record = { name, width, status: "running", checks: [] };
  report.groups.push(record);
  const context = await browser.newContext({
    viewport: {
      width,
      height: width === 360 ? 800 : width === 390 ? 844 : 1000,
    },
    isMobile: width < 700,
    hasTouch: width < 700,
  });
  await context.addInitScript(() => {
    const originalText = File.prototype.text;
    window.importReviewReads = {};
    File.prototype.text = function () {
      if (!this.name.startsWith("qa-delay-import-"))
        return originalText.call(this);
      return new Promise((resolve, reject) => {
        window.importReviewReads[this.name] = {
          resolve: async () => resolve(await originalText.call(this)),
          reject: () => reject(new Error("Delayed project read failed")),
        };
      });
    };
  });
  const page = await context.newPage(),
    calls = [],
    errors = [];
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      calls.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
      });
  });
  try {
    await ready(page, live ? appUrl : previewUrl);
    await operation(page, record);
    assert.deepEqual(errors, [], "No uncaught browser errors");
    if (live)
      assert.deepEqual(
        calls.filter((call) => call.method !== "GET"),
        [],
        "Import/review/apply/history never submit validation, calculation or saving",
      );
    else
      assert.deepEqual(
        calls,
        [],
        "Static import/review/history makes zero /api requests",
      );
    record.status = "passed";
  } catch (error) {
    record.status = "failed";
    record.error = String(error?.stack || error);
    report.issues.push(`${name}: ${record.error}`);
    await shot(page, `${name}-failure`).catch(() => {});
  } finally {
    report.api.push({ name, calls });
    report.pageErrors.push(...errors.map((message) => ({ name, message })));
    await context.close();
  }
}
async function queue(page, project, name) {
  const filename = `qa-delay-import-${name}`;
  await importFile(page, { project }, filename);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => !!window.importReviewReads[key],
        `${filename}.json`,
      ),
    )
    .toBe(true);
  return `${filename}.json`;
}
async function release(page, filename, reject = false) {
  await page.evaluate(
    async ({ filename, reject }) => {
      await window.importReviewReads[filename][reject ? "reject" : "resolve"]();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    },
    { filename, reject },
  );
}
async function noReview(page) {
  await expect(review(page)).toHaveCount(0);
}
async function assertPreserved(page, baseline, name) {
  assert.deepEqual(
    await exported(page, name),
    baseline,
    "Exact inputs and full displayed spectrum remain unchanged",
  );
}
async function reviewLayout(page, dialog, width) {
  await expect(dialog.locator(".control-note")).toHaveText(
    "Review changes before applying. Existing spectra keep their original inputs.",
  );
  await expect(dialog.locator(".preview-scale-note")).toHaveCount(1);
  await expect(dialog.locator(".preview-scale-note")).toHaveText(
    "X–Z center sections use the same scale; Y extent is not shown. No calculation or server save.",
  );
  // Full-input disclosure checks scroll within the modal. Top evidence must
  // deliberately return to the Current/Proposed cards before capture.
  await dialog.evaluate((node) => { node.scrollTop = 0; });
  await expect(dialog.getByRole("heading", { name: "Current", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("heading", { name: "Proposed", exact: true })).toBeInViewport();
  const layout = await dialog.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const text = [
      ...node.querySelectorAll(
        ".change-list span, .geometry-preview-card dd, .control-note",
      ),
    ];
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      left: box.left,
      right: box.right,
      width: box.width,
      dialogWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      minFont: Math.min(
        ...text.map((element) =>
          parseFloat(getComputedStyle(element).fontSize),
        ),
      ),
      overflowingChanges: [
        ...node.querySelectorAll(".change-list > div"),
      ].filter((element) => element.scrollWidth > element.clientWidth + 1)
        .length,
    };
  });
  assert.ok(
    layout.left >= -1 && layout.right <= width + 1,
    "Dialog fits viewport",
  );
  assert.ok(
    layout.documentWidth <= width + 1 &&
      layout.scrollWidth <= layout.dialogWidth + 1,
    "No page or modal horizontal overflow",
  );
  assert.equal(
    layout.overflowingChanges,
    0,
    "Change summaries wrap without clipping",
  );
  assert.ok(layout.minFont >= 12, "Review text remains at least 12 CSS pixels");
  await shot(page, `${width}-review-top`);
  const client = await page.context().newCDPSession(page);
  try {
    const tree = await client.send("Accessibility.getFullAXTree");
    const dialogNode = tree.nodes.find(
      (node) =>
        !node.ignored &&
        node.role?.value === "dialog" &&
        node.name?.value === "Review imported design",
    );
    assert.ok(
      dialogNode,
      "Named native dialog exists in the accessibility tree",
    );
    for (const label of ["Current", "Proposed"]) {
      assert.ok(
        tree.nodes.some(
          (node) =>
            !node.ignored &&
            node.role?.value === "heading" &&
            node.name?.value === label,
        ),
        `${label} heading is accessible`,
      );
      assert.ok(
        tree.nodes.some(
          (node) =>
            !node.ignored &&
            node.role?.value === "image" &&
            node.name?.value?.startsWith(`${label}:`) &&
            node.name.value.includes("pitch Y"),
        ),
        `${label} geometry includes both pitch axes in its accessible name`,
      );
    }
    const filename = `import-review-${width}-ax.json`;
    await fs.writeFile(
      `${output}/${filename}`,
      JSON.stringify({ layout, nodes: tree.nodes }, null, 2),
    );
    report.artifacts.push(filename);
  } finally {
    await client.detach();
  }
  await dialog
    .getByRole("button", { name: "Apply changes", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    dialog.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeInViewport();
  await shot(page, `${width}-review-actions`);
  await dialog
    .getByRole("button", { name: "Close review imported design", exact: true })
    .focus();
  await recordNativeModalKeyboard(page, dialog, report, width);
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
  for (const width of [360, 390, 1440])
    await group(`acceptance-${width}`, width, async (page, record) => {
      const baseline = await exported(page, `${width}-original`);
      assert.deepEqual(baseline.project, original);
      assert.deepEqual(baseline.result, reference.result);
      // Perform the external-editor step on an actual exported file. Removing the
      // old result produces an input-only design; no result is forged or rebound.
      const external = {
        ...baseline,
        project: structuredClone(baseline.project),
        result: null,
        result_project: null,
      };
      external.project.layers[0].diameter_nm = 73;
      external.project.period_y_nm = 163;
      const externalPath = `${output}/import-review-${width}-external-inputs.json`;
      await fs.writeFile(externalPath, JSON.stringify(external, null, 2));
      report.artifacts.push(externalPath.split("/").at(-1));
      await summary(page).focus();
      await page
        .locator(".project-menu input[type=file]")
        .setInputFiles(externalPath);
      const dialog = review(page);
      await expect(dialog).toBeVisible();
      await expect(page.locator("#project-name")).toHaveValue(original.name);
      await expect(page.locator(".result-badge")).toHaveText(
        "Precomputed example",
      );
      const changes = dialog.locator(".change-list > div");
      await expect(changes).toHaveCount(2);
      await expect(changes.filter({ hasText: "Pitch Y" })).toContainText(
        "140 nm",
      );
      await expect(
        changes.filter({ hasText: "Pitch Y" }).locator("strong"),
      ).toHaveText("163 nm");
      await expect(changes.filter({ hasText: "Diameter" })).toContainText(
        "65 nm",
      );
      await expect(
        changes.filter({ hasText: "Diameter" }).locator("strong"),
      ).toHaveText("73 nm");
      await fullInputs(dialog, original, external.project);
      await reviewLayout(page, dialog, width);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await noReview(page);
      await expect(summary(page)).toBeFocused();
      await assertPreserved(page, baseline, `${width}-cancel`);
      await openReview(page, external, "apply-external-inputs");
      await dialog
        .getByRole("button", { name: "Apply changes", exact: true })
        .evaluate((button) => {
          button.click();
          button.click();
        });
      await noReview(page);
      await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
      const applied = await exported(page, `${width}-applied`);
      assert.deepEqual(applied, { ...baseline, project: external.project });
      await menuAction(page, "↶ Undo");
      await assertPreserved(page, baseline, `${width}-undo`);
      await expect(page.locator(".result-badge")).toHaveText(
        "Precomputed example",
      );
      await menuAction(page, "↷ Redo");
      await assertPreserved(page, applied, `${width}-redo`);
      await menuAction(page, "↶ Undo");
      // Identical imports do not open a review, disturb the result or consume Redo.
      for (const value of [
        original,
        { project: original, result: null, result_project: null },
      ]) {
        await importFile(page, value, "identical-inputs");
        await expect(page.locator(".message.success")).toHaveText(
          /Imported inputs match the current design\. Nothing changed\./,
        );
        await noReview(page);
      }
      await assertPreserved(page, baseline, `${width}-unchanged`);
      await summary(page).click();
      await expect(
        page.getByRole("button", { name: "↶ Undo", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "↷ Redo", exact: true }),
      ).toBeEnabled();
      await summary(page).click();
      record.checks.push(
        "Actual export → external Diameter/Pitch Y edit → input-only import → exact Current/Proposed review → Cancel unchanged → repeated Apply produces one history step → Undo/Redo preserve exact old result and origin; identical imports retain Redo; keyboard, AX and narrow-layout evidence retained",
      );
    });

  await group("exact-materials-dimensions", 390, async (page, record) => {
    const baseline = await exported(page, "material-baseline");
    await page.getByRole("button", { name: /^Select layer 3:/ }).click();
    await page.getByRole("button", { name: "p / TM", exact: true }).click();
    const candidate = editedInputs();
    candidate.layers[0].thickness_nm = 91.125;
    candidate.layers[0].background = {
      name: "Exact tabulated host",
      kind: "tabulated",
      n: 1.7,
      k: 0,
      wavelengths_nm: [400, 650, 900],
      n_values: [1.712345678901234, 1.8, 1.9],
      k_values: [0, 0.00123456789012345, 0.002],
      source: "Synthetic import review fixture",
    };
    candidate.layers[0].material.n = 1.03;
    candidate.illumination.angle_deg = 21.25;
    candidate.illumination.azimuth_deg = 31.75;
    candidate.solver.harmonics_x = 4;
    const dialog = await openReview(
      page,
      { project: candidate },
      "exact-material-inputs",
    );
    for (const text of [
      "Pitch Y",
      "Diameter",
      "Thickness",
      "Host · Optical table",
      "Hole · Refractive index n",
      "Incidence angle",
      "Azimuth angle",
      "Fourier order Hx",
      "3 rows changed (wavelength, n, k)",
    ])
      await expect(dialog.locator(".change-list")).toContainText(text);
    await fullInputs(dialog, original, candidate);
    await shot(page, "390-material-review");
    await applyImportedDesign(page);
    await expect(
      page.getByRole("button", { name: /^Select layer 3:/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "p / TM", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    assert.deepEqual(await exported(page, "exact-material-applied"), {
      ...baseline,
      project: candidate,
    });
    await menuAction(page, "↶ Undo");
    await assertPreserved(page, baseline, "exact-material-undo");
    const rectangular = structuredClone(rectangle);
    rectangular.layers[0].cd_y_nm = 101.125;
    const rectReview = await openReview(
      page,
      rectangular,
      "rectangle-dimensions",
    );
    await expect(rectReview.locator(".change-list")).toContainText(
      "Width X (CD)",
    );
    await expect(rectReview.locator(".change-list")).toContainText(
      "Width Y (CD)",
    );
    await expect(rectReview.locator(".change-list")).toContainText(
      "101.125 nm",
    );
    await fullInputs(rectReview, original, rectangular);
    await page.keyboard.press("Escape");
    await assertPreserved(page, baseline, "rectangular-cancel");
    record.checks.push(
      "Exact table samples, constant hole index, geometry, illumination and harmonic values review and round-trip without rounding; Apply retains selected layer and spectrum polarization; rectangular X/Y width review remains supported",
    );
  });

  await group("dismiss-and-queued-actions", 1440, async (page, record) => {
    const baseline = await exported(page, "dismiss-baseline");
    for (const method of [
      "Escape",
      "close",
      "backdrop",
      "cancel-queued-apply",
    ]) {
      const dialog = await openReview(page, editedInputs(), method);
      if (method === "Escape") await page.keyboard.press("Escape");
      else if (method === "close")
        await dialog
          .getByRole("button", {
            name: "Close review imported design",
            exact: true,
          })
          .click();
      else if (method === "backdrop") {
        const box = await dialog.boundingBox();
        assert.ok(box.x > 1 && box.y > 1, "Desktop backdrop is reachable");
        await page.mouse.click(1, 1);
      } else
        await dialog.evaluate((node) => {
          const buttons = [...node.querySelectorAll("button")];
          const apply = buttons.find(
            (button) => button.textContent.trim() === "Apply changes",
          );
          buttons
            .find((button) => button.textContent.trim() === "Cancel")
            .click();
          apply.click(); // Same event turn: exercise the consumed-review guard.
        });
      await noReview(page);
      await expect(summary(page)).toBeFocused();
      await assertPreserved(page, baseline, `${method}-preserved`);
    }
    // Native modality prevents background interaction; these DOM events model
    // an already-queued editor/layer/history action, without React internals.
    for (const action of [
      "select-layer",
      "reset",
      "edit",
      "undo",
      "inspector",
      "handoff",
    ]) {
      if (action === "undo") await editName(page, "History before review");
      if (action === "handoff")
        await editName(page, "Edited design before handoff");
      const before = await exported(page, `${action}-before`);
      const dialog = await openReview(page, editedInputs(), `queued-${action}`);
      await dialog.evaluate((node, action) => {
        const apply = [...node.querySelectorAll("button")].find(
          (button) => button.textContent.trim() === "Apply changes",
        );
        if (action === "edit") {
          const input = document.querySelector("#project-name");
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          ).set;
          setter.call(input, "Queued newer name");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          const button = [...document.querySelectorAll("button")].find(
            (button) =>
              action === "select-layer"
                ? button
                    .getAttribute("aria-label")
                    ?.startsWith("Select layer 2:")
                : action === "reset"
                  ? button.getAttribute("aria-label") === "Reset example"
                  : action === "inspector"
                    ? button
                        .getAttribute("aria-label")
                        ?.startsWith("Edit Layer 1 diameter:")
                    : button.textContent.trim() ===
                      (action === "handoff"
                        ? "Use this design locally"
                        : "↶ Undo"),
          );
          assertButton(button);
          button.click();
        }
        apply.click();
        function assertButton(button) {
          if (!button) throw new Error(`Missing queued ${action} target`);
        }
      }, action);
      await noReview(page);
      if (action === "inspector") {
        await expect(page.locator("dialog.inspector")).toBeVisible();
        await closeSheet(page);
      }
      if (action === "handoff") {
        const handoff = page.getByRole("dialog", {
          name: "Use this design locally",
          exact: true,
        });
        await expect(handoff).toBeVisible();
        await handoff
          .getByRole("button", { name: "Back to design", exact: true })
          .click();
      }
      const expectedProject =
        action === "edit"
          ? { ...before.project, name: "Queued newer name" }
          : action === "undo"
            ? original
            : before.project;
      await expect(page.locator("#project-name")).toHaveValue(
        expectedProject.name,
      );
      const after = await exported(page, `queued-${action}-preserved`);
      assert.deepEqual(after.project, expectedProject);
      assert.deepEqual(after.result, baseline.result);
      assert.deepEqual(after.result_project, baseline.result_project);
      await reset(page);
    }
    record.checks.push(
      "Escape, close, backdrop and Cancel restore focus with exact workspace unchanged; same-turn Cancel/Apply, selection/Apply, edit/Apply, reset/Apply, Undo/Apply, inspector/Apply and handoff/Apply cannot install stale reviewed inputs",
    );
  });

  await group("delayed-reads-and-newer-imports", 390, async (page, record) => {
    const baseline = await exported(page, "race-baseline");
    for (const action of [
      "edit",
      "selection-away-back",
      "reset",
      "undo",
      "Escape",
      "inspector",
    ]) {
      if (action === "undo") await editName(page, "Edit before pending read");
      const pending = await queue(page, editedInputs(), action);
      if (action === "edit") await editName(page, "Newer current inputs");
      else if (action === "selection-away-back") {
        await page.getByRole("button", { name: /^Select layer 2:/ }).click();
        await page.getByRole("button", { name: /^Select layer 1:/ }).click();
      } else if (action === "reset") await reset(page);
      else if (action === "undo") await menuAction(page, "↶ Undo");
      else if (action === "Escape") await page.keyboard.press("Escape");
      else await diameter(page).click();
      await release(page, pending);
      await noReview(page);
      if (action === "inspector") {
        await expect(page.locator("dialog.inspector")).toBeVisible();
        await closeSheet(page);
      }
      const expected =
        action === "edit"
          ? {
              ...baseline,
              project: { ...original, name: "Newer current inputs" },
            }
          : baseline;
      await assertPreserved(page, expected, `${action}-late-read`);
      await reset(page);
    }
    await editName(page, "Edited design for pending handoff");
    const handoffBaseline = await exported(page, "handoff-pending-baseline");
    const handoffRead = await queue(page, editedInputs(), "handoff-navigation");
    await page
      .getByRole("button", { name: "Use this design locally", exact: true })
      .click();
    const handoff = page.getByRole("dialog", {
      name: "Use this design locally",
      exact: true,
    });
    await expect(handoff).toBeVisible();
    await release(page, handoffRead);
    await noReview(page);
    await expect(handoff).toBeVisible();
    await handoff
      .getByRole("button", { name: "Back to design", exact: true })
      .click();
    await assertPreserved(page, handoffBaseline, "pending-handoff-preserved");
    await reset(page);
    const older = await queue(page, editedInputs(70, 161), "older");
    const newer = await queue(page, editedInputs(76, 166), "newer");
    await release(page, newer);
    await expect(review(page)).toBeVisible();
    await release(page, older);
    await fullInputs(review(page), original, editedInputs(76, 166));
    await applyImportedDesign(page);
    await expect(diameter(page)).toHaveAccessibleName(
      "Edit Layer 1 diameter: 76 nanometers",
    );
    await menuAction(page, "↶ Undo");
    await assertPreserved(page, baseline, "newer-wins-undo");
    // Starting a newer read dismisses an existing review before the read ends.
    await openReview(page, editedInputs(71, 162), "old-open-review");
    const replacement = await queue(page, editedInputs(77, 167), "replacement");
    await noReview(page);
    await release(page, replacement);
    await fullInputs(review(page), original, editedInputs(77, 167));
    await review(page)
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await assertPreserved(page, baseline, "replacement-cancel");
    const oldFailure = await queue(page, editedInputs(), "old-failure");
    await openReview(page, editedInputs(78, 168), "newer-than-failure");
    await release(page, oldFailure, true);
    await expect(page.locator(".message.error")).toHaveCount(0);
    await fullInputs(review(page), original, editedInputs(78, 168));
    await page.keyboard.press("Escape");
    await assertPreserved(page, baseline, "old-failure-preserved");
    const failed = await queue(page, editedInputs(), "latest-failure");
    await release(page, failed, true);
    await expect(page.locator(".message.error")).toContainText(
      "Delayed project read failed",
    );
    await noReview(page);
    await openReview(page, editedInputs(), "retry-after-failure");
    await expect(page.locator(".message.error")).toHaveCount(0);
    await review(page)
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await assertPreserved(page, baseline, "retry-cancel");
    record.checks.push(
      "Delayed reads cannot reopen after edits, selection away/back, reset, history, Escape, inspector or handoff navigation; only the latest import can review/apply; old failures are silent and latest failures support retry",
    );
  });

  await group("invalid-and-oversized-inputs", 390, async (page, record) => {
    const baseline = await exported(page, "rejection-baseline");
    const outOfBounds = editedInputs();
    outOfBounds.layers[0].diameter_nm = 151;
    const invalidTable = editedInputs();
    invalidTable.layers[0].background = {
      ...invalidTable.layers[0].background,
      kind: "tabulated",
      wavelengths_nm: [900, 400],
      n_values: [1.5, 1.6],
      k_values: [0, 0],
    };
    const rawInteger = JSON.stringify(editedInputs()).replace(
      '"harmonics_x":5',
      '"harmonics_x":5.0',
    );
    assert.notEqual(rawInteger, JSON.stringify(editedInputs()));
    const oversized = JSON.stringify({ project: editedInputs() }).padEnd(
      20 * 1024 * 1024 + 1,
      " ",
    );
    for (const [name, data, pattern] of [
      ["malformed", "{", /JSON|Unexpected|property/i],
      ["invalid-diameter", outOfBounds, /diameter|period|Pitch/i],
      ["invalid-table", invalidTable, /increas|wavelength|tabulat/i],
      ["raw-integer-token", rawInteger, /integer|harmonics|token/i],
      ["oversized", oversized, /smaller than 20 MB/],
    ]) {
      // A rejected newer file also consumes the older pending review.
      await openReview(page, editedInputs(), `review-before-${name}`);
      await importFile(page, data, name);
      await expect(page.locator(".message.error")).toContainText(pattern);
      await expect(page.locator(".message.error")).toContainText("remove the result and result_project fields");
      await noReview(page);
      await assertPreserved(page, baseline, `${name}-preserved`);
      await expect(page.locator(".result-badge")).toHaveText(
        "Precomputed example",
      );
    }
    await openReview(page, editedInputs(), "valid-after-rejections");
    await expect(page.locator(".message.error")).toHaveCount(0);
    await review(page)
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await assertPreserved(page, baseline, "valid-retry-after-rejections");
    record.checks.push(
      "Malformed JSON, invalid diameter/table, non-integer raw harmonic token and >20 MiB files are rejected before review or mutation; invalid newer files consume older reviews and valid retry remains available",
    );
  });

  await group("result-and-legacy-contracts", 1440, async (page, record) => {
    const baseline = await exported(page, "compatibility-baseline");
    await importFile(
      page,
      { ...baseline, project: editedInputs() },
      "result-bearing-bundle",
    );
    await expect(page.locator(".message.success")).toContainText(
      "JSON loaded.",
    );
    await noReview(page);
    await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
    assert.deepEqual(await exported(page, "result-bearing-import"), {
      ...baseline,
      project: editedInputs(),
    });
    await menuAction(page, "↶ Undo");
    await assertPreserved(page, baseline, "result-bearing-undo");
    await importFile(
      page,
      { project: original, result: reference.result, result_project: original },
      "unchanged-result-bearing",
    );
    await expect(page.locator(".result-badge")).toHaveText("Unverified import");
    await noReview(page);
    await importFile(page, { project: legacy.project }, "legacy-inputs");
    await expect(page.locator(".message.success")).toContainText(
      "JSON loaded.",
    );
    await expect(page.locator(".result-badge")).toHaveText("No result yet");
    await noReview(page);
    const imported = await exported(page, "legacy-inputs-imported");
    assert.deepEqual(imported.project, legacy.project);
    assert.equal(imported.result, null);
    record.checks.push(
      "Result-bearing 1.2 bundles keep immediate import and unverified provenance; legacy input imports keep their immediate no-result contract; existing proposal suites remain separate",
    );
  });

  await group(
    "live-import-no-mutation-requests",
    1440,
    async (page, record) => {
      const baseline = await exported(page, "live-baseline");
      await openReview(page, editedInputs(), "live-inputs");
      await fullInputs(review(page), original, editedInputs());
      await review(page)
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await assertPreserved(page, baseline, "live-cancel");
      await openReview(page, editedInputs(), "live-apply");
      await applyImportedDesign(page);
      await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
      assert.deepEqual(await exported(page, "live-applied"), {
        ...baseline,
        project: editedInputs(),
      });
      await menuAction(page, "↶ Undo");
      await assertPreserved(page, baseline, "live-undo");
      const pending = await queue(
        page,
        editedInputs(),
        "live-saved-navigation",
      );
      await menuAction(page, "Open");
      const saved = page.getByRole("dialog", {
        name: "Saved projects",
        exact: true,
      });
      await expect(saved).toBeVisible();
      await release(page, pending);
      await noReview(page);
      await expect(saved).toBeVisible();
      await saved
        .getByRole("button", { name: "Close saved projects", exact: true })
        .click();
      await assertPreserved(
        page,
        baseline,
        "pending-saved-navigation-preserved",
      );
      record.checks.push(
        "Connected local app imports/reviews/cancels/applies/undoes exact inputs while preserving the displayed spectrum, without validation, solve, save or other mutation requests",
      );
    },
    true,
  );
  await dimensionProposalBrowserCases({ group, exported, importFile, assertPreserved, shot, menuAction, editName });
  assert.deepEqual(
    report.issues,
    [],
    "Every independent import-review group must pass",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.issues.push(String(error?.stack || error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fs.writeFile(
    `${output}/import-review-browser-qa.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
