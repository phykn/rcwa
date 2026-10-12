// Production 2D browser helpers. No React internals or synthesized solver output.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { expect } from "@playwright/test";

export const canvas2D = (page) => page.locator(".s2-webgl canvas");
export const widthCard = (page, layer = 3) =>
  page.getByRole("button", { name: new RegExp(`^Edit Layer ${layer} width:`) });
export const pitchCard = (page) =>
  page.getByRole("button", { name: /^Edit shared pitch:/ });
export const clone = (value) => structuredClone(value);
export const closeSheet = async (page, method = "Done") => {
  if (method === "Escape") await page.keyboard.press("Escape");
  else await page.getByRole("button", { name: method, exact: true }).click();
  await expect(page.locator("dialog.inspector")).not.toBeVisible();
};
export async function menuAction(page, name) {
  const menu = page.locator(".project-menu");
  if (!(await menu.evaluate((node) => node.open)))
    await menu.locator("summary").click();
  await page.getByRole("button", { name, exact: true }).click();
}
export async function exportWorkspace(page, output, name) {
  const downloading = page.waitForEvent("download", { timeout: 6000 });
  downloading.catch(() => {});
  await menuAction(page, "Export");
  const download = await downloading;
  const path = `${output}/true-2d-${name}.json`;
  await download.saveAs(path);
  const text = await fs.readFile(path, "utf8");
  return { path, text, data: JSON.parse(text) };
}
export async function importText(page, value, name = "project") {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  await page.locator(".project-menu input[type=file]").setInputFiles({
    name: `true-2d-${name}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(text),
  });
}
export async function editY(page, value, layer = 3) {
  await page
    .getByRole("button", { name: new RegExp(`^Select layer ${layer}:`) })
    .click();
  await widthCard(page, layer).click();
  await page
    .getByRole("spinbutton", { name: "Width Y nm", exact: true })
    .fill(String(value));
  await closeSheet(page);
}
const capturesInFlight = new WeakMap();
export function activeCapture(page) {
  return capturesInFlight.get(page) || null;
}
export async function capture(...args) {
  const page = args[0];
  assert.equal(
    capturesInFlight.has(page),
    false,
    "Page captures are serialized",
  );
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  capturesInFlight.set(page, done);
  try {
    return await collectCapture(...args);
  } finally {
    capturesInFlight.delete(page);
    finish();
  }
}
async function collectCapture(
  page,
  report,
  output,
  name,
  { top = true, full = true, diagnostics, prefix = "true-2d", filenameFor } = {},
) {
  if (top) await page.evaluate(() => window.scrollTo(0, 0));
  const failures = [];
  for (const fullPage of full ? [false, true] : [false]) {
    const filename = filenameFor ? filenameFor(fullPage) : `${prefix}-${name}${fullPage ? "-full" : "-viewport"}.png`;
    const minimum = fullPage
      ? await page.evaluate(() => ({
          width: Math.max(innerWidth, document.documentElement.scrollWidth),
          height: Math.max(innerHeight, document.documentElement.scrollHeight),
        }))
      : page.viewportSize();
    const item = {
      filename,
      minimum,
      ...(diagnostics ? { diagnostics } : {}),
      attempts: [],
    };
    report.captures.push(item);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const method = attempt === 1 ? "playwright" : "cdp";
      const path = `${output}/${filename}`;
      const started = Date.now();
      let stage = "remove-old-file";
      try {
        // Never let an old/partially written capture count as this attempt.
        await fs.rm(path, { force: true });
        if (method === "playwright") {
          stage = "playwright:captureScreenshot";
          await page.screenshot({ path, fullPage, timeout: 7000 });
        } else {
          // A bounded same-page Chromium capture is a genuine pixel fallback
          // if Playwright's screenshot preparation stalls. No page reload,
          // geometry substitution, viewport mutation or result fabrication.
          stage = "cdp:newSession";
          const session = await page.context().newCDPSession(page);
          let timer;
          try {
            const pending = (async () => {
              stage = "cdp:getLayoutMetrics";
              const metrics = await session.send("Page.getLayoutMetrics");
              const bounds = metrics.cssContentSize;
              item.layoutMetrics = {
                content: bounds,
                layoutViewport: metrics.cssLayoutViewport,
                visualViewport: metrics.cssVisualViewport,
              };
              stage = "cdp:captureScreenshot";
              return session.send("Page.captureScreenshot", {
                format: "png",
                fromSurface: true,
                captureBeyondViewport: fullPage,
                ...(fullPage
                  ? {
                      clip: {
                        x: 0,
                        y: 0,
                        width: bounds.width,
                        height: bounds.height,
                        scale: 1,
                      },
                    }
                  : {}),
              });
            })();
            pending.catch(() => {});
            const result = await Promise.race([
              pending,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(`CDP screenshot exceeded 10000 ms at ${stage}`),
                    ),
                  10000,
                );
              }),
            ]);
            stage = "writePNG";
            await fs.writeFile(path, Buffer.from(result.data, "base64"));
          } finally {
            clearTimeout(timer);
            await session.detach().catch(() => {});
          }
        }
        stage = "verifyPNG";
        const image = await verifyCaptureFile(path, minimum);
        item.attempts.push({
          attempt,
          method,
          stage,
          elapsedMs: Date.now() - started,
          status: "passed",
          ...image,
        });
        report.screenshots.push(filename);
        break;
      } catch (error) {
        item.attempts.push({
          attempt,
          method,
          stage,
          elapsedMs: Date.now() - started,
          status: "failed",
          error: String(error),
        });
        if (attempt === 2) failures.push(`${filename}: ${error}`);
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    "Every required screenshot must be captured; retries remain in the report",
  );
}
export async function verifyCaptureFile(path, minimum = null) {
  const bytes = await fs.readFile(path);
  assert.ok(bytes.length > 24, "Screenshot file must contain a PNG image");
  assert.deepEqual(
    bytes.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "Screenshot must have the PNG signature",
  );
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
  assert.equal(
    bytes.toString("ascii", bytes.length - 8, bytes.length - 4),
    "IEND",
    "Screenshot file must include its final PNG chunk",
  );
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0, "Screenshot has nonzero pixel dimensions");
  if (minimum)
    assert.ok(
      width >= minimum.width && height >= minimum.height,
      `Screenshot covers its requested viewport: ${width}×${height}`,
    );
  return { bytes: bytes.length, width, height };
}
function near(actual, expected, message, tolerance = 1e-8) {
  assert.ok(
    Number.isFinite(actual) &&
      Math.abs(actual - expected) <=
        tolerance * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} vs ${expected}`,
  );
}

/** Independent volume/occupancy checks against exported inputs, not the app's geometry builder. */
export async function assertScene(page, project, cutaway) {
  const scene = await canvas2D(page).evaluate((node) => ({ ...node.dataset }));
  assert.equal(scene.ready, "true");
  assert.equal(scene.cutaway, String(cutaway));
  assert.equal(
    scene.coordinateConvention,
    "physical(x,y,z) maps to scene(x,z,-y)",
  );
  const px = project.period_nm,
    py = project.period_y_nm;
  const total = project.layers.reduce(
    (sum, layer) => sum + layer.thickness_nm,
    0,
  );
  near(
    Number(scene.physicalScale),
    4.8 / Math.max(3 * px, 3 * py, total, 1),
    "Common physical scale",
  );
  assert.deepEqual(JSON.parse(scene.physicalBounds), {
    min: { x: -1.5 * px, y: -1.5 * py, z: 0 },
    max: { x: 1.5 * px, y: 1.5 * py, z: total },
  });
  const interfaces = [total];
  project.layers.forEach((layer) =>
    interfaces.push(interfaces.at(-1) - layer.thickness_nm),
  );
  const actualInterfaces = JSON.parse(scene.layerInterfaces);
  interfaces.forEach((z, i) => near(actualInterfaces[i], z, `Interface ${i}`));
  const incident = JSON.parse(scene.incidentDirection);
  const theta = (project.illumination.angle_deg * Math.PI) / 180;
  const phi = (project.illumination.azimuth_deg * Math.PI) / 180;
  near(incident.x, Math.sin(theta) * Math.cos(phi), "Incident X");
  near(incident.y, Math.sin(theta) * Math.sin(phi), "Incident Y");
  near(incident.z, -Math.cos(theta), "Incident Z");
  const regions = JSON.parse(scene.geometry);
  assert.equal(Number(scene.regionCount), regions.length);
  const volume = Array.from({ length: project.layers.length }, () => ({
    material: 0,
    background: 0,
  }));
  let visible = 0;
  const ranges = regions.map((r) => ({
    ...r,
    min: Object.fromEntries(
      ["x", "y", "z"].map((a) => [a, r.center[a] - r.size[a] / 2]),
    ),
    max: Object.fromEntries(
      ["x", "y", "z"].map((a) => [a, r.center[a] + r.size[a] / 2]),
    ),
  }));
  for (const r of ranges) {
    const layer = project.layers[r.layerIndex];
    assert.ok(layer && ["material", "background"].includes(r.role));
    for (const axis of ["x", "y", "z"])
      assert.ok(r.size[axis] > 0, "Positive mesh volume");
    assert.ok(r.min.x >= -1.5 * px - 1e-8 && r.max.x <= 1.5 * px + 1e-8);
    assert.ok(r.min.y >= -1.5 * py - 1e-8 && r.max.y <= 1.5 * py + 1e-8);
    near(r.min.z, interfaces[r.layerIndex + 1], "Layer bottom");
    near(r.max.z, interfaces[r.layerIndex], "Layer top");
    if (cutaway)
      assert.ok(
        r.max.x <= 1e-8 || r.max.y <= 1e-8,
        "Actual cutaway excludes the +X/+Y corner",
      );
    // Sampling inside each region also checks full/zero widths and invariant-Y ridges.
    const inside = (coordinate, period, width) =>
      width > 0 &&
      Math.abs(coordinate - Math.round(coordinate / period) * period) <
        width / 2 + 1e-8;
    for (const fx of [0.01, 0.5, 0.99])
      for (const fy of [0.01, 0.5, 0.99]) {
        const x = r.min.x + fx * r.size.x,
          y = r.min.y + fy * r.size.y;
        const material =
          layer.geometry === "homogeneous" ||
          (inside(
            x,
            px,
            layer.geometry === "rectangle_2d" ? layer.cd_x_nm : layer.cd_nm,
          ) &&
            (layer.geometry === "rectangle_1d" ||
              inside(y, py, layer.cd_y_nm)));
        assert.equal(
          r.role,
          material ? "material" : "background",
          `Layer ${r.layerIndex + 1} physical region role`,
        );
      }
    volume[r.layerIndex][r.role] += r.size.x * r.size.y * r.size.z;
    const optical = r.role === "background" ? layer.background : layer.material;
    if (!(optical.kind === "constant" && optical.n === 1 && optical.k === 0))
      visible++;
  }
  for (let i = 0; i < ranges.length; i++)
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i],
        b = ranges[j];
      const overlap = ["x", "y", "z"].every(
        (axis) =>
          Math.min(a.max[axis], b.max[axis]) -
            Math.max(a.min[axis], b.min[axis]) >
          1e-7,
      );
      assert.equal(overlap, false, "No overlapping physical region interiors");
    }
  project.layers.forEach((layer, i) => {
    const fraction = cutaway ? 0.75 : 1;
    const area =
      layer.geometry === "homogeneous"
        ? 9 * px * py
        : 9 *
          (layer.geometry === "rectangle_2d"
            ? layer.cd_x_nm * layer.cd_y_nm
            : layer.cd_nm * py);
    near(
      volume[i].material,
      fraction * area * layer.thickness_nm,
      `Layer ${i + 1} material volume`,
    );
    near(
      volume[i].background,
      fraction * (9 * px * py - area) * layer.thickness_nm,
      `Layer ${i + 1} background volume`,
    );
  });
  assert.equal(
    Number(scene.renderedRegionCount),
    visible,
    "Real air is empty; low-index regions remain solid",
  );
  const meshes = JSON.parse(scene.renderedMeshes);
  const solid = regions.filter((r) => {
    const layer = project.layers[r.layerIndex];
    const optical = r.role === "background" ? layer.background : layer.material;
    return !(optical.kind === "constant" && optical.n === 1 && optical.k === 0);
  });
  assert.equal(
    meshes.length,
    solid.length,
    "Actual THREE meshes match material-filled physical regions",
  );
  const scale = Number(scene.physicalScale);
  meshes.forEach((mesh, i) => {
    const region = solid[i];
    assert.equal(mesh.layerIndex, region.layerIndex);
    assert.equal(mesh.role, region.role);
    const positions = [
      region.center.x * scale,
      (region.center.z - total / 2) * scale,
      -region.center.y * scale,
    ];
    const sizes = [
      region.size.x * scale,
      region.size.z * scale,
      region.size.y * scale,
    ];
    positions.forEach((value, axis) =>
      near(mesh.position[axis], value, `Actual mesh ${i} position ${axis}`),
    );
    sizes.forEach((value, axis) =>
      near(mesh.size[axis], value, `Actual mesh ${i} size ${axis}`),
    );
  });
  return {
    physicalScale: scene.physicalScale,
    physicalBounds: JSON.parse(scene.physicalBounds),
    layerInterfaces: actualInterfaces,
    incidentDirection: incident,
    regionCount: regions.length,
    renderedRegionCount: visible,
    volume,
  };
}
export function assertFullResult(result, project) {
  assert.equal(result.schema_version, "1.2");
  assert.deepEqual(result.wavelengths_nm, project.illumination.wavelengths_nm);
  assert.deepEqual(
    Object.keys(result.spectra).sort(),
    project.illumination.polarization === "both"
      ? ["p", "s"]
      : [project.illumination.polarization],
  );
  const labels = [];
  for (
    let n = -project.solver.harmonics_y;
    n <= project.solver.harmonics_y;
    n++
  )
    for (
      let m = -project.solver.harmonics_x;
      m <= project.solver.harmonics_x;
      m++
    )
      labels.push([m, n]);
  assert.deepEqual(result.metadata.retained_orders, labels);
  assert.equal(result.metadata.basis_size, labels.length);
  assert.equal(result.metadata.convergence_checked, false);
  for (const series of Object.values(result.spectra)) {
    for (const key of [
      "R",
      "T",
      "R_specular",
      "T_specular",
      "A_balance",
      "orders",
    ])
      assert.equal(series[key].length, result.wavelengths_nm.length);
    series.orders.forEach((orders, i) => {
      assert.deepEqual(
        orders.map((order) => [order.m, order.n]),
        labels,
      );
      for (const order of orders) {
        for (const key of [
          "kx_over_k0",
          "ky_over_k0",
          "R",
          "T",
          "R_s",
          "R_p",
          "T_s",
          "T_p",
        ])
          assert.ok(Number.isFinite(order[key]), `Retained ${key}`);
        near(order.R, order.R_s + order.R_p, "Outgoing reflection channels");
        near(order.T, order.T_s + order.T_p, "Outgoing transmission channels");
      }
      near(
        series.R[i],
        orders.reduce((s, o) => s + o.R, 0),
        "Total reflection",
      );
      near(
        series.T[i],
        orders.reduce((s, o) => s + o.T, 0),
        "Total transmission",
      );
      const zero = orders.find((o) => o.m === 0 && o.n === 0);
      near(series.R_specular[i], zero.R, "(0,0) reflection");
      near(series.T_specular[i], zero.T, "(0,0) transmission");
      near(
        series.A_balance[i],
        1 - series.R[i] - series.T[i],
        "Absorption balance",
      );
    });
  }
}
export async function replayTouch(page, points, moves) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: points,
    });
    for (const touchPoints of moves)
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints,
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
  } finally {
    await session.detach();
  }
}
