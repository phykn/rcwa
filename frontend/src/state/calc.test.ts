import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATES } from "../core/templates";
import type { EngineHub } from "../engine";
import { EngineError, type Design, type SolveOptions, type SpectrumResult } from "../engine/types";
import { connectCalculation, type Calculation } from "./calc";
import { useStore } from "./store";

interface Pending {
  design: Design;
  options: SolveOptions;
  resolve: (r: SpectrumResult) => void;
  reject: (e: unknown) => void;
}

let pending: Pending[];
let calc: Calculation;

function fakeHub() {
  return {
    setPreference: () => {},
    engine: {
      kind: "browser",
      validate: async () => [],
      solve: (design: Design, options: SolveOptions = {}) =>
        new Promise<SpectrumResult>((resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          pending.push({ design, options, resolve, reject });
        }),
    },
  } as unknown as EngineHub;
}

const result = (n: number) => ({ wavelengths_nm: Array(n).fill(0) }) as unknown as SpectrumResult;
const setThickness = (t: number) =>
  useStore.getState().edit((d) => ({ ...d, layers: d.layers.map((l, i) => (i ? l : { ...l, thickness_nm: t })) }));

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  useStore.setState({ full: null, preview: null, ghost: null, gesture: false });
  useStore.getState().updateSettings({ autoSolve: true });
  useStore.getState().replace(TEMPLATES[0].design);
  calc = connectCalculation(fakeHub());
});

afterEach(() => {
  calc.dispose();
  vi.useRealTimers();
});

describe("calculation controller", () => {
  it("previews quickly, then solves at full accuracy once edits pause", async () => {
    await vi.advanceTimersByTimeAsync(130);
    expect(pending.map((p) => p.options.priority)).toEqual(["preview"]);
    expect(pending[0].design.solver.harmonics_x).toBe(2);
    pending[0].resolve(result(13));
    await vi.advanceTimersByTimeAsync(600);
    expect(pending[1].options.priority).toBe("interactive");
    expect(pending[1].design).toEqual(useStore.getState().design);
    pending[1].resolve(result(21));
    await vi.runOnlyPendingTimersAsync();
    expect(useStore.getState().full!.key).toBe(useStore.getState().key);
    expect(useStore.getState().status.phase).toBe("idle");
  });

  it("aborts superseded work and never applies it", async () => {
    await vi.advanceTimersByTimeAsync(700);
    const stale = pending[1];
    setThickness(123);
    await Promise.resolve();
    expect(stale.options.signal!.aborted).toBe(true);
    stale.resolve(result(21));
    await vi.advanceTimersByTimeAsync(700);
    expect(useStore.getState().full).toBeNull();
  });

  it("waits for a drag to end before the full solve", async () => {
    useStore.getState().beginGesture();
    setThickness(100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pending.every((p) => p.options.priority === "preview")).toBe(true);
    useStore.getState().endGesture();
    await vi.advanceTimersByTimeAsync(700);
    expect(pending.some((p) => p.options.priority === "interactive")).toBe(true);
  });

  it("reports invalid designs and engine errors without calculating", async () => {
    useStore.getState().edit((d) => ({ ...d, period_nm: 30 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(useStore.getState().status).toMatchObject({ phase: "error", error: { code: "invalid_design" } });
    const before = pending.length;
    useStore.getState().undo();
    await vi.advanceTimersByTimeAsync(700);
    pending.at(-1)!.reject(new EngineError("rayleigh_cutoff", "At a cutoff"));
    await vi.runOnlyPendingTimersAsync();
    expect(pending.length).toBeGreaterThan(before);
    expect(useStore.getState().status.error).toMatchObject({ code: "rayleigh_cutoff" });
  });
});
