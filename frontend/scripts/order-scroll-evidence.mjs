// Observe only. No scroll setters, input mutation or timeout changes in evidence.
import { expect } from "@playwright/test";
import { capture } from "./browser-2d-controls.mjs";

export async function observeOrderScroll(page) {
  return page.evaluate(() => {
    const table = document.querySelector(".order-table-scroll");
    const active = document.activeElement;
    const slider = document.querySelector("#wavelength-sample");
    return {
      sample: document.querySelector(".order-sample")?.textContent ?? null,
      plotWavelength:
        document.querySelector(".sample-wavelength strong")?.textContent ??
        null,
      sliderValue: slider?.value ?? null,
      scrollTop: table?.scrollTop ?? null,
      scrollHeight: table?.scrollHeight ?? null,
      clientHeight: table?.clientHeight ?? null,
      maxScrollTop: table ? table.scrollHeight - table.clientHeight : null,
      overflowAnchor: table ? getComputedStyle(table).overflowAnchor : null,
      activeElement: active
        ? {
            tag: active.tagName,
            id: active.id,
            label: active.getAttribute("aria-label"),
            type: active.getAttribute("type"),
            tableFocused: active === table,
          }
        : null,
    };
  });
}

export async function checkOrderScroll(page, report, width, name, target) {
  const item = {
    name: `${width}px: ${name}`,
    target,
    status: "running",
    observations: [],
  };
  (report.orderScrollCheckpoints ??= []).push(item);
  const started = Date.now();
  const read = async () => {
    const state = await observeOrderScroll(page);
    item.observations.push({ elapsedMs: Date.now() - started, ...state });
    // Five-second default polling is already bounded; retain a hard sample cap too.
    if (item.observations.length > 32) item.observations.splice(1, 1);
    if (state.scrollTop === null || state.maxScrollTop === null) return null;
    if (target === "bottom")
      return state.maxScrollTop > 0
        ? Math.abs(state.maxScrollTop - state.scrollTop)
        : Infinity;
    return state.scrollTop;
  };
  try {
    // Record the initial state before starting the assertion, even if it fails.
    await read();
    const pending = expect.poll(read, { message: item.name });
    if (target === "moved") await pending.toBeGreaterThan(0);
    // scrollTop can be fractional while scrollHeight/clientHeight are rounded.
    // This tolerance is only for reaching bottom, never for the exact top reset.
    else if (target === "bottom") await pending.toBeLessThanOrEqual(1);
    else await pending.toBe(0);
    if (target === "top") {
      // Do not accept a transient zero while an earlier native scroll resumes.
      for (let frame = 1; frame <= 2; frame++) {
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(resolve)),
        );
        expect(
          await read(),
          `${item.name}: remains top after frame ${frame}`,
        ).toBe(0);
      }
    }
    item.status = "passed";
  } catch (error) {
    item.status = "failed";
    item.error = String(error);
    throw error;
  }
}

export async function captureOrderFailure(page, report, output, width, error) {
  report.orderFailure = {
    width,
    stage: report.orderStage,
    error: String(error),
  };
  try {
    report.orderFailure.state = await observeOrderScroll(page);
    // Capture the current failed viewport before scrolling or closing anything.
    await capture(page, report, output, `orders-failure-${width}`, {
      prefix: "spectrum",
      top: false,
      full: false,
    });
  } catch (captureError) {
    report.orderFailure.captureError = String(captureError);
  }
}
