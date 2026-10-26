import { expect, readout, test, waitForEngine, waitUpToDate } from "./fixtures";

test("opens with a calculated example and recalculates edits in the browser", async ({ app: page }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Design name" })).toHaveValue(/circular-air-hole/i);
  await waitUpToDate(page, 30_000);
  const before = await readout(page);
  await waitForEngine(page);

  const diameter = page.getByRole("textbox", { name: "Hole diameter", exact: true });
  await diameter.fill("110");
  await diameter.press("Enter");
  await expect(page.getByText(/Previewing your edit|Calculating \d+ of \d+|Waiting for edits/)).toBeVisible();
  await waitUpToDate(page);
  await expect(page.getByRole("status").filter({ hasText: /^Calculated in [\d.]+ s$/ })).toBeVisible();
  expect(await readout(page)).not.toBe(before);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(diameter).toHaveValue("65");
});

test("dragging a slider previews live, then settles into one full calculation", async ({ app: page }) => {
  await page.goto("/");
  await waitForEngine(page);
  const slider = page.getByRole("slider", { name: "Thickness slider" });
  const box = (await slider.boundingBox())!;
  const thickness = page.getByRole("textbox", { name: "Thickness", exact: true });
  // The slider spans 0–400 nm; 90 nm sits at 22.5% of its width.
  await page.mouse.move(box.x + box.width * 0.225, box.y + box.height / 2);
  await page.mouse.down();
  for (const f of [0.26, 0.3, 0.34, 0.38]) {
    await page.mouse.move(box.x + box.width * f, box.y + box.height / 2, { steps: 4 });
    await page.waitForTimeout(150);
  }
  await expect(page.getByText(/Previewing your edit|Waiting for edits/)).toBeVisible();
  await page.mouse.up();
  await expect(thickness).not.toHaveValue("90");
  await waitUpToDate(page);
  // The whole drag is one undo step.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(thickness).toHaveValue("90");
});

test("examples load and calculate", async ({ app: page }) => {
  await page.goto("/");
  await waitForEngine(page);
  await page.getByRole("button", { name: "Examples" }).click();
  await page.getByRole("button", { name: /Anti-reflection coating/ }).click();
  await expect(page.getByRole("textbox", { name: "Design name" })).toHaveValue(/anti-reflection/i);
  await waitUpToDate(page);
  await expect(page.getByLabel("Values at the inspected wavelength")).toContainText("Reflects as");
});

test("works on a phone-sized screen without sideways scrolling", async ({ app: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const tabs = page.getByRole("navigation", { name: "Workspace sections" });
  await expect(tabs).toBeVisible();
  for (const section of ["Structure", "Edit", "Results"]) {
    await tabs.getByRole("button", { name: section }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, section).toBeLessThanOrEqual(0);
  }
  await expect(page.getByLabel("Values at the inspected wavelength")).toBeVisible();
  await tabs.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("textbox", { name: "Hole diameter", exact: true })).toBeVisible();
});

test("reviews an imported dimension proposal before applying it", async ({ app: page }) => {
  const { readFileSync } = await import("node:fs");
  const cases = JSON.parse(readFileSync(new URL("../../backend/tests/fixtures/dimension-proposals-2d.json", import.meta.url), "utf8"));
  const proposal = cases.find((c: { name: string }) => c.name === "circle").proposal;
  await page.goto("/");
  await page.locator('header input[type="file"]').setInputFiles({
    name: "proposal.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(proposal)),
  });
  const dialog = page.getByRole("dialog", { name: "Review proposed changes" });
  await expect(dialog.getByRole("row")).toHaveCount(4);
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.getByRole("textbox", { name: "Hole diameter", exact: true })).toHaveValue("70");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("textbox", { name: "Hole diameter", exact: true })).toHaveValue("65");
});

test("exports the spectrum chart as SVG and PNG", async ({ app: page }) => {
  await page.goto("/");
  await waitUpToDate(page, 30_000);
  for (const [label, extension] of [["Spectrum chart (.svg)", "svg"], ["Spectrum chart (.png)", "png"]] as const) {
    await page.getByRole("button", { name: "Export" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: label }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(new RegExp(`spectrum\\.${extension}$`));
    const { statSync } = await import("node:fs");
    expect(statSync((await file.path())!).size).toBeGreaterThan(1000);
  }
});

test("shows one spectrum view and a minimal top bar", async ({ app: page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Spectrum" })).toBeVisible();
  const actions = page.getByRole("navigation", { name: "Design actions" }).getByRole("button");
  await expect(actions).toHaveText(["", "", "Examples", "Open", "Export"]);
  await expect(page.getByRole("textbox", { name: "Orders X" })).toHaveCount(0);
});

test("changing the polarization updates the spectrum", async ({ app: page }) => {
  await page.goto("/");
  await waitUpToDate(page, 30_000);
  await waitForEngine(page);
  const before = await readout(page);
  await page.getByRole("radio", { name: "s (TE)" }).click();
  await waitUpToDate(page);
  expect(await readout(page)).not.toBe(before);
});
