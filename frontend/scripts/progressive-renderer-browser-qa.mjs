// Production loading/failure acceptance. Gates delay real same-origin responses;
// no geometry, spectrum, hash, React state, or successful solve is fabricated.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import {
  canvas2D,
  closeSheet,
  menuAction,
  importText,
  applyImportedDesign,
  capture,
} from "./browser-2d-controls.mjs";
const output = new URL("../../artifacts/", import.meta.url).pathname;
await fs.mkdir(output, { recursive: true });
const previewUrl = process.env.RCWA_PREVIEW_URL || "http://127.0.0.1:4173";
const appUrl = process.env.RCWA_APP_URL || "http://127.0.0.1:5173";
const fixture = JSON.parse(
  await fs.readFile(
    new URL("../public/reference-circular.json", import.meta.url),
    "utf8",
  ),
);
const legacy = JSON.parse(
  await fs.readFile(
    new URL("../public/reference-example.json", import.meta.url),
    "utf8",
  ),
);
const original = fixture.project;
const report = {
  status: "running",
  groups: [],
  checks: [],
  screenshots: [],
  captures: [],
  artifacts: [],
  pageErrors: [],
  issues: [],
  conditions: {
    browser: "CI Chromium with SwiftShader",
    cache: "fresh context per group; routing disables HTTP cache",
    serviceWorkers: "blocked",
    network: "local server; explicit response gates, no network/CPU throttling",
    cpu: "CI host, unthrottled",
  },
  limitations: [
    "Response-gate checks prove usability before dependencies arrive, not faster phone or network timing.",
    "Production React does not double-run effects. The separate live development group checks its StrictMode mount/unmount lifecycle.",
    "No new numerical solve or accuracy claim.",
  ],
};
const diameter = (page, layer = 1) =>
  page.getByRole("button", {
    name: new RegExp(`^Edit Layer ${layer} diameter:`),
  });
const chip = (page, layer) =>
  page.getByRole("button", { name: new RegExp(`^Select layer ${layer}:`) });
const review = (page) =>
  page.getByRole("dialog", { name: "Review imported design", exact: true });
const scene = (page) => page.locator(".s2-scene");
const stable = ({ exported_at: _time, ...data }) => data;
let browser,
  serial = 0;
async function exported(page, name) {
  const downloading = page.waitForEvent("download", { timeout: 6000 });
  downloading.catch(() => {});
  await menuAction(page, "Export");
  const download = await downloading;
  const filename = `progressive-${++serial}-${name}.json`;
  await download.saveAs(`${output}/${filename}`);
  report.artifacts.push(filename);
  return stable(JSON.parse(await fs.readFile(`${output}/${filename}`, "utf8")));
}
async function shot(page, name) {
  await capture(page, report, output, name, {
    prefix: "progressive",
    full: false,
  });
}
async function gate(page, pattern) {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const requests = [];
  let disposition = "continue";
  await page.route(pattern, async (route) => {
    requests.push(route.request().url());
    await pending;
    if (disposition === "abort") await route.abort("failed").catch(() => {});
    else await route.continue().catch(() => {});
  });
  return {
    requests,
    started: () => expect.poll(() => requests.length).toBeGreaterThan(0),
    release: (reject = false) => {
      disposition = reject ? "abort" : "continue";
      release();
    },
  };
}
async function installListenerAudit(context) {
  await context.addInitScript(() => {
    const records = new Map();
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const watched = new Set([
      "webglcontextlost",
      "webglcontextrestored",
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
      "lostpointercapture",
      "keydown",
      "keyup",
    ]);
    const capture = (option) =>
      typeof option === "boolean" ? option : !!option?.capture;
    EventTarget.prototype.addEventListener = function (type, listener, option) {
      if (
        (this instanceof HTMLCanvasElement ||
          this === document ||
          this === window) &&
        watched.has(type)
      ) {
        const list = records.get(this) || [];
        if (
          !list.some(
            (entry) =>
              entry.type === type &&
              entry.listener === listener &&
              entry.capture === capture(option),
          )
        )
          list.push({ type, listener, capture: capture(option) });
        records.set(this, list);
      }
      return add.call(this, type, listener, option);
    };
    EventTarget.prototype.removeEventListener = function (
      type,
      listener,
      option,
    ) {
      if (records.has(this))
        records.set(
          this,
          records
            .get(this)
            .filter(
              (entry) =>
                !(
                  entry.type === type &&
                  entry.listener === listener &&
                  entry.capture === capture(option)
                ),
            ),
        );
      return remove.call(this, type, listener, option);
    };
    window.progressiveCanvasListeners = () =>
      [...records]
        .filter(([target]) => target instanceof HTMLCanvasElement)
        .map(([canvas, listeners]) => ({
          connected: canvas.isConnected,
          counts: listeners.reduce(
            (counts, { type }) => ({
              ...counts,
              [type]: (counts[type] || 0) + 1,
            }),
            {},
          ),
        }));
    window.progressiveGlobalListeners = () =>
      Object.fromEntries(
        [document, window].map((target) => [
          target === document ? "document" : "window",
          (records.get(target) || []).reduce(
            (counts, { type }) => ({
              ...counts,
              [type]: (counts[type] || 0) + 1,
            }),
            {},
          ),
        ]),
      );
  });
}
async function group(name, width, run, development = false) {
  const record = {
    name,
    width,
    mode: development ? "live-development-StrictMode" : "production-static",
    status: "running",
    checks: [],
  };
  report.groups.push(record);
  const context = await browser.newContext({
    viewport: {
      width,
      height: width === 360 ? 800 : width === 390 ? 844 : 1000,
    },
    isMobile: width < 700,
    hasTouch: width < 700,
    acceptDownloads: true,
    serviceWorkers: "block",
  });
  await installListenerAudit(context);
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.setDefaultNavigationTimeout(15000);
  const errors = [],
    api = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      api.push({ method: request.method(), url: request.url() });
  });
  const timer = setTimeout(() => {
    record.timeout = true;
    void context.close().catch(() => {});
  }, 65000);
  try {
    await run(page, record, development ? appUrl : previewUrl);
    assert.deepEqual(
      errors,
      [],
      "No uncaught errors, including rejected renderer imports",
    );
    assert.deepEqual(
      development ? api.filter(({ method }) => method !== "GET") : api,
      [],
      "Rendering/editing never makes mutation requests; static preview makes no API calls",
    );
    assert.equal(record.timeout, undefined);
    record.status = "passed";
    report.checks.push(name);
  } catch (error) {
    record.status = "failed";
    record.error = String(error?.stack || error);
    report.issues.push(`${name}: ${record.error}`);
    if (!page.isClosed()) await shot(page, `${name}-failure`).catch(() => {});
  } finally {
    clearTimeout(timer);
    report.pageErrors.push(...errors.map((message) => ({ name, message })));
    record.api = api;
    await context.close().catch(() => {});
    await fs.writeFile(
      `${output}/progressive-renderer-browser-qa.json`,
      JSON.stringify(report, null, 2),
    );
  }
}
async function loadingLayout(page, width, record) {
  await page.evaluate(() => document.fonts.ready);
  await expect(scene(page)).toHaveAttribute("data-renderer-state", "loading");
  await expect(page.locator(".s2-fallback-notice")).toHaveText(
    "2D view · 3D loading.",
  );
  await expect(canvas2D(page)).toHaveCount(0);
  const dimensions = await scene(page).evaluate((node) => {
    const scene = node.getBoundingClientRect();
    return {
      height: scene.height,
      projections: [...node.querySelectorAll(".s2-projection")].map(
        (figure) => {
          const svg = figure.querySelector("svg"),
            box = svg.getBoundingClientRect();
          const matrix = svg.querySelector("g[transform]").getScreenCTM();
          return {
            width: box.width,
            height: box.height,
            scaleX: Math.hypot(matrix.a, matrix.b),
            scaleY: Math.hypot(matrix.c, matrix.d),
            labels: [...figure.querySelectorAll("text, figcaption, p")].map(
              (label) => {
                const b = label.getBoundingClientRect();
                return {
                  text: label.textContent,
                  withinScene:
                    b.left >= scene.left &&
                    b.right <= scene.right &&
                    b.top >= scene.top &&
                    b.bottom <= scene.bottom,
                };
              },
            ),
          };
        },
      ),
    };
  });
  assert.equal(dimensions.height, width < 700 ? 230 : 342);
  for (const projection of dimensions.projections) {
    assert.ok(
      Math.abs(projection.scaleX - projection.scaleY) < 1e-8,
      "Exact physical axis ratio is preserved",
    );
    assert.ok(
      projection.labels.every(({ withinScene }) => withinScene),
      "All essential projection labels fit inside the scene",
    );
  }
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const primary = page.locator(".preview-result-button");
  await expect(primary).toHaveCount(1);
  const firstScreen = page.locator(
    ".s2-context, .s2-dimensions > button, .preview-result-button",
  );
  const boxes = await firstScreen.evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { label: node.textContent, y: box.y, bottom: box.bottom };
    }),
  );
  assert.equal(
    boxes.length,
    5,
    "Context, all three exact controls, and the primary action are present",
  );
  for (const box of boxes)
    assert.ok(
      box.y >= 0 && box.bottom <= page.viewportSize().height,
      `${box.label} remains on the first screen`,
    );
  record.firstScreenControls = boxes;
  record.loadingLayout = dimensions;
  await shot(page, `${record.name}-loading`);
}
async function editPositions(page) {
  return page
    .locator(".s2-context, .s2-dimensions > button, .preview-result-button")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return {
          x: box.x + scrollX,
          y: box.y + scrollY,
          width: box.width,
          height: box.height,
        };
      }),
    );
}
async function editDimensions(page) {
  await diameter(page).click();
  await page
    .getByRole("spinbutton", { name: "Diameter nm", exact: true })
    .fill("73");
  await closeSheet(page);
  await page.getByRole("button", { name: /^Edit Layer 1 thickness:/ }).click();
  await page.locator("#dimension-height").fill("105");
  await closeSheet(page);
  await page.getByRole("button", { name: /^Edit shared pitch:/ }).click();
  await page
    .getByRole("spinbutton", { name: "Pitch X nm", exact: true })
    .fill("170");
  await page
    .getByRole("spinbutton", { name: "Pitch Y nm", exact: true })
    .fill("190");
  await closeSheet(page);
}
async function ready2D(page) {
  await expect(canvas2D(page)).toHaveAttribute("data-ready", "true");
  await expect(scene(page)).toHaveAttribute("data-renderer-state", "ready");
  await expect(canvas2D(page)).toHaveCount(1);
}
async function assertCurrentCircleGeometry(page, project, cutaway = true) {
  const data = await canvas2D(page).evaluate((node) => ({ ...node.dataset }));
  assert.equal(data.cutaway, String(cutaway));
  const total = project.layers.reduce(
    (sum, layer) => sum + layer.thickness_nm,
    0,
  );
  assert.deepEqual(JSON.parse(data.physicalBounds), {
    min: { x: -1.5 * project.period_nm, y: -1.5 * project.period_y_nm, z: 0 },
    max: { x: 1.5 * project.period_nm, y: 1.5 * project.period_y_nm, z: total },
  });
  const interfaces = [total];
  for (const layer of project.layers)
    interfaces.push(interfaces.at(-1) - layer.thickness_nm);
  assert.deepEqual(JSON.parse(data.layerInterfaces), interfaces);
  const regions = JSON.parse(data.circularGeometry),
    meshes = JSON.parse(data.renderedMeshes);
  project.layers.forEach((layer, index) => {
    if (
      layer.geometry !== "circular_hole_2d" ||
      layer.thickness_nm === 0 ||
      layer.diameter_nm === 0
    )
      return;
    const pair = regions.filter((region) => region.layerIndex === index);
    assert.equal(pair.length, 2);
    for (const role of ["material", "background"]) {
      const region = pair.find((item) => item.role === role);
      assert.ok(region);
      assert.equal(region.diameterNm, layer.diameter_nm);
      const circle = Math.PI * (layer.diameter_nm / 2) ** 2;
      const volume =
        9 *
        (cutaway ? 0.75 : 1) *
        layer.thickness_nm *
        (role === "material"
          ? circle
          : project.period_nm * project.period_y_nm - circle);
      assert.ok(
        Math.abs(region.analyticVolumeNm3 - volume) <
          1e-7 * Math.max(1, volume),
      );
      assert.ok(
        Math.abs(region.meshVolumeNm3 - volume) < 0.002 * Math.max(1, volume),
      );
    }
    assert.ok(
      meshes.some(
        (mesh) =>
          mesh.layerIndex === index &&
          mesh.circular &&
          mesh.role === "background",
      ),
      "Latest actual host meshes are rendered",
    );
  });
}
async function listenerState(page) {
  return page.evaluate(() => window.progressiveCanvasListeners());
}
async function lifecycle(page, record, url) {
  const renderer = await gate(
    page,
    /\/(?:assets\/StructureCanvas2D-[^/]+\.js|src\/StructureCanvas2D\.tsx)(?:\?.*)?$/,
  );
  const legacyRenderer = await gate(
    page,
    /\/(?:assets\/threeStructureRenderer-[^/]+\.js|src\/threeStructureRenderer\.ts)(?:\?.*)?$/,
  );
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await renderer.started();
  await expect(diameter(page)).toBeEnabled();
  // The first file-input action creates Playwright's main-world helper and its
  // page-lifetime window hit-target listeners. Prime it with the already-empty
  // input so those automation listeners are included in the baseline, without
  // importing a design or relaxing any renderer cleanup assertion.
  await page.locator(".project-menu input[type=file]").setInputFiles([]);
  const globalBaseline = await page.evaluate(() =>
    window.progressiveGlobalListeners(),
  );
  record.globalBaseline = globalBaseline;
  await importText(page, legacy, "legacy-unmount");
  await expect(page.locator(".dimension-rail button").first()).toBeEnabled();
  await legacyRenderer.started();
  await expect(scene(page)).toHaveCount(0);
  renderer.release();
  await page.waitForResponse((response) =>
    /StructureCanvas2D[-.]/.test(response.url()),
  );
  await expect(canvas2D(page)).toHaveCount(0);
  const widthControl = page.getByRole("button", { name: /^Set layer width,/ });
  await widthControl.click();
  const input = page.locator("#dimension-width");
  await input.fill("181");
  await expect(input).toBeFocused();
  legacyRenderer.release();
  await expect(page.locator(".three-canvas")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect(page.locator(".webgl-host canvas")).toHaveCount(1);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("181");
  await closeSheet(page);
  const data = await exported(page, `${record.name}-legacy`);
  assert.equal(data.project.layers[0].cd_nm, 181);
  assert.deepEqual(data.result, legacy.result);
  for (let cycle = 0; cycle < 2; cycle++) {
    await importText(page, original, `remount-2d-${cycle}`);
    await applyImportedDesign(page);
    await ready2D(page);
    await assertCurrentCircleGeometry(page, original);
    await expect(page.locator(".webgl-host canvas")).toHaveCount(0);
    const state = await listenerState(page);
    assert.equal(state.filter(({ connected }) => connected).length, 1);
    assert.ok(
      state
        .filter(({ connected }) => !connected)
        .every(({ counts }) => Object.keys(counts).length === 0),
      "Unmounted renderer canvases retain no tracked listeners",
    );
    const globals = await page.evaluate(() =>
      window.progressiveGlobalListeners(),
    );
    assert.deepEqual(
      globals,
      {
        ...globalBaseline,
        document: {
          ...globalBaseline.document,
          keydown: (globalBaseline.document.keydown || 0) + 1,
        },
      },
      "Exactly one active OrbitControls document key listener; old renderer/window listeners are removed",
    );
    record.globalListeners = globals;
    if (cycle === 0) {
      await importText(page, legacy, "remount-legacy");
      await expect(page.locator(".three-canvas")).toHaveAttribute(
        "data-ready",
        "true",
      );
    }
  }
  record.listeners = await listenerState(page);
  record.checks.push(
    "A late module cannot attach to an unmounted schema; legacy exact controls/focus survive load; repeated schema mounts retain one canvas and clean listeners",
  );
}
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  for (const width of [360, 390, 1440])
    await group(`both-delayed-${width}`, width, async (page, record, url) => {
      const renderer = await gate(
        page,
        /\/assets\/StructureCanvas2D-[^/]+\.js$/,
      );
      const reference = await gate(page, "**/reference-circular.json");
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await Promise.all([renderer.started(), reference.started()]);
      await loadingLayout(page, width, record);
      await page
        .getByRole("combobox", { name: "Structure view", exact: true })
        .selectOption("full");
      await editDimensions(page);
      await chip(page, 3).click();
      await expect(
        page.locator('.s2-fallback svg[data-projection="xy"]'),
      ).toHaveAttribute("data-selected-layer", "2");
      await chip(page, 1).click();
      const proposed = structuredClone(original);
      proposed.name = "Reviewed while 3D loads";
      proposed.layers[0].diameter_nm = 79;
      await importText(page, proposed, "held-review");
      await expect(review(page)).toBeVisible();
      await review(page)
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      const before = await exported(page, `${record.name}-before`);
      assert.equal(before.result, null);
      await menuAction(page, "↶ Undo");
      const heldUndo = await exported(page, `${record.name}-held-undo`);
      assert.equal(heldUndo.project.period_y_nm, original.period_y_nm);
      await menuAction(page, "↷ Redo");
      assert.deepEqual(
        await exported(page, `${record.name}-held-redo`),
        before,
      );
      await expect(scene(page)).toHaveAttribute(
        "data-renderer-state",
        "loading",
      );
      await diameter(page).click();
      const field = page.getByRole("spinbutton", {
        name: "Diameter nm",
        exact: true,
      });
      await field.fill("81.250");
      await expect(field).toHaveValue("81.250");
      const oldHeight = (await scene(page).boundingBox()).height;
      const oldPositions = await editPositions(page);
      renderer.release();
      await ready2D(page);
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("81.250");
      assert.deepEqual(
        await editPositions(page),
        oldPositions,
        "Readiness does not shift exact controls or the primary action",
      );
      await field.fill("");
      reference.release();
      await page.waitForResponse((response) =>
        response.url().endsWith("/reference-circular.json"),
      );
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("");
      await expect(field).toHaveAttribute("aria-invalid", "true");
      assert.equal((await scene(page).boundingBox()).height, oldHeight);
      await field.fill("81.250");
      await closeSheet(page);
      const after = await exported(page, `${record.name}-after`);
      assert.deepEqual(after, {
        ...before,
        project: {
          ...before.project,
          layers: before.project.layers.map((layer, index) =>
            index === 0 ? { ...layer, diameter_nm: 81.25 } : layer,
          ),
        },
      });
      await assertCurrentCircleGeometry(page, after.project, false);
      await menuAction(page, "↶ Undo");
      assert.deepEqual(
        await exported(page, `${record.name}-undo`),
        before,
        "The edit remains one transaction across readiness and reference arrival",
      );
      await assertCurrentCircleGeometry(page, before.project, false);
      await menuAction(page, "↷ Redo");
      assert.deepEqual(await exported(page, `${record.name}-redo`), after);
      await assertCurrentCircleGeometry(page, after.project, false);
      await menuAction(page, "Reset example");
      await expect(page.locator(".result-badge")).toHaveText(
        "Precomputed example",
      );
      const reset = await exported(page, `${record.name}-reset`);
      assert.deepEqual(reset.project, original);
      assert.deepEqual(reset.result, fixture.result);
      await assertCurrentCircleGeometry(page, original, false);
      await shot(page, `${record.name}-ready`);
      record.checks.push(
        "Both dependencies held: exact SVG, view choice, dimensions, layer selection, import review/cancel and export usable; readiness/reference preserve draft/focus/history; reset still installs genuine reference",
      );
    });
  await group(
    "renderer-held-reference-ready",
    390,
    async (page, record, url) => {
      const renderer = await gate(
        page,
        /\/assets\/StructureCanvas2D-[^/]+\.js$/,
      );
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await renderer.started();
      await expect(page.locator(".result-badge")).toHaveText(
        "Precomputed example",
      );
      await editDimensions(page);
      await menuAction(page, "Reset example");
      await expect(diameter(page)).toHaveAccessibleName(/65 nanometers/);
      const proposed = structuredClone(original);
      proposed.layers[0].diameter_nm = 77;
      await importText(page, proposed, "ready-modal");
      await expect(review(page)).toBeVisible();
      const cancel = review(page).getByRole("button", {
        name: "Cancel",
        exact: true,
      });
      await cancel.focus();
      renderer.release();
      await ready2D(page);
      await expect(cancel).toBeFocused();
      await applyImportedDesign(page);
      const data = await exported(page, record.name);
      assert.deepEqual(data.project, proposed);
      await assertCurrentCircleGeometry(page, proposed);
      assert.deepEqual(data.result, fixture.result);
      assert.deepEqual(data.result_project, original);
      await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
      await expect(page.locator(".stale-note")).toContainText(
        "stored spectrum",
      );
      await menuAction(page, "↶ Undo");
      assert.deepEqual(
        (await exported(page, `${record.name}-undo`)).project,
        original,
      );
      record.checks.push(
        "Reference loads independently; reset works during renderer delay; modal focus/review survives renderer readiness; exact old spectrum/hash/provenance retained",
      );
    },
  );
  await group(
    "reference-held-renderer-ready",
    390,
    async (page, record, url) => {
      const reference = await gate(page, "**/reference-circular.json");
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await reference.started();
      await ready2D(page);
      await editDimensions(page);
      const before = await exported(page, `${record.name}-before`);
      reference.release();
      await page.waitForResponse((response) =>
        response.url().endsWith("/reference-circular.json"),
      );
      assert.deepEqual(await exported(page, record.name), before);
      record.checks.push(
        "3D is independent of reference availability; late reference cannot replace edited inputs or install a stale result",
      );
    },
  );
  await group(
    "rejected-reference-renderer-ready",
    390,
    async (page, record, url) => {
      const reference = await gate(page, "**/reference-circular.json");
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await reference.started();
      await ready2D(page);
      reference.release(true);
      await expect(page.locator(".message.error")).toContainText(
        "Inputs remain editable; no result was installed.",
      );
      await editDimensions(page);
      const data = await exported(page, record.name);
      assert.equal(data.result, null);
      assert.equal(data.project.layers[0].diameter_nm, 73);
      await assertCurrentCircleGeometry(page, data.project);
      record.checks.push(
        "Rejected reference leaves independent 3D and exact input editing/export usable without installing a result",
      );
    },
  );
  for (const failure of ["rejected-chunk", "unavailable-webgl"])
    await group(
      failure,
      failure === "rejected-chunk" ? 360 : 390,
      async (page, record, url) => {
        if (failure === "unavailable-webgl")
          await page.addInitScript(() => {
            const get = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
              return /webgl/.test(kind) ? null : get.call(this, kind, ...args);
            };
          });
        const renderer =
          failure === "rejected-chunk"
            ? await gate(page, /\/assets\/StructureCanvas2D-[^/]+\.js$/)
            : null;
        await page.goto(url, { waitUntil: "domcontentloaded" });
        if (renderer) {
          await renderer.started();
          renderer.release(true);
        }
        await expect(scene(page)).toHaveAttribute(
          "data-renderer-state",
          "unavailable",
        );
        await expect(page.locator(".s2-fallback-notice")).toHaveText(
          "2D view · 3D unavailable.",
        );
        await expect(page.locator(".result-badge")).toHaveText(
          "Precomputed example",
        );
        await editDimensions(page);
        await chip(page, 3).click();
        const data = await exported(page, record.name);
        assert.equal(data.project.layers[0].diameter_nm, 73);
        assert.deepEqual(data.result, fixture.result);
        await menuAction(page, "↶ Undo");
        await menuAction(page, "↷ Redo");
        const proposed = structuredClone(original);
        proposed.name = `Editable ${failure}`;
        await importText(page, proposed, failure);
        await applyImportedDesign(page);
        assert.deepEqual(
          (await exported(page, `${failure}-import`)).project,
          proposed,
        );
        await menuAction(page, "Reset example");
        await expect(page.locator(".result-badge")).toHaveText(
          "Precomputed example",
        );
        await shot(page, failure);
        record.checks.push(
          "Failed enhancement keeps exact SVG, dimensions, selection, review/apply, export, history, and reset usable",
        );
      },
    );
  await group("legacy-rejected-chunk", 360, async (page, record, url) => {
    const renderer = await gate(
      page,
      /\/assets\/threeStructureRenderer-[^/]+\.js$/,
    );
    const legacyUrl = new URL(url);
    legacyUrl.searchParams.set("example", "1d");
    await page.goto(legacyUrl.href, { waitUntil: "domcontentloaded" });
    await renderer.started();
    await expect(page.locator(".three-canvas")).toHaveAttribute(
      "data-loading",
      "true",
    );
    const width = page.getByRole("button", { name: /^Set layer width,/ });
    await width.click();
    await page.locator("#dimension-width").fill("181");
    renderer.release(true);
    await expect(page.locator(".three-canvas")).toHaveAttribute(
      "data-fallback",
      "true",
    );
    await expect(page.locator("#dimension-width")).toBeFocused();
    await expect(page.locator("#dimension-width")).toHaveValue("181");
    await closeSheet(page, "Close settings");
    const data = await exported(page, record.name);
    assert.equal(data.project.layers[0].cd_nm, 181);
    await menuAction(page, "↶ Undo");
    await expect(width).toHaveAccessibleName(/currently 180 nanometers/);
    await menuAction(page, "Reset example");
    await expect(page.locator(".result-badge")).toHaveText(
      "Precomputed example",
    );
    await expect(page.locator(".webgl-host canvas")).toHaveCount(0);
    await shot(page, record.name);
    record.checks.push(
      "Legacy module rejection preserves open field text/focus, exact controls, export, history and reset",
    );
  });
  await group("production-schema-unmount", 390, lifecycle);
  await group("development-strictmode-unmount", 390, lifecycle, true);
  assert.deepEqual(
    report.issues,
    [],
    "All delayed/failure/StrictMode groups pass",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.issues.push(String(error?.stack || error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fs.writeFile(
    `${output}/progressive-renderer-browser-qa.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
