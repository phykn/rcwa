// Reuse snapshot-browser-qa's already computed exact server snapshot and API.
// The 100 additional rows contain inputs only: no new solver jobs or backend API.
import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function verifySavedRecovery({
  page,
  request,
  openSaved,
  exportFile,
  saved,
  snapshot,
  output,
  checks,
}) {
  const filler = structuredClone(snapshot.project);
  filler.name = `Recent saved-copy recovery QA ${Date.now()}`;
  let newest;
  for (let i = 0; i < 100; i += 1)
    newest = await request("/projects", { project: filler });
  const indexBefore = await request("/projects?view=index");
  assert.equal(indexBefore.limit, 100);
  assert.equal(indexBefore.snapshots.length, 100);
  assert.equal(indexBefore.may_have_more, true);
  assert.ok(!indexBefore.snapshots.some((item) => item.id === saved.id));
  const baseline = (await exportFile("snapshot-recovery-before.json")).data;
  const calls = [];
  const observe = (req) => {
    if (new URL(req.url()).pathname.startsWith("/api/"))
      calls.push({ method: req.method(), path: new URL(req.url()).pathname });
  };
  page.on("request", observe);
  const dialog = page.getByRole("dialog", {
    name: "Saved projects",
    exact: true,
  });
  const field = dialog.getByRole("textbox", {
    name: "Open by snapshot ID",
    exact: true,
  });
  async function submit(id) {
    await field.fill(id);
    await field.press("Enter");
  }
  async function exactExport(expected, suffix) {
    await expect(dialog).not.toBeVisible();
    assert.deepEqual(
      (await exportFile(`snapshot-recovery-${suffix}.json`)).data,
      expected,
    );
  }
  try {
    await openSaved();
    await expect(dialog.locator(".saved-item")).toHaveCount(100);
    await expect(dialog.locator(".saved-window-note")).toContainText(
      "Older copies may exist",
    );
    const readsBefore = calls.length;
    for (const id of ["", "../invalid", "x".repeat(101)]) {
      await submit(id);
      await expect(dialog.getByRole("alert")).toContainText(
        "Enter a snapshot ID",
      );
    }
    assert.equal(calls.length, readsBefore, "Invalid IDs do not reach the API");
    await submit("missing-saved-recovery-qa");
    await expect(dialog.getByRole("alert")).toContainText(
      "No saved project has this snapshot ID",
    );
    await page.keyboard.press("Escape");
    await exactExport(baseline, "after-invalid");

    await openSaved();
    await submit(`  ${saved.id}  `);
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".result-badge")).toHaveText("Server-computed");
    const loaded = (await exportFile("snapshot-recovery-old-exact.json")).data;
    assert.deepEqual(loaded.project, snapshot.project);
    assert.deepEqual(loaded.result_project, snapshot.project);
    assert.deepEqual(loaded.result, snapshot.result);
    assert.equal(
      loaded.provenance,
      undefined,
      "File export cannot confer server trust",
    );
    checks.push(
      "An exact known ID outside the real latest-100 window reopens its original inputs/result; invalid and missing IDs preserve the whole workspace without writes",
    );

    // Delay delivery of a genuine full server response, then dismiss it and
    // open a newer ID. No response payload or success state is fabricated.
    let release, started;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetched = new Promise((resolve) => {
      started = resolve;
    });
    const path = `**/api/projects/${saved.id}`;
    await page.route(path, async (route) => {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    });
    try {
      await openSaved();
      await submit(saved.id);
      await Promise.race([
        fetched,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Delayed recovery request did not start")),
            10000,
          ),
        ),
      ]);
      await expect(field).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: "Opening…", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await exactExport(loaded, "dismissed");
      await openSaved();
      await submit(newest.id);
      await expect(dialog).not.toBeVisible();
      await expect(page.getByLabel("Project name")).toHaveValue(filler.name);
      const newer = (await exportFile("snapshot-recovery-newer.json")).data;
      const late = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/projects/${saved.id}`,
      );
      release();
      await late;
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await exactExport(newer, "after-late");
    } finally {
      release();
      await page.unroute(path);
    }
    checks.push(
      "Closing a pending exact-ID load and opening a newer saved copy ignores the genuine late server response",
    );

    for (const width of [360, 390, 1440]) {
      await page.setViewportSize({
        width,
        height: width === 360 ? 800 : width === 390 ? 844 : 1000,
      });
      await openSaved();
      await expect(dialog.locator(".saved-item")).toHaveCount(100);
      await field.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(
        dialog.getByRole("button", {
          name: "Close saved projects",
          exact: true,
        }),
      ).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(
        dialog.getByRole("button", { name: "Close", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        dialog.getByRole("button", {
          name: "Close saved projects",
          exact: true,
        }),
      ).toBeFocused();
      const firstIdentity = dialog.locator(".saved-identity").first();
      await firstIdentity.locator("summary").click();
      const disclosedId = firstIdentity.getByRole("textbox");
      await expect(disclosedId).toHaveValue(indexBefore.snapshots[0].id);
      await disclosedId.click();
      assert.deepEqual(
        await disclosedId.evaluate((node) => [
          node.selectionStart,
          node.selectionEnd,
        ]),
        [0, indexBefore.snapshots[0].id.length],
      );
      await field.fill(saved.id);
      await field.scrollIntoViewIfNeeded();
      assert.ok(
        await dialog.evaluate(
          (node) => node.scrollWidth <= node.clientWidth + 1,
        ),
        `No dialog overflow at ${width}px`,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `No page overflow at ${width}px`,
      );
      await page.screenshot({
        path: `${output}/snapshot-recovery-${width}.png`,
        fullPage: true,
      });
      await field.press("Enter");
      await expect(dialog).not.toBeVisible();
      await expect(page.locator(".result-badge")).toHaveText("Server-computed");
    }
    checks.push(
      "Saved recovery supports Enter, Escape and trapped keyboard focus at 360/390/1440px; each layout retains a rendered screenshot with no horizontal overflow",
    );
    assert.deepEqual(await request(`/projects/${saved.id}`), snapshot);
    assert.deepEqual(await request("/projects?view=index"), indexBefore);
    assert.ok(
      calls.every((call) => call.method === "GET"),
      JSON.stringify(calls),
    );
  } finally {
    page.off("request", observe);
  }
}
