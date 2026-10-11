// Prototype-only discovery evidence; this does not certify full application wiring.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const original = JSON.parse(await fs.readFile(new URL("../src/fixtures/default-project-2d.json", import.meta.url), "utf8"));
const report = { status: "running", checks: [], screenshots: [], captures: [], pageErrors: [], issues: [], limitation: "Isolated interactive prototype with the exact approved geometry and stored result. Full lifecycle wiring and real-phone keyboard use are not tested here." };
const url = process.env.RCWA_PROTOTYPE_URL || "http://127.0.0.1:5173/prototype-2d.html";
for (const width of [360, 390, 1440]) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const height = width === 360 ? 800 : width === 390 ? 844 : 1000;
    const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 700, hasTouch: width < 700 });
    const apiCalls = [];
    page.on("pageerror", (e) => report.pageErrors.push({ width, error: e.message }));
    page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/")) apiCalls.push(r.url()); });
    await page.goto(url);
    await expect(page.locator(".p2-webgl canvas")).toHaveAttribute("data-ready", "true");
    await expect(page.locator(".p2-reference")).toHaveText("Precomputed example");
    await page.evaluate(() => document.fonts.ready);
    const project = () => page.locator(".p2").evaluate((e) => JSON.parse(e.dataset.project));
    const history = () => page.locator(".p2").getAttribute("data-history-count");
    async function shot(name) {
      await page.evaluate(() => window.scrollTo(0, 0));
      for (const fullPage of [false, true]) {
        const filename = `prototype-2d-${width}-${name}${fullPage ? "" : "-viewport"}.png`;
        const capture = { filename, attempts: [] }; report.captures.push(capture);
        for (let attempt = 1; attempt <= 2; attempt++) {
          try { await page.screenshot({ path: `${output}/${filename}`, fullPage, timeout: 10000 }); capture.attempts.push({ attempt, status: "passed" }); break; }
          catch (error) { capture.attempts.push({ attempt, status: "failed", error: String(error) }); if (attempt === 2) throw error; }
        }
        report.screenshots.push(filename);
      }
    }
    await shot("initial-cutaway");
    assert.deepEqual(await project(), original);
    assert.equal(await history(), "0");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const cta = await page.locator(".p2-primary").boundingBox();
    assert.ok(cta && cta.y + cta.height <= height, `Complete primary action must fit at${width}px: ${JSON.stringify(cta)}`);
    for (const chip of await page.locator(".p2-layers button").all()) {
      const box = await chip.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.height >= 44);
    }
    // Whole object and object-fixed axes fit outside overlay insets.
    const scene = await page.locator(".p2-scene").boundingBox();
    const projected = JSON.parse(await page.locator(".p2-webgl canvas").getAttribute("data-projected-bounds"));
    assert.ok(scene && projected.left >= 17 && projected.right <= scene.width - 17 && projected.top >= 49 && projected.bottom <= scene.height - 31, JSON.stringify({scene,projected}));
    for (const axis of await page.locator(".p2-projected-axis").all()) {
      const box = await axis.boundingBox(); assert.ok(box && box.x > scene.x && box.x + box.width < scene.x + scene.width && box.y > scene.y + 44 && box.y + box.height < scene.y + scene.height - 24);
    }
    // Guide is an accessible bounded scroll region, never clipped by the scene.
    await page.getByLabel("View guide", { exact: true }).click();
    const guide = page.getByRole("region", { name: "View guide details" });
    const guideBox = await guide.boundingBox(); assert.ok(guideBox && guideBox.y + guideBox.height <= scene.y + scene.height - 4);
    await shot("view-guide");
    await guide.focus(); await page.keyboard.press("End");
    await expect.poll(() => guide.evaluate(n => n.scrollTop + n.clientHeight >= n.scrollHeight - 1)).toBe(true);
    await shot("view-guide-end");
    await page.keyboard.press("Escape");
    await expect(guide).toBeHidden();
    await page.getByRole("combobox", { name: "Structure view" }).selectOption("full");
    await expect(page.locator(".p2-webgl canvas")).toHaveAttribute("data-cutaway", "false");
    assert.deepEqual(await project(), original); assert.equal(await history(), "0");
    await shot("full-stack");
    await page.getByRole("combobox", { name: "Structure view" }).selectOption("cutaway");
    await page.getByRole("button", { name: /Select layer 3:/ }).click();
    await expect(page.locator(".p2-selection")).toContainText("Selected: Layer 3");
    assert.deepEqual(await project(), original); assert.equal(await history(), "0");
    await shot("bottom-selected");
    await page.getByRole("button", { name: /^Edit Layer 3 width:/ }).click();
    await expect(page.getByRole("dialog")).toHaveAttribute("aria-label", "Layer 3 · Width");
    await expect(page.getByRole("spinbutton", { name: "Width X nm" })).toHaveValue("95");
    const widthY = page.getByRole("spinbutton", { name: "Width Y nm" });
    await widthY.focus(); await shot("width-y");
    await widthY.fill("90"); await page.getByRole("button", { name: "Done", exact: true }).click();
    const changed = structuredClone(original); changed.layers[2].cd_y_nm = 90;
    assert.deepEqual(await project(), changed); assert.equal(await history(), "1");
    await expect(page.getByRole("button", { name: /^Edit Layer 3 width:/ })).toBeFocused();
    await page.getByRole("button", { name: /^Edit shared pitch:/ }).click();
    const pitchY = page.getByRole("spinbutton", { name: "Pitch Y nm" });
    await pitchY.focus(); await shot("shared-pitch-y");
    await pitchY.fill("160"); await page.getByRole("button", { name: "Done", exact: true }).click();
    changed.period_y_nm = 160;
    assert.deepEqual(await project(), changed); assert.equal(await history(), "2");
    await page.getByRole("button", { name: /^Edit shared pitch:/ }).click();
    await pitchY.fill("89"); await expect(pitchY).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert")).toHaveText("Pitch Y must be at least 90 nm because of Layer 3. 89 is not applied. Keeping 160 nm.");
    await shot("invalid-pitch-y");
    await page.keyboard.press("Escape");
    assert.deepEqual(await project(), changed); assert.equal(await history(), "2");
    await expect(page.getByRole("button", { name: /^Edit shared pitch:/ })).toBeFocused();
    await page.locator(".project-menu summary").click();
    await page.getByRole("button", { name: "↶ Undo", exact: true }).click();
    changed.period_y_nm = 140; assert.deepEqual(await project(), changed);
    await page.getByRole("button", { name: "↶ Undo", exact: true }).click();
    assert.deepEqual(await project(), original);
    await page.getByRole("button", { name: "↷ Redo", exact: true }).click();
    await page.getByRole("button", { name: "↷ Redo", exact: true }).click();
    changed.period_y_nm = 160; assert.deepEqual(await project(), changed);
    await page.locator(".project-menu summary").click();
    await shot("edited");
    await page.getByRole("link", { name: "View example spectrum" }).click();
    await expect(page.locator(".p2-stale-note")).toHaveText("This stored spectrum no longer matches your inputs.");
    await page.locator("#spectrum").screenshot({ path: `${output}/prototype-2d-${width}-stale-spectrum.png` });
    report.screenshots.push(`prototype-2d-${width}-stale-spectrum.png`);
    assert.equal(apiCalls.length, 0);
    report.checks.push(`${width}px: exact approved default, physical full/cut view identity, all3chips/CTA fit, bottom Y-only edit isolation, shared Y bounds, invalid dismissal, focus return, one-step Undo/Redo, truthful stored spectrum and zero API calls`);
  } catch (error) { report.issues.push({ width, error: String(error) }); }
  finally { await browser.close(); }
}
report.status = report.issues.length || report.pageErrors.length ? "failed" : "passed";
await fs.writeFile(`${output}/prototype-2d-browser-qa.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, checks: report.checks, issues: report.issues, pageErrors: report.pageErrors }));
if (report.status !== "passed") process.exitCode = 1;
