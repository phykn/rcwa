import { legacyExampleUrl } from "./browser-editor-controls.mjs";
// A first-use task check against the genuine static reference, never fake recomputation.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const report = { screenshots: [], checks: [], pageErrors: [], issues: [] };
const url = process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173";
const reference = JSON.parse(
  await fs.readFile(
    new URL("../public/reference-example.json", import.meta.url),
    "utf8",
  ),
);
for (const width of [360, 390, 1440]) {
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
      isMobile: width < 650,
      hasTouch: width < 650,
      viewport: {
        width,
        height: width === 360 ? 800 : width === 390 ? 844 : 1000,
      },
    });
    const apiCalls = [];
    page.on("pageerror", (e) => report.pageErrors.push(e.message));
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.startsWith("/api/"))
        apiCalls.push(req.url());
    });
    await page.goto(legacyExampleUrl(url));
    await expect(page.locator(".three-canvas")).toHaveAttribute(
      "data-ready",
      "true",
    );
    await expect(page.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    await page.evaluate(() => document.fonts.ready);
    async function shot(name) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const path = `first-use-${width}-${name}.png`;
      await page.screenshot({ path: `${output}/${path}`, fullPage: true });
      report.screenshots.push(path);
      const viewportPath = path.replace(".png", "-viewport.png");
      await page.screenshot({ path: `${output}/${viewportPath}` });
      report.screenshots.push(viewportPath);
    }
    await expect(
      page.getByRole("button", { name: /Select layer 1:/ }),
    ).toBeVisible();
    await expect(page.locator(".scene-selection")).toContainText(
      "Selected: Layer 1",
    );
    await expect(
      page.getByRole("slider", { name: "Drag width", exact: true }),
    ).toHaveCount(0);
    assert.equal(
      await page.locator(".advanced-settings").evaluate((n) => n.open),
      false,
    );
    const overflow = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll("body *")]
        .map((node) => ({
          tag: node.tagName,
          className: typeof node.className === "string" ? node.className : "",
          rect: node.getBoundingClientRect().toJSON(),
        }))
        .filter(
          (item) =>
            item.rect.width > 0 &&
            (item.rect.right > innerWidth + 1 || item.rect.left < -1),
        )
        .slice(0, 20),
    }));
    if (overflow.scrollWidth > width + 1)
      report.issues.push(
        `${width}px horizontal overflow: ${JSON.stringify(overflow)}`,
      );
    const primary = await page.locator(".preview-result-button").boundingBox();
    if (!(
      primary &&
      primary.y + primary.height <=
        (width === 360 ? 800 : width === 390 ? 844 : 1000)
    ))
      report.issues.push(
        `Primary result action is below the ${width}px viewport: ${JSON.stringify(primary)}`,
      );
    const sceneBox = await page.locator(".three-canvas").boundingBox();
    const railBox = await page.locator(".dimension-rail").boundingBox();
    assert.ok(
      sceneBox &&
        railBox &&
        Math.abs(sceneBox.x - railBox.x) <= 1 &&
        Math.abs(sceneBox.width - railBox.width) <= 1,
      "Scene and dimension controls share the same editor width",
    );
    await expect(
      page.getByRole("link", { name: "View example spectrum" }),
    ).toHaveAttribute("href", "#spectrum");
    await shot("initial");
    // First change the existing layer, without having to discover Add.
    await page.locator(".dimension-rail button").first().click();
    await shot("width-editor");
    for (const label of ["Close settings", "Done"]) {
      await page.keyboard.press("Tab");
      const target = page.getByRole("button", { name: label, exact: true });
      await target.focus();
      assert.equal(
        await target.evaluate((node) => getComputedStyle(node).outlineColor),
        "rgb(79, 70, 229)",
      );
      await shot(`focus-${label === "Done" ? "done" : "close"}`);
    }
    await page.locator("#dimension-width").fill("200");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(".dimension-rail button").first()).toContainText(
      "200",
    );
    await expect(page.locator(".stale-note")).toContainText(
      "no longer matches your inputs",
    );
    await page.getByLabel("Add layer", { exact: true }).click();
    await page
      .getByRole("button", { name: "Add patterned layer", exact: true })
      .click();
    await expect(page.locator(".scene-selection")).toContainText(
      "Selected: Layer 2",
    );
    const otherLayerDimensions = await page
      .locator(".dimension-rail button")
      .evaluateAll((nodes) =>
        nodes.slice(0, 2).map((node) => node.getAttribute("aria-label")),
      );
    await shot("two-layers");
    await page.keyboard.press("Tab");
    const unselectedLayer = page.getByRole("button", {
      name: /Select layer 1:/,
    });
    await unselectedLayer.focus();
    await expect(unselectedLayer).toHaveAttribute("aria-pressed", "false");
    assert.equal(
      await unselectedLayer.evaluate(
        (node) => getComputedStyle(node).outlineColor,
      ),
      "rgb(79, 70, 229)",
    );
    await shot("focus-unselected-layer");
    await page.getByRole("button", { name: /Select layer 1:/ }).click();
    await expect(page.locator(".scene-selection")).toContainText(
      "Selected: Layer 1",
    );
    await expect(page.locator(".dimension-rail button").first()).toContainText(
      "200",
    );
    await page
      .locator(".dimension-rail button")
      .filter({ hasText: "Thickness" })
      .click();
    await shot("thickness-editor");
    await page.locator("#dimension-height").fill("150");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page.locator(".dimension-rail button").filter({ hasText: "Thickness" }),
    ).toContainText("150");
    await shot("edited-layer");
    await page.getByRole("button", { name: /Select layer 2:/ }).click();
    assert.deepEqual(
      await page
        .locator(".dimension-rail button")
        .evaluateAll((nodes) =>
          nodes.slice(0, 2).map((node) => node.getAttribute("aria-label")),
        ),
      otherLayerDimensions,
      "Editing Layer 1 leaves Layer 2 width and thickness unchanged",
    );
    await page.getByRole("button", { name: /Select layer 1:/ }).click();
    await expect(
      page.locator(".dimension-rail button").filter({ hasText: "Thickness" }),
    ).toContainText("150");
    const editedLayerDimensions = await page
      .locator(".dimension-rail button")
      .evaluateAll((nodes) =>
        nodes.slice(0, 2).map((node) => node.getAttribute("aria-label")),
      );
    await page
      .locator(".dimension-rail button")
      .filter({ hasText: "Shared pitch" })
      .click();
    await page.locator("#dimension-pitch").fill("500");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page
        .locator(".dimension-rail button")
        .filter({ hasText: "Shared pitch" }),
    ).toContainText("500");
    await page.getByRole("button", { name: /Select layer 2:/ }).click();
    await expect(
      page
        .locator(".dimension-rail button")
        .filter({ hasText: "Shared pitch" }),
    ).toContainText("500");
    assert.deepEqual(
      await page
        .locator(".dimension-rail button")
        .evaluateAll((nodes) =>
          nodes.slice(0, 2).map((node) => node.getAttribute("aria-label")),
        ),
      otherLayerDimensions,
      "Shared pitch does not change Layer 2 width or thickness",
    );
    await page.getByRole("button", { name: /Select layer 1:/ }).click();
    assert.deepEqual(
      await page
        .locator(".dimension-rail button")
        .evaluateAll((nodes) =>
          nodes.slice(0, 2).map((node) => node.getAttribute("aria-label")),
        ),
      editedLayerDimensions,
      "Shared pitch does not change Layer 1 width or thickness",
    );
    await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
    await expect(page.locator(".stale-note")).toContainText(
      "no longer matches your inputs",
    );
    await shot("shared-pitch");
    await page
      .locator(".dimension-rail button")
      .filter({ hasText: "Shared pitch" })
      .click();
    await page.locator("#dimension-pitch").fill("199");
    await expect(page.locator("#dimension-pitch")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page
        .locator(".dimension-rail button")
        .filter({ hasText: "Shared pitch" }),
    ).toContainText("500");
    assert.deepEqual(
      await page
        .locator(".dimension-rail button")
        .evaluateAll((nodes) =>
          nodes.slice(0, 2).map((node) => node.getAttribute("aria-label")),
        ),
      editedLayerDimensions,
      "An invalid shared pitch never shrinks the edited layer",
    );
    await page
      .getByRole("button", { name: "Layer settings", exact: true })
      .click();
    await shot("layer-settings");
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await page.getByRole("button", { name: "Use this design locally", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Use this design locally" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator("#spectrum").scrollIntoViewIfNeeded();
    await expect(page.locator(".static-edit-note")).toContainText(
      "Edits won't calculate a new spectrum",
    );
    await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
    const spectrumSlider = page.getByLabel("Inspect wavelength sample", {
      exact: true,
    });
    await spectrumSlider.focus();
    await spectrumSlider.press("Home");
    await expect(spectrumSlider).toHaveAttribute(
      "aria-valuetext",
      `${reference.result.wavelengths_nm[0]} nanometers`,
    );
    await spectrumSlider.press("ArrowRight");
    // CDP reports the native index as valuetext; inspect the actual accessible
    // description, not superseded label-source metadata. AT speech is not tested.
    async function assertSpectrumAX(polarization, quantity, sample) {
      const ax = await page.context().newCDPSession(page);
      const items =
        quantity === "total"
          ? [
              ["R", "Reflectance"],
              ["T", "Transmittance"],
            ]
          : [
              ["R_specular", "R₀ specular"],
              ["T_specular", "T₀ specular"],
            ];
      const expected = `${reference.result.wavelengths_nm[sample]} nanometers. ${polarization} polarization. ${items.map(([key, label]) => `${label} ${(reference.result.spectra[polarization][key][sample] * 100).toFixed(1)} percent`).join(". ")}.`;
      let sliderNode;
      try {
        await expect(spectrumSlider).toHaveAttribute(
          "aria-valuetext",
          `${reference.result.wavelengths_nm[sample]} nanometers`,
        );
        await expect
          .poll(
            async () => {
              const accessibility = await ax.send(
                "Accessibility.getFullAXTree",
              );
              sliderNode = accessibility.nodes.find(
                (node) =>
                  node.role?.value === "slider" &&
                  node.name?.value === "Inspect wavelength sample",
              );
              return sliderNode?.description?.value;
            },
            { timeout: 3000 },
          )
          .toBe(expected);
        assert.equal(
          sliderNode.value.value,
          sample,
          "The native slider retains its exact sample index",
        );
        assert.equal(sliderNode.ignored, false);
        const properties = Object.fromEntries(
          sliderNode.properties.map((item) => [item.name, item.value.value]),
        );
        assert.equal(properties.valuemin, 0);
        assert.equal(
          properties.valuemax,
          reference.result.wavelengths_nm.length - 1,
        );
        assert.equal(properties.describedby, "spectrum-sample-description");
        await expect(
          page.locator("#spectrum-sample-description"),
        ).toHaveAttribute("aria-live", "polite");
      } catch (error) {
        report.issues.push(
          `${width}px ${polarization}/${quantity}/${sample} AX: ${error}`,
        );
      } finally {
        await fs.writeFile(
          `${output}/first-use-${width}-${polarization}-${quantity}-${sample}-ax.json`,
          JSON.stringify(sliderNode ?? null, null, 2),
        );
        report.checks.push({
          viewport: width,
          expectedAccessibleDescription: expected,
          wavelengthAccessibility: sliderNode,
        });
        await ax.detach();
      }
    }
    await assertSpectrumAX("s", "total", 1);
    await spectrumSlider.press("End");
    await assertSpectrumAX(
      "s",
      "total",
      reference.result.wavelengths_nm.length - 1,
    );
    await spectrumSlider.press("Home");
    await assertSpectrumAX("s", "total", 0);
    await spectrumSlider.press("ArrowRight");
    await expect(spectrumSlider).toHaveAttribute(
      "aria-valuetext",
      `${reference.result.wavelengths_nm[1]} nanometers`,
    );
    await expect(spectrumSlider).toHaveAttribute(
      "aria-describedby",
      "spectrum-sample-description",
    );
    await page
      .getByLabel("Spectrum quantity", { exact: true })
      .selectOption("specular");
    await expect(page.locator("#spectrum-sample-description")).toContainText(
      "specular",
    );
    await assertSpectrumAX("s", "specular", 1);
    await page.getByRole("button", { name: "p / TM", exact: true }).click();
    await expect(page.locator("#spectrum-sample-description")).toContainText(
      "p polarization",
    );
    await assertSpectrumAX("p", "specular", 0);
    await expect(spectrumSlider).toHaveAttribute(
      "aria-valuetext",
      `${reference.result.wavelengths_nm[0]} nanometers`,
    );
    await page
      .getByLabel("Spectrum quantity", { exact: true })
      .selectOption("total");
    await page.getByRole("button", { name: "s / TE", exact: true }).click();
    await page
      .locator("#spectrum")
      .screenshot({ path: `${output}/first-use-${width}-edited-spectrum.png` });
    report.screenshots.push(`first-use-${width}-edited-spectrum.png`);
    await page.locator(".project-menu > summary").click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const exported = JSON.parse(
      await fs.readFile(await (await downloading).path(), "utf8"),
    );
    assert.equal(exported.project.period_nm, 500);
    assert.equal(exported.project.layers[0].cd_nm, 200);
    assert.equal(exported.project.layers[0].thickness_nm, 150);
    assert.deepEqual(
      exported.result,
      reference.result,
      "Editing never replaces the original reference spectrum",
    );
    assert.deepEqual(
      exported.result_project,
      reference.project,
      "The original spectrum retains its exact original inputs",
    );
    assert.equal(
      apiCalls.length,
      0,
      "Static editing must make no API requests",
    );
    report.checks.push(
      `${width}px: select existing layer, edit width, add/select layer, edit thickness and shared pitch with layer isolation, identify original example result, no horizontal overflow, primary action in mobile viewport, no API calls`,
    );
  } finally {
    await browser.close();
  }
}
assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
report.status = report.issues.length ? "failed" : "passed";
await fs.writeFile(
  `${output}/first-use-browser-qa.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
assert.equal(report.issues.length, 0, JSON.stringify(report.issues));
