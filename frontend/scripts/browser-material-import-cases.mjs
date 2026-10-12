import { legacyExampleUrl } from "./browser-editor-controls.mjs";
// Delays only user-selected material files. No solver responses are synthesized.
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { openMaterial } from "./browser-editor-controls.mjs";

export async function assertMaterialImportOrdering(
  browser,
  url,
  reference,
  output,
  checks,
  liveUrl,
) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      requests.push(request.url());
  });
  await page.addInitScript(() => {
    const original = File.prototype.text;
    window.materialReads = {};
    File.prototype.text = function () {
      if (!this.name.startsWith("qa-delay-")) return original.call(this);
      return new Promise((resolve, reject) => {
        window.materialReads[this.name] = {
          resolve: async () => resolve(await original.call(this)),
          reject: () => reject(new Error("Delayed material read failed")),
        };
      });
    };
  });
  const table = (name) => ({
    name,
    kind: "tabulated",
    n: 2,
    k: 0,
    wavelengths_nm: [200, 2500],
    n_values: [2, 2],
    k_values: [0, 0],
  });
  async function reset() {
    await page.goto(legacyExampleUrl(url));
    // Reload now recovers valid tab inputs. Explicitly reset between unrelated
    // material-ordering scenarios rather than relying on former data loss.
    await page.locator(".project-menu summary").click();
    await page.getByRole("button", { name: "Reset example", exact: true }).click();
    await expect(page.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    await openMaterial(page);
  }
  async function queue(name) {
    const filename = `qa-delay-${name}.json`;
    await page.locator(".material-row input[type=file]").setInputFiles({
      name: filename,
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(table(name))),
    });
    await expect
      .poll(() => page.evaluate((key) => !!window.materialReads[key], filename))
      .toBe(true);
    return filename;
  }
  async function release(filename, reject = false) {
    await page.evaluate(
      async ({ filename, reject }) => {
        await window.materialReads[filename][reject ? "reject" : "resolve"]();
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      },
      { filename, reject },
    );
  }
  const close = () =>
    page.getByRole("button", { name: "Close settings", exact: true }).click();
  const materialName = () =>
    page.getByLabel("Ridge material name", { exact: true });
  try {
    await reset();
    let pending = await queue("newer-edit");
    await page.getByLabel("Ridge n", { exact: true }).fill("3.12");
    await release(pending);
    await expect(page.getByLabel("Ridge n", { exact: true })).toHaveValue(
      "3.12",
    );
    await expect(page.locator(".material-row .inline-error")).toHaveText(
      "Inputs changed while reading. Import the table again.",
    );
    await page.screenshot({
      path: `${output}/material-import-stale-edit.png`,
      fullPage: true,
    });
    checks.push(
      "Delayed n/k import is discarded with retry guidance when a newer material edit changes the workspace",
    );

    await reset();
    pending = await queue("edit-undo");
    const originalN = await page
      .getByLabel("Ridge n", { exact: true })
      .inputValue();
    await page.getByLabel("Ridge n", { exact: true }).fill("3.12");
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .focus();
    await page.keyboard.press("Control+z");
    await expect(page.getByLabel("Ridge n", { exact: true })).toHaveValue(
      originalN,
    );
    await release(pending);
    await expect(page.getByLabel("Ridge n", { exact: true })).toHaveValue(
      originalN,
    );
    await expect(page.locator(".material-row .inline-error")).toContainText(
      "Inputs changed while reading",
    );
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .focus();
    await page.keyboard.press("Control+Shift+z");
    await expect(page.getByLabel("Ridge n", { exact: true })).toHaveValue(
      "3.12",
    );
    checks.push(
      "Edit then Undo does not reactivate a pending n/k import even when the original input values return and Redo is preserved",
    );

    await reset();
    const first = await queue("older-file"),
      second = await queue("newer-file");
    await release(second);
    await expect(materialName()).toHaveValue("newer-file");
    await release(first);
    await expect(materialName()).toHaveValue("newer-file");
    await expect(page.locator(".material-row .inline-error")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .focus();
    await page.keyboard.press("Control+z");
    await expect(materialName()).toHaveValue(
      reference.project.layers[0].material.name,
    );
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .focus();
    await page.keyboard.press("Control+Shift+z");
    await expect(materialName()).toHaveValue("newer-file");
    checks.push(
      "Only the latest material file can apply; an older completion cannot overwrite it, and the accepted import is one Undo/Redo step",
    );

    await reset();
    pending = await queue("closed-editor");
    await close();
    await page.locator(".dimension-rail button").first().click();
    await page.locator("#dimension-width").fill("230");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByLabel("Project name", { exact: true })
      .fill("Newer project edit");
    await release(pending);
    await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
      "Newer project edit",
    );
    await expect(page.locator(".dimension-rail button").first()).toContainText(
      "230",
    );
    await openMaterial(page);
    await expect(materialName()).toHaveValue(
      reference.project.layers[0].material.name,
    );
    checks.push(
      "Closing the material editor invalidates a pending read; its completion preserves newer geometry and project-name edits",
    );

    for (const dismissal of ["Escape", "backdrop"]) {
      await reset();
      pending = await queue(`dismiss-${dismissal}`);
      if (dismissal === "Escape") await page.keyboard.press("Escape");
      else await page.mouse.click(2, 2);
      await expect(page.locator(".inspector")).not.toBeVisible();
      await release(pending);
      await openMaterial(page);
      await expect(materialName()).toHaveValue(
        reference.project.layers[0].material.name,
      );
    }
    await reset();
    pending = await queue("target-switch");
    await page
      .locator(".material-tabs")
      .getByRole("button", { name: "Groove", exact: true })
      .click();
    await release(pending);
    await expect(
      page.getByLabel("Groove material name", { exact: true }),
    ).toHaveValue(reference.project.layers[0].background.name);
    await page
      .locator(".material-tabs")
      .getByRole("button", { name: "Ridge", exact: true })
      .click();
    await expect(materialName()).toHaveValue(
      reference.project.layers[0].material.name,
    );
    checks.push(
      "Escape, backdrop dismissal and changing the material target each invalidate the old read without applying it to either material",
    );

    await reset();
    pending = await queue("project-switch");
    await close();
    const next = structuredClone(reference.project);
    next.name = "Replacement workspace";
    next.layers[0].cd_nm = 220;
    next.layers[0].material.name = "Replacement material";
    await page
      .locator("input[type=file]")
      .first()
      .setInputFiles({
        name: "replacement-project.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ project: next })),
      });
    await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
      next.name,
    );
    await release(pending);
    await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
      next.name,
    );
    await expect(page.locator(".dimension-rail button").first()).toContainText(
      "220",
    );
    await openMaterial(page);
    await expect(materialName()).toHaveValue("Replacement material");
    checks.push(
      "A delayed old material read cannot change a newly imported project or attach its old spectrum",
    );

    await reset();
    pending = await queue("reset-example");
    await close();
    await page.locator(".project-menu > summary").click();
    await page
      .getByRole("button", { name: "Reset example", exact: true })
      .click();
    await expect(page.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    await release(pending);
    await expect(page.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    await openMaterial(page);
    await expect(materialName()).toHaveValue(
      reference.project.layers[0].material.name,
    );
    checks.push(
      "Reset example keeps its exact reference state when an old, closed material read completes",
    );

    await reset();
    const failed = await queue("old-failure"),
      latest = await queue("latest-after-failure");
    await release(latest);
    await release(failed, true);
    await expect(materialName()).toHaveValue("latest-after-failure");
    await expect(page.locator(".material-row .inline-error")).toHaveCount(0);
    await reset();
    pending = await queue("latest-failure");
    await release(pending, true);
    await expect(page.locator(".material-row .inline-error")).toContainText(
      "Delayed material read failed",
    );
    pending = await queue("retry-success");
    await release(pending);
    await expect(materialName()).toHaveValue("retry-success");
    await expect(page.locator(".material-row .inline-error")).toHaveCount(0);
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    checks.push(
      "A superseded failed read cannot replace the latest material or show an obsolete error; material ordering checks make zero API calls",
    );
    // A real bounded forward job must still finish and unlock after an old read.
    await page.goto(legacyExampleUrl(liveUrl));
    await expect(page.locator(".connection")).toHaveText("Solver connected");
    const runProject = structuredClone(reference.project);
    runProject.illumination.wavelengths_nm = [511, 623, 739];
    runProject.solver.harmonics = 3;
    await page
      .locator("input[type=file]")
      .first()
      .setInputFiles({
        name: "material-run-inputs.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ project: runProject })),
      });
    await openMaterial(page);
    pending = await queue("before-new-run");
    await close();
    await page.getByRole("button", { name: /Run simulation/ }).click();
    await release(pending);
    await expect(page.locator(".message.success")).toContainText(
      "Calculation complete",
      { timeout: 120000 },
    );
    await expect(
      page.getByRole("button", { name: /Run simulation/ }),
    ).toBeEnabled();
    await expect(page.locator(".spectrum-svg")).toBeVisible();
    await openMaterial(page);
    await expect(materialName()).toHaveValue(
      runProject.layers[0].material.name,
    );
    assert.deepEqual(errors, []);
    checks.push(
      "A later real three-wavelength forward job reaches completion and unlocks normally after an abandoned material read resolves; its input material is unchanged",
    );
  } catch (error) {
    await page
      .screenshot({
        path: `${output}/material-import-failure.png`,
        fullPage: true,
      })
      .catch(() => {});
    throw error;
  } finally {
    await page.close();
  }
}
