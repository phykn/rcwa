// Extends the existing spectrum session. No extra browser or solver process.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { expect } from "@playwright/test";
import {
  applyImportedDesign,
  capture,
  exportWorkspace,
  importText,
  menuAction,
} from "./browser-2d-controls.mjs";
import {
  orderFixture,
  pOnlyOrderFixture,
} from "./order-inspector-fixtures.mjs";

import {
  checkOrderScroll,
  captureOrderFailure,
  observeOrderScroll,
} from "./order-scroll-evidence.mjs";

const exact = (value) => (Object.is(value, -0) ? "-0" : String(value));
const classes = {
  propagating: "Propagating",
  evanescent: "Evanescent",
  absorbing_half_space: "Absorbing half-space",
};
export async function assertOrders(
  page,
  result,
  polarization,
  index,
  channels = false,
) {
  const rows = result.spectra[polarization].orders[index]
    .map((row, retainedIndex) => ({ row, retainedIndex }))
    .sort(
      (a, b) =>
        Math.max(Math.abs(b.row.R), Math.abs(b.row.T)) -
          Math.max(Math.abs(a.row.R), Math.abs(a.row.T)) ||
        a.retainedIndex - b.retainedIndex,
    )
    .map(({ row }) => row);
  await expect(page.locator(".order-sample")).toHaveText(
    `${result.wavelengths_nm[index]} nm · Incident ${polarization} · All ${rows.length} retained orders`,
  );
  const actual = await page
    .locator(".order-table tbody tr")
    .evaluateAll((elements) =>
      elements.map((row) => ({
        label: row.dataset.order,
        powers: Object.fromEntries(
          [...row.querySelectorAll(".order-power")].map((power) => [
            power.dataset.field,
            power.dataset.value,
          ]),
        ),
        classes: [...row.querySelectorAll(".order-class")].map(
          (node) => node.textContent,
        ),
      })),
    );
  const displayed = await page.locator(".order-power").evaluateAll((nodes) =>
    nodes.map((node) => ({
      exact: node.dataset.value,
      text:
        node.querySelector('[aria-hidden="true"]')?.textContent ??
        node.textContent,
      accessible:
        node.querySelector(".sr-only")?.textContent ?? node.textContent,
    })),
  );
  for (const value of displayed) {
    const original = Number(value.exact),
      visible = Number(value.text);
    assert.equal(value.accessible, value.exact);
    if (original === 0)
      assert.ok(
        Object.is(visible, original),
        "Visible signed zero is preserved",
      );
    else {
      assert.equal(
        Math.sign(visible),
        Math.sign(original),
        "Visible tiny contributions retain their sign and never become zero",
      );
      assert.ok(
        Math.abs((visible - original) / original) <= 5e-4,
        "Compact values match stored powers to display precision",
      );
    }
  }
  assert.deepEqual(
    actual,
    rows.map((row) => ({
      label: `${row.m},${row.n}`,
      powers: Object.fromEntries(
        (channels ? ["R", "R_s", "R_p", "T", "T_s", "T_p"] : ["R", "T"]).map(
          (field) => [field, exact(row[field])],
        ),
      ),
      classes: [
        row.reflection_propagating ? "Propagating" : "Evanescent",
        classes[row.transmission_class],
      ],
    })),
    "Every retained row, exact signed power and stored port class matches the selected sample",
  );
}

async function inspectOrdersSession(
  page,
  report,
  output,
  width,
  imported,
  retainedIndex,
) {
  report.orderStage = `${width}px: open inspector and exact/local components`;
  const multipleOpen = orderFixture("multiple-open-channels");
  const absorbing = orderFixture("lossy-mixed-eight-layer");
  const inspector = page.locator(".diffraction-orders");
  const summary = inspector.locator("summary");
  const exactOption = page.getByRole("checkbox", {
    name: "Exact values",
    exact: true,
  });
  const channelOption = page.getByRole("checkbox", {
    name: "Outgoing local s/p",
    exact: true,
  });
  const region = page.getByRole("region", {
    name: "All retained diffraction orders",
    exact: true,
  });
  const quantity = page.getByLabel("Spectrum quantity");
  await expect(inspector).not.toHaveAttribute("open", "");
  await summary.focus();
  await summary.press("Enter");
  await expect(inspector).toHaveAttribute("open", "");
  await page.keyboard.press("Tab");
  await expect(exactOption).toBeFocused();
  await exactOption.press("Space");
  await page.keyboard.press("Tab");
  await expect(channelOption).toBeFocused();
  await channelOption.press("Space");

  // Replace an open inspector without losing surviving checkbox focus/options.
  report.orderStage = `${width}px: replace with real multiple-open result`;
  await imported(page, multipleOpen, "orders-multiple-open");
  await expect(channelOption).toBeFocused();
  await expect(exactOption).toBeChecked();
  await expect(channelOption).toBeChecked();
  await assertOrders(page, multipleOpen.result, "s", 0, true);
  await expect(inspector).toContainText("outgoing local port components");
  await expect(inspector).toContainText(
    "Largest power magnitudes first; all orders shown.",
  );
  if (width === 1440) {
    await inspector.evaluate((node) =>
      window.scrollTo(0, node.getBoundingClientRect().top + scrollY - 12),
    );
    await capture(page, report, output, "orders-initial-open-1440", {
      prefix: "spectrum",
      top: false,
      full: false,
    });
  }
  await page.keyboard.press("Tab");
  await expect(region).toBeFocused();
  await region.press("End");
  await checkOrderScroll(
    page,
    report,
    width,
    "initial table End reaches bottom",
    "bottom",
  );
  await expect(page.locator(".order-table tbody tr").last()).toBeInViewport();
  await region.press("Home");
  await checkOrderScroll(
    page,
    report,
    width,
    "initial table Home returns top",
    "top",
  );

  // Changing result, wavelength, or polarization resets only the table's scroll.
  // Read the genuine circular reference; no values are generated or interpolated.
  const circular = JSON.parse(
    await fs.readFile(
      new URL("../public/reference-circular.json", import.meta.url),
      "utf8",
    ),
  );
  await region.press("End");
  report.orderStage = `${width}px: replace with circular multi-sample result`;
  await imported(page, circular, "orders-multisample-scroll");
  await expect(region).toBeFocused();
  await checkOrderScroll(
    page,
    report,
    width,
    "circular result replacement resets table",
    "top",
  );
  const slider = page.getByRole("slider", {
    name: "Inspect wavelength sample",
    exact: true,
  });
  // The preceding suite chose the last sample. A single-wavelength result
  // clamps only the displayed index; restoring this grid retains that selection.
  // Result replacement resets the table's scroll, not the plot's sample index.
  assert.equal(retainedIndex, circular.result.wavelengths_nm.length - 1);
  await expect(slider).toHaveValue(String(retainedIndex));
  await expect(page.locator(".sample-wavelength strong")).toHaveText(
    `${circular.result.wavelengths_nm[retainedIndex]} nm`,
  );
  await assertOrders(page, circular.result, "s", retainedIndex, true);

  // Both Home and End must change the selected sample, reset only table scroll,
  // and leave focus on the wavelength control. Never rely on an implicit reset.
  for (const [key, index] of [
    ["Home", 0],
    ["End", retainedIndex],
  ]) {
    report.orderStage = `${width}px: settled wavelength ${key} transition`;
    await region.focus();
    await region.press("End");
    await checkOrderScroll(
      page,
      report,
      width,
      `before wavelength ${key}: End reaches bottom`,
      "bottom",
    );
    await slider.focus();
    await slider.press(key);
    await expect(slider).toBeFocused();
    await expect(slider).toHaveValue(String(index));
    await expect(page.locator(".sample-wavelength strong")).toHaveText(
      `${circular.result.wavelengths_nm[index]} nm`,
    );
    await checkOrderScroll(
      page,
      report,
      width,
      `wavelength ${key} resets table`,
      "top",
    );
    await assertOrders(page, circular.result, "s", index, true);
  }
  await region.focus();
  await region.press("End");
  await checkOrderScroll(
    page,
    report,
    width,
    "rapid End starts before wavelength Home",
    "moved",
  );
  report.orderStage = `${width}px: rapid native End then wavelength Home`;
  report.rapidOrderScroll ??= [];
  report.rapidOrderScroll.push({
    width,
    beforeSampleChange: await observeOrderScroll(page),
  });
  await slider.focus();
  await slider.press("Home");
  await expect(slider).toBeFocused();
  await expect(slider).toHaveValue("0");
  await expect(page.locator(".sample-wavelength strong")).toHaveText(
    `${circular.result.wavelengths_nm[0]} nm`,
  );
  await checkOrderScroll(
    page,
    report,
    width,
    "rapid End then wavelength Home resets table",
    "top",
  );
  await assertOrders(page, circular.result, "s", 0, true);
  await region.focus();
  await region.press("End");
  await checkOrderScroll(
    page,
    report,
    width,
    "before incident p: End reaches bottom",
    "bottom",
  );
  report.orderStage = `${width}px: incident-polarization change`;
  const pButton = page.getByRole("button", { name: "p / TM", exact: true });
  await pButton.click();
  await expect(pButton).toBeFocused();
  await checkOrderScroll(page, report, width, "incident p resets table", "top");
  await assertOrders(page, circular.result, "p", 0, true);
  await imported(page, multipleOpen, "orders-multiple-open-return");
  await assertOrders(page, multipleOpen.result, "s", 0, true);
  await region.focus();
  await region.press("End");
  await checkOrderScroll(
    page,
    report,
    width,
    "before display options: End reaches bottom",
    "bottom",
  );
  report.orderStage = `${width}px: exact/local-component display toggles`;
  await exactOption.uncheck();
  await checkOrderScroll(
    page,
    report,
    width,
    "exact-values toggle retains nonzero table scroll",
    "moved",
  );
  await channelOption.uncheck();
  await checkOrderScroll(
    page,
    report,
    width,
    "local-components toggle retains nonzero table scroll",
    "moved",
  );
  await region.focus();
  await region.press("Home");
  await checkOrderScroll(
    page,
    report,
    width,
    "table Home after display options",
    "top",
  );
  await assertOrders(page, multipleOpen.result, "s", 0);
  await page
    .locator('.order-table [data-order="0,0"]')
    .scrollIntoViewIfNeeded();
  const measures = await inspector.evaluate((node) => ({
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
    tableOverflow:
      node.querySelector(".order-table-scroll").scrollWidth >
      node.querySelector(".order-table-scroll").clientWidth,
    numericFont: parseFloat(
      getComputedStyle(node.querySelector(".order-power")).fontSize,
    ),
    rows: node.querySelectorAll("tbody tr").length,
    summaryHeight: node.querySelector("summary").getBoundingClientRect().height,
    optionHeights: [...node.querySelectorAll(".order-options label")].map(
      (item) => item.getBoundingClientRect().height,
    ),
  }));
  assert.equal(measures.pageOverflow, false);
  assert.equal(measures.tableOverflow, false);
  assert.equal(measures.rows, 121);
  assert.ok(measures.numericFont >= 12);
  assert.ok(measures.summaryHeight >= 44);
  assert.ok(measures.optionHeights.every((height) => height >= 44));
  // Frame the disclosure/context and strongest rows together on narrow screens.
  await inspector.evaluate((node) =>
    window.scrollTo(0, node.getBoundingClientRect().top + scrollY - 12),
  );
  await capture(page, report, output, `orders-open-${width}`, {
    prefix: "spectrum",
    top: false,
    full: false,
  });

  // P-only is explicitly a selection fixture projected from archived p data.
  // No powers or wavelengths are synthesized, and import provenance stays unverified.
  report.orderStage = `${width}px: p-only result replacement`;
  const pOnly = pOnlyOrderFixture();
  await imported(page, pOnly, "orders-p-only-selection");
  await expect(
    page.getByRole("button", { name: "s / TE", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "p / TM", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await assertOrders(page, pOnly.result, "p", 0);

  await exactOption.check();
  await channelOption.check();
  report.orderStage = `${width}px: absorbing unequal-basis result replacement`;
  await imported(page, absorbing, "orders-absorbing-unequal-basis");
  await assertOrders(page, absorbing.result, "s", 0, true);
  await expect(inspector).toContainText(
    "T is interface flux into the absorbing substrate, not backside transmission.",
  );
  await expect(page.locator(".order-table tbody tr")).toHaveCount(99);
  // Exact values are visible text, not merely tooltip/data attributes.
  const exactCells = await page
    .locator(".order-power")
    .evaluateAll((nodes) =>
      nodes.every((node) => node.textContent === node.dataset.value),
    );
  assert.equal(exactCells, true);
  await page
    .locator('.order-table [data-order="0,0"]')
    .scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  // Frame the disclosure/context and strongest rows together on narrow screens.
  await inspector.evaluate((node) =>
    window.scrollTo(0, node.getBoundingClientRect().top + scrollY - 12),
  );
  await capture(page, report, output, `orders-absorbing-exact-${width}`, {
    prefix: "spectrum",
    top: false,
    full: false,
  });

  report.orderStage = `${width}px: input-only edit, stale result, and undo/redo`;
  const before = (await exportWorkspace(page, output, `orders-before-${width}`))
    .data;
  const edited = structuredClone(absorbing.project);
  edited.substrate = { ...edited.substrate, n: 1.5, k: 0 };
  edited.period_y_nm += 1;
  await importText(page, { project: edited }, "orders-edit-inputs-only");
  await applyImportedDesign(page);
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  await assertOrders(page, absorbing.result, "s", 0, true);
  const stale = (await exportWorkspace(page, output, `orders-stale-${width}`))
    .data;
  assert.deepEqual(stale.project, edited);
  assert.deepEqual(stale.result_project, absorbing.project);
  assert.deepEqual(stale.result, before.result);
  await menuAction(page, "↶ Undo");
  await expect(page.locator(".result-badge")).toHaveText("Unverified import");
  await assertOrders(page, absorbing.result, "s", 0, true);
  await menuAction(page, "↷ Redo");
  await expect(page.locator(".result-badge")).toHaveText("Inputs changed");
  await assertOrders(page, absorbing.result, "s", 0, true);

  // Removing the focused inspector moves only its keyboard user to the plot.
  report.orderStage = `${width}px: legacy and no-result focus transitions`;
  const legacy = JSON.parse(
    await fs.readFile(
      new URL("../public/reference-example.json", import.meta.url),
      "utf8",
    ),
  );
  await region.focus();
  await imported(page, legacy, "orders-legacy-replacement");
  await expect(inspector).toHaveCount(0);
  await expect(quantity).toBeFocused();
  await imported(page, absorbing, "orders-restored");
  await quantity.focus();
  await importText(page, { project: legacy.project }, "orders-no-result");
  await expect(page.locator(".result-badge")).toHaveText("No result yet");
  await expect(inspector).toHaveCount(0);
  await expect(quantity).toBeFocused();
  await imported(page, absorbing, "orders-restored-again");
  await summary.focus();
  await summary.press("Enter");
  await region.focus();
  await importText(
    page,
    { project: legacy.project },
    "orders-focused-no-result",
  );
  await expect(page.locator(".result-badge")).toHaveText("No result yet");
  await expect(inspector).toHaveCount(0);
  await expect(quantity).toBeFocused();
  report.checks.push(
    `${width}px orders: all exact keyed rows/classifications; 121-row real multi-open and 99-row absorbing Hx5/Hy4 fixtures; keyboard disclosure/options/scroll; strongest-first copied sorting; retained-index result replacement; settled and rapid Home/End sample changes and sample/result scroll reset without focus theft; readable compact and visible exact local-channel values; p-only selection projection; unchanged stale result despite substrate edit; Undo/Redo; open replacement focus; legacy/no-result removal; no new solves`,
  );
}

export async function inspectOrders(
  page,
  report,
  output,
  width,
  imported,
  retainedIndex,
) {
  try {
    await inspectOrdersSession(
      page,
      report,
      output,
      width,
      imported,
      retainedIndex,
    );
  } catch (error) {
    await captureOrderFailure(page, report, output, width, error);
    throw error;
  }
}
