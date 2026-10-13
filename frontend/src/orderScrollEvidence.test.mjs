import { afterEach, describe, expect, it, vi } from "vitest";
import { capture } from "../scripts/browser-2d-controls.mjs";
import {
  captureOrderFailure,
  checkOrderScroll,
} from "../scripts/order-scroll-evidence.mjs";

vi.mock("../scripts/browser-2d-controls.mjs", () => ({ capture: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const state = (scrollTop) => ({
  sample: "450 nm · Incident s · All 121 retained orders",
  plotWavelength: "450 nm",
  sliderValue: "0",
  scrollTop,
  scrollHeight: 13200,
  clientHeight: 390,
  maxScrollTop: 12810,
  activeElement: { tag: "INPUT", id: "wavelength-sample", tableFocused: false },
});

describe("order-inspector CI evidence", () => {
  it("records named before/polled states with exact sample, focus and scroll", async () => {
    const page = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(state(12810))
        .mockResolvedValue(state(0)),
    };
    const report = {};
    await checkOrderScroll(
      page,
      report,
      360,
      "wavelength Home resets table",
      "top",
    );
    expect(report.orderScrollCheckpoints).toHaveLength(1);
    const item = report.orderScrollCheckpoints[0];
    expect(item).toMatchObject({
      name: "360px: wavelength Home resets table",
      status: "passed",
      target: "top",
    });
    expect(item.observations[0]).toMatchObject(state(12810));
    expect(item.observations.at(-1)).toMatchObject(state(0));
  });
  it("allows fractional-pixel rounding only for a settled positive-extent bottom", async () => {
    const page = { evaluate: vi.fn().mockResolvedValue(state(12809.7)) };
    const report = {};
    await checkOrderScroll(page, report, 390, "End reaches bottom", "bottom");
    expect(report.orderScrollCheckpoints[0]).toMatchObject({
      target: "bottom",
      status: "passed",
    });
    expect(
      report.orderScrollCheckpoints[0].observations.at(-1).maxScrollTop,
    ).toBe(12810);
  });
  it("rejects a transient zero if scrolling resumes on the next frame", async () => {
    const page = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(state(0))
        .mockResolvedValueOnce(state(0))
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(state(12810)),
    };
    const report = {};
    await expect(
      checkOrderScroll(page, report, 360, "rapid sample reset", "top"),
    ).rejects.toThrow("remains top after frame 1");
    expect(report.orderScrollCheckpoints[0].status).toBe("failed");
    expect(report.orderScrollCheckpoints[0].observations.at(-1).scrollTop).toBe(
      12810,
    );
  });
  it("records a checkpoint failure without suppressing the original error", async () => {
    const error = Error("Context lost while observing table");
    const page = { evaluate: vi.fn().mockRejectedValue(error) };
    const report = {};
    await expect(
      checkOrderScroll(page, report, 390, "result replacement", "top"),
    ).rejects.toBe(error);
    expect(report.orderScrollCheckpoints[0]).toMatchObject({
      name: "390px: result replacement",
      status: "failed",
      error: String(error),
    });
  });
  it("captures the unchanged failure viewport with the existing bounded helper", async () => {
    const page = { evaluate: vi.fn().mockResolvedValue(state(12810)) };
    const report = { orderStage: "360px: settled wavelength Home transition" };
    const error = Error("named strict top reset failed");
    await captureOrderFailure(page, report, "/artifacts", 360, error);
    expect(report.orderFailure).toEqual({
      width: 360,
      stage: report.orderStage,
      error: String(error),
      state: state(12810),
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      page,
      report,
      "/artifacts",
      "orders-failure-360",
      { prefix: "spectrum", top: false, full: false },
    );
  });
  it("retains both original failure and capture error if evidence capture fails", async () => {
    capture.mockRejectedValueOnce(Error("bounded screenshot failed"));
    const page = { evaluate: vi.fn().mockResolvedValue(state(12810)) };
    const report = { orderStage: "390px: rapid scroll" };
    await expect(
      captureOrderFailure(
        page,
        report,
        "/artifacts",
        390,
        Error("reset failed"),
      ),
    ).resolves.toBeUndefined();
    expect(report.orderFailure.error).toBe("Error: reset failed");
    expect(report.orderFailure.captureError).toBe(
      "Error: bounded screenshot failed",
    );
  });
});
