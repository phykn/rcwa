import { legacyExampleUrl } from "./browser-editor-controls.mjs";
// Chromium mobile touch replay. This does not emulate a real phone keyboard.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { enableDragHandles } from "./browser-editor-controls.mjs";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const report = {
  status: "running",
  checks: [],
  screenshots: [],
  scrollStates: [],
  pageErrors: [],
  limitation:
    "Mobile Chromium touch replay; real-phone onscreen keyboard behavior is not verified.",
};
for (const width of [360, 390]) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  try {
    const page = await browser.newPage({
      viewport: { width, height: width === 360 ? 800 : 844 },
      isMobile: true,
      hasTouch: true,
    });
    const apiCalls = [];
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        apiCalls.push(request.url());
    });
    await page.goto(legacyExampleUrl(process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173"));
    await expect(page.locator(".three-canvas")).toHaveAttribute(
      "data-ready",
      "true",
    );
    await expect(page.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    const session = await page.context().newCDPSession(page);
    const dimensions = () =>
      page
        .locator(".dimension-rail button")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-label")),
        );
    const baseline = await dimensions();
    async function swipe(x, y, dx, dy) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
      });
      for (let step = 1; step <= 8; step++)
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            { x: x + (dx * step) / 8, y: y + (dy * step) / 8, id: 1 },
          ],
        });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    }
    async function shot(name) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const filename = `first-use-touch-${width}-${name}.png`;
      if (name.startsWith("eight-")) {
        let state;
        await expect
          .poll(
            async () => {
              state = await page.locator(".stack-rows").evaluate((node) => ({
                scrollLeft: node.scrollLeft,
                clientWidth: node.clientWidth,
                scrollWidth: node.scrollWidth,
                left: !!document
                  .querySelector('[data-testid="layer-scroll-left"]')
                  ?.textContent.trim(),
                right: !!document
                  .querySelector('[data-testid="layer-scroll-right"]')
                  ?.textContent.trim(),
              }));
              return (
                state.left === state.scrollLeft > 1 &&
                state.right ===
                  state.scrollLeft + state.clientWidth < state.scrollWidth - 1
              );
            },
            {
              message: `${name}: settled overflow cues match actual scroll position`,
            },
          )
          .toBe(true);
        report.scrollStates.push({ width, name, ...state });
      }
      await page.screenshot({ path: `${output}/${filename}` });
      report.screenshots.push(filename);
    }
    async function selectedVisible(index) {
      const selected = page.locator(`[data-layer-index="${index}"]`);
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      const chip = await selected.boundingBox(),
        strip = await page.locator(".stack-rows").boundingBox();
      assert.ok(
        chip &&
          strip &&
          chip.x >= strip.x - 1 &&
          chip.x + chip.width <= strip.x + strip.width + 1,
        "Selected chip is fully revealed",
      );
      await expect(page.locator(".scene-selection")).toContainText(
        `Selected: Layer ${index + 1}`,
      );
      await expect(page.locator(".selected-layer-context")).toContainText(
        `Edit Layer ${index + 1}`,
      );
    }
    const canvas = page.locator(".webgl-host canvas");
    const area = await canvas.boundingBox();
    await swipe(area.x + 14, area.y + area.height * 0.65, 0, -140);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(10);
    assert.deepEqual(
      await dimensions(),
      baseline,
      "Vertical touch scroll never changes dimensions",
    );
    await expect(page.locator(".inspector")).not.toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await enableDragHandles(page);
    const handle = page.getByRole("slider", {
      name: "Drag width",
      exact: true,
    });
    const handles = await page.locator(".drag-target").evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect(),
          x = r.x + r.width / 2,
          y = r.y + r.height / 2;
        return {
          width: r.width,
          height: r.height,
          x,
          y,
          name: node.getAttribute("aria-label"),
          hit: document
            .elementFromPoint(x, y)
            ?.closest('[role="slider"]')
            ?.getAttribute("aria-label"),
        };
      }),
    );
    assert.equal(handles.length, 3);
    for (const target of handles)
      assert.ok(
        target.width >= 44 && target.height >= 44 && target.hit === target.name,
        "Every dimension target receives its own touch",
      );
    for (let i = 0; i < handles.length; i++)
      for (let j = i + 1; j < handles.length; j++)
        assert.ok(
          Math.hypot(
            handles[i].x - handles[j].x,
            handles[i].y - handles[j].y,
          ) >= 47.5,
          "Dimension touch targets stay separated",
        );
    const box = await handle.boundingBox();
    await swipe(box.x + box.width / 2, box.y + box.height / 2, 26, 0);
    await expect
      .poll(async () => Number(await handle.getAttribute("aria-valuenow")))
      .toBeGreaterThan(180);
    assert.deepEqual(
      (await dimensions()).slice(1),
      baseline.slice(1),
      "Touch width edit leaves thickness and pitch unchanged",
    );
    await expect(page.locator(".inspector")).not.toBeVisible();
    await shot("width-drag");
    const guide = page.locator(".scene-guide");
    await guide.locator("summary").click();
    await page
      .getByRole("checkbox", { name: "Show drag handles", exact: true })
      .uncheck();
    await guide.locator("summary").click();
    await page.locator(".project-menu > summary").click();
    await page
      .getByRole("button", { name: "Reset example", exact: true })
      .click();
    await expect(page.locator(".layer-scroll-cues")).toHaveCount(0);
    for (let count = 1; count < 8; count++) {
      await page.getByLabel("Add layer", { exact: true }).tap();
      await page
        .getByRole("button", { name: "Add patterned layer", exact: true })
        .tap();
      await selectedVisible(count);
      if (count === 1)
        await expect(page.locator(".layer-scroll-cues")).toHaveCount(0);
    }
    await page.getByRole("button", { name: /Select layer 1:/ }).tap();
    await selectedVisible(0);
    await expect(page.locator(".layer-stack-heading h2")).toContainText("8");
    await expect(page.getByTestId("layer-scroll-right")).toContainText(
      "More layers",
    );
    await shot("eight-start");
    for (
      let swipeCount = 0;
      swipeCount < 8 &&
      (await page.getByTestId("layer-scroll-right").textContent()).trim();
      swipeCount++
    ) {
      const strip = await page.locator(".stack-rows").boundingBox();
      await swipe(
        strip.x + strip.width - 24,
        strip.y + strip.height / 2,
        -(strip.width - 48),
        0,
      );
    }
    await expect(page.getByTestId("layer-scroll-left")).toContainText(
      "More layers",
    );
    await expect(page.getByTestId("layer-scroll-right")).toHaveText("");
    await expect(page.locator(".scene-selection")).toContainText(
      "Selected: Layer 1",
    );
    await page.getByRole("button", { name: /Select layer 8:/ }).tap();
    await selectedVisible(7);
    const add = page.getByLabel("Add layer", { exact: true });
    await expect(add).toContainText("8-layer limit");
    await expect(add).toHaveAttribute("aria-describedby", "layer-limit-reason");
    const addBox = await add.boundingBox();
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        {
          x: addBox.x + addBox.width / 2,
          y: addBox.y + addBox.height / 2,
          id: 1,
        },
      ],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(page.locator(".stack-add")).not.toHaveAttribute("open");
    await add.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".stack-add")).not.toHaveAttribute("open");
    await shot("eight-end");
    await page.keyboard.press("Tab");
    const overflowFocus = page.getByRole("button", { name: /Select layer 7:/ });
    await overflowFocus.focus();
    await expect(overflowFocus).toHaveAttribute("aria-pressed", "false");
    assert.equal(
      await overflowFocus.evaluate(
        (node) => getComputedStyle(node).outlineColor,
      ),
      "rgb(79, 70, 229)",
    );
    assert.equal(
      await overflowFocus.evaluate(
        (node) => getComputedStyle(node).outlineOffset,
      ),
      "-4px",
    );
    await shot("eight-keyboard-focus");

    await page
      .getByRole("button", { name: "Layer settings", exact: true })
      .tap();
    await page.getByLabel("Layer actions", { exact: true }).tap();
    await page
      .getByRole("button", { name: "Remove layer 8", exact: true })
      .tap();
    if (await page.locator(".inspector").isVisible())
      await page
        .getByRole("button", { name: "Close settings", exact: true })
        .tap();
    await expect(add).toContainText("Add layer");
    await expect(add).toHaveAttribute("aria-disabled", "false");
    await add.tap();
    await expect(page.locator(".stack-add")).toHaveAttribute("open");
    await page
      .getByRole("button", { name: "Add patterned layer", exact: true })
      .tap();
    await selectedVisible(7);
    assert.ok(
      await page.evaluate(
        (expected) => document.documentElement.scrollWidth <= expected + 1,
        width,
      ),
      "Mobile page remains within its configured viewport",
    );
    assert.equal(apiCalls.length, 0);
    report.checks.push(
      `${width}px: real touch vertical page scroll, isolated width drag, separate 44px targets, eight-layer horizontal swipe and selected-chip reveal, visible overflow cues, explained Add limit, and restored Add after removing a layer; no API calls`,
    );
  } catch (error) {
    report.status = "failed";
    report.error = String(error.stack || error);
    throw error;
  } finally {
    await browser.close();
    await fs.writeFile(
      `${output}/first-use-touch-qa.json`,
      JSON.stringify(report, null, 2),
    );
  }
}
assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
report.status = "passed";
await fs.writeFile(
  `${output}/first-use-touch-qa.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
