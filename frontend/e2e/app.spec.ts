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
  await expect(page.getByRole("status").filter({ hasText: /this browser/ })).toBeVisible();
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

test("sweeps a dimension into a heat map and applies a picked point", async ({ app: page }) => {
  await page.goto("/");
  await waitForEngine(page);
  await page.getByRole("tab", { name: "Sweep" }).click();
  await page.getByRole("combobox").selectOption({ label: "Layer 1 hole diameter" });
  await page.getByRole("textbox", { name: "Steps" }).fill("5");
  await page.getByRole("textbox", { name: "Wavelengths" }).fill("9");
  await page.getByRole("button", { name: "Run sweep" }).click();
  await expect(page.getByText("5 of 5 rows")).toBeVisible({ timeout: 180_000 });
  const map = page.getByRole("img", { name: /Reflectance map/ });
  await expect(map).toBeVisible();
  const box = (await map.boundingBox())!;
  await map.click({ position: { x: box.width * 0.5, y: box.height * 0.1 } });
  await expect(page.getByRole("textbox", { name: "Hole diameter", exact: true })).not.toHaveValue("65");
});

test("maps the field and checks convergence", async ({ app: page }) => {
  await page.goto("/");
  await waitForEngine(page);
  await page.getByRole("tab", { name: "Field" }).click();
  await page.getByRole("button", { name: "Calculate field" }).click();
  await expect(page.getByRole("img", { name: /\|E\|² map/ })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/Peak \|E\|²/)).toBeVisible();

  await page.getByRole("tab", { name: "Convergence" }).click();
  await page.getByRole("button", { name: "Check convergence" }).click();
  await expect(page.getByText(/^(Converged|Not converged)\./)).toBeVisible({ timeout: 180_000 });
});

test("fits a dimension to a measured spectrum", async ({ app: page }) => {
  await page.goto("/");
  await waitForEngine(page);
  await page.getByRole("tab", { name: "Fit" }).click();
  // A synthetic, nearly flat curve: this checks the workflow, not the physics (see backend tests).
  const rows = Array.from({ length: 9 }, (_, i) => `${450 + 50 * i}, ${(0.04 + 0.002 * i).toFixed(3)}`).join("\n");
  await page.getByRole("textbox", { name: /Measured spectrum/ }).fill(rows);
  await expect(page.getByText("9 points")).toBeVisible();
  await page.getByRole("checkbox", { name: /Layer 1 thickness/ }).check();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect(page.getByText(/RMS residual/)).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: "Apply fitted values" }).click();
});

test("share links reproduce the design", async ({ app: page, context }) => {
  await page.goto("/");
  const diameter = page.getByRole("textbox", { name: "Hole diameter", exact: true });
  await diameter.fill("72");
  await diameter.press("Enter");
  await page.getByRole("button", { name: "Share link" }).click();
  await expect(page).toHaveURL(/#d=/);
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByRole("textbox", { name: "Hole diameter", exact: true })).toHaveValue("72");
});

test("examples load and calculate", async ({ app: page }) => {
  await page.goto("/");
  await waitForEngine(page);
  await page.getByRole("button", { name: "Examples" }).click();
  await page.getByRole("button", { name: /Anti-reflection coating/ }).click();
  await expect(page.getByRole("textbox", { name: "Design name" })).toHaveValue(/anti-reflection/i);
  await waitUpToDate(page);
  await expect(page.getByLabel("Values at the inspected wavelength")).toContainText("Reflected color");
});

test("command palette runs commands from the keyboard", async ({ app: page }) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Search commands" }).fill("diffraction");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Orders" })).toHaveAttribute("aria-selected", "true");
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

test("first visit shows the guide", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("dialog", { name: "Build the stack" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Change a dimension" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Build the stack" })).toHaveCount(0);
});
