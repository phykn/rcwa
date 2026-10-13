/* global document, window, crypto, requestAnimationFrame */
// Runs only inside the existing CI browser suite. These are real backend-created
// input proposals and the original stored spectrum, never synthesized results.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { expect } from "@playwright/test";

const fixtures = JSON.parse(await fs.readFile(new URL("../src/fixtures/dimension-proposals-2d.json", import.meta.url), "utf8"));
const proposal = (name = "circle") => structuredClone(fixtures.find((entry) => entry.name === name).proposal);
const review = (page) => page.getByRole("dialog", { name: "Review 2D dimension changes", exact: true });
const apply = (page) => review(page).getByRole("button", { name: "Apply changes", exact: true });
const cancel = (page) => review(page).getByRole("button", { name: "Cancel", exact: true });

export async function dimensionProposalBrowserCases({ group, exported, importFile, assertPreserved, shot, menuAction, editName }) {
  for (const width of [360, 390, 1440]) await group(`dimension-proposal-${width}`, width, async (page, record) => {
    const baseline = await exported(page, `proposal-${width}-baseline`);
    const value = proposal();
    assert.deepEqual(value.base_project, baseline.project);
    await page.getByRole("button", { name: /^Select layer 3:/ }).click();
    await page.getByRole("button", { name: "p / TM", exact: true }).click();
    await importFile(page, value, "dimension-proposal");
    await expect(review(page)).toBeVisible();
    await expect(apply(page)).toBeEnabled();
    await expect(review(page).locator(".control-note")).toContainText("Imported numerical claims are unverified");
    await expect(review(page).locator(".change-list > div")).toHaveCount(3);
    const layout = await review(page).evaluate((node) => ({
      client: node.clientWidth, scroll: node.scrollWidth,
      left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
      document: document.documentElement.scrollWidth,
    }));
    assert.ok(layout.left >= -1 && layout.right <= width + 1 && layout.document <= width + 1 && layout.scroll <= layout.client + 1);
    await shot(page, `proposal-${width}-review`);
    await cancel(page).click();
    await expect(review(page)).toHaveCount(0);
    await assertPreserved(page, baseline, `proposal-${width}-cancel`);
    await importFile(page, value, "dimension-proposal-apply");
    await expect(apply(page)).toBeEnabled();
    await apply(page).evaluate((button) => { button.click(); button.click(); });
    await expect(review(page)).toHaveCount(0);
    await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
    await expect(page.getByRole("button", { name: /^Select layer 3:/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "p / TM", exact: true })).toHaveAttribute("aria-pressed", "true");
    const applied = await exported(page, `proposal-${width}-applied`);
    assert.deepEqual(applied, { ...baseline, project: value.candidate_project });
    await menuAction(page, "↶ Undo");
    await assertPreserved(page, baseline, `proposal-${width}-undo`);
    await menuAction(page, "↷ Redo");
    await assertPreserved(page, applied, `proposal-${width}-redo`);
    await menuAction(page, "↶ Undo");
    await importFile(page, proposal("noop"), "dimension-proposal-noop");
    await expect(apply(page)).toBeDisabled();
    await expect(review(page)).toContainText("contains no changes");
    await cancel(page).click();
    await assertPreserved(page, baseline, `proposal-${width}-noop`);
    await page.locator(".project-menu > summary").click();
    await expect(page.getByRole("button", { name: "↶ Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "↷ Redo", exact: true })).toBeEnabled();
    record.checks.push("Exact-base 1.2 proposal reviews three dimensions, fits viewport, Cancel is unchanged, repeated Apply is one undo step, Undo/Redo preserve exact original spectrum, selection and polarization; no-op retains Redo.");
  });

  await group("dimension-proposal-stale-invalid", 1440, async (page, record) => {
    const baseline = await exported(page, "proposal-guard-baseline");
    await editName(page, "Newer exact base");
    const newer = await exported(page, "proposal-newer-base");
    await importFile(page, proposal(), "outdated-base");
    await expect(apply(page)).toBeDisabled();
    await expect(review(page)).toContainText("made for different inputs");
    await cancel(page).click();
    await assertPreserved(page, newer, "proposal-outdated-preserved");
    await menuAction(page, "↶ Undo");
    const reportedFailure = proposal("numerical-failure");
    reportedFailure.diagnostics.forEach((d) => { d.message = "FORGED NUMERICAL CLAIM MUST NOT BE DISPLAYED"; });
    await importFile(page, reportedFailure, "reported-failure");
    await expect(apply(page)).toBeDisabled();
    await expect(review(page)).toContainText("This file reports validation errors");
    await expect(review(page)).not.toContainText("FORGED NUMERICAL");
    await cancel(page).click();
    for (const [name, mutate] of [
      ["wrong-hash", (p) => { p.candidate_input_hash = "0".repeat(64); }],
      ["extra-input-edit", (p) => { p.candidate_project.ambient.n = 1.01; }],
      ["forged-diff", (p) => { p.diff.pop(); }],
      ["inconsistent-valid", (p) => { p.valid = false; }],
    ]) {
      const bad = proposal(); mutate(bad);
      await importFile(page, bad, name);
      await expect(page.locator(".message.error")).toContainText(/2D dimension proposal/);
      await expect(page.locator(".message.error")).not.toContainText("remove the result and result_project fields");
      await expect(review(page)).toHaveCount(0);
      await assertPreserved(page, baseline, `${name}-preserved`);
    }
    for (const action of ["cancel", "select-layer"]) {
      await importFile(page, proposal(), `proposal-queued-${action}`);
      await expect(apply(page)).toBeEnabled();
      await review(page).evaluate((node, action) => {
        const button = [...node.querySelectorAll("button")].find((b) => b.textContent.trim() === "Apply changes");
        if (action === "cancel") [...node.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel").click();
        else document.querySelector('button[aria-label^="Select layer 2:"]').click();
        button.click();
      }, action);
      await expect(review(page)).toHaveCount(0);
      await assertPreserved(page, baseline, `proposal-queued-${action}-preserved`);
    }
    record.checks.push("Stale exact base, forged candidate/hash/diff and inconsistent validity reject; imported scientific failure text is never trusted or echoed; queued Apply after Cancel/selection cannot mutate.");
  });

  await group("dimension-proposal-late-hash", 1440, async (page, record) => {
    const baseline = await exported(page, "proposal-hash-baseline");
    // Delay only genuine SHA-256 completion, not results or successful solver data.
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      window.proposalHashWaits = [];
      window.proposalHashDelay = true;
      crypto.subtle.digest = async (...args) => {
        const output = await digest(...args);
        if (!window.proposalHashDelay) return output;
        return new Promise((resolve) => window.proposalHashWaits.push(() => resolve(output)));
      };
    });
    async function hold(value = proposal()) {
      await page.evaluate(() => { window.proposalHashDelay = true; window.proposalHashWaits = []; });
      await importFile(page, value, "late-proposal-hash");
      await expect.poll(() => page.evaluate(() => window.proposalHashWaits.length)).toBe(2);
    }
    async function release() {
      await page.evaluate(async () => {
        window.proposalHashDelay = false;
        window.proposalHashWaits.forEach((finish) => finish());
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
    }
    await hold();
    await page.keyboard.press("Escape");
    await release();
    await expect(review(page)).toHaveCount(0);
    await assertPreserved(page, baseline, "proposal-hash-escape");
    const invalidLate = proposal(); invalidLate.candidate_input_hash = "0".repeat(64);
    await hold(invalidLate);
    await page.keyboard.press("Escape");
    await release();
    await expect(review(page)).toHaveCount(0);
    await expect(page.locator(".message.error")).toHaveCount(0);
    await assertPreserved(page, baseline, "proposal-late-invalid-hash-escape");
    await hold();
    await editName(page, "Newer edit during hash");
    const newer = await exported(page, "proposal-hash-newer");
    await release();
    await expect(review(page)).toHaveCount(0);
    await assertPreserved(page, newer, "proposal-hash-edit");
    await menuAction(page, "↶ Undo");
    await hold();
    await page.evaluate(() => { window.proposalHashDelay = false; });
    await importFile(page, {project:proposal().candidate_project}, "newer-ordinary-input");
    const ordinary = page.getByRole("dialog", {name:"Review imported design",exact:true});
    await expect(ordinary).toBeVisible();
    await release();
    await expect(review(page)).toHaveCount(0);
    await expect(ordinary).toBeVisible();
    await ordinary.getByRole("button", {name:"Cancel",exact:true}).click();
    await assertPreserved(page, baseline, "proposal-newer-ordinary-review");
    record.checks.push("Genuine SHA-256 responses arriving after Escape, input edit, or newer ordinary import cannot install or replace a review; all workspace/result state is preserved.");
  });

  await group("dimension-proposal-live-no-mutation", 1440, async (page, record) => {
    const baseline = await exported(page, "proposal-live-baseline");
    await importFile(page, proposal(), "live-dimension-proposal");
    await expect(apply(page)).toBeEnabled();
    await apply(page).click();
    await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
    assert.deepEqual(await exported(page,"proposal-live-applied"),{...baseline,project:proposal().candidate_project});
    await menuAction(page,"↶ Undo");
    await assertPreserved(page,baseline,"proposal-live-undo");
    record.checks.push("Connected local editor reviews/applies/undoes proposal without any validation/solver/save mutation request.");
  }, true);
}
