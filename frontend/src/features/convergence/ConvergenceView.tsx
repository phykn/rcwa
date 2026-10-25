import { useMemo, useRef, useState } from "react";
import { series, type PolView } from "../../core/spectrum";
import type { Design, SpectrumResult } from "../../engine/types";
import { useServices } from "../../state/context";
import { useStore } from "../../state/store";
import { SpectrumChart, type ChartLayer } from "../results/SpectrumChart";

const MAX_ORDERS = 5;
const TOLERANCE = 0.005;

interface Check {
  key: string;
  runs: { orders: [number, number]; result: SpectrumResult }[];
}

/** Axes the stack is patterned along; orders on any other axis change nothing. */
function patternedAxes(design: Design): [boolean, boolean] {
  const kinds = design.layers.map((layer) => layer.geometry);
  return [
    kinds.some((kind) => kind !== "homogeneous"),
    kinds.some((kind) => kind === "rectangle_2d" || kind === "circular_hole_2d"),
  ];
}

/**
 * Orders to compare: the design's own and one step finer on every patterned axis,
 * or one step coarser when any of them is already at the limit. Stepping only the
 * axes that can still rise would leave a maxed-out axis (5×1 lines) untested.
 */
export function ladder(design: Design): [number, number][] {
  const own: [number, number] = [design.solver.harmonics_x, design.solver.harmonics_y];
  const axes = patternedAxes(design);
  const step = (delta: number) =>
    own.map((h, i) => (axes[i] ? Math.min(MAX_ORDERS, Math.max(1, h + delta)) : h)) as [number, number];
  const canRise = own.every((h, i) => !axes[i] || h < MAX_ORDERS);
  return canRise ? [own, step(1)] : [step(-1), own];
}

export default function ConvergenceView() {
  const design = useStore((s) => s.design);
  const key = useStore((s) => s.key);
  const cursor = useStore((s) => s.cursor);
  const setCursor = useStore((s) => s.setCursor);
  const pol = useStore((s) => s.settings.polarization) as PolView;
  const { hub } = useServices();
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);

  async function run() {
    abort.current?.abort();
    const controller = (abort.current = new AbortController());
    setBusy(true);
    setError("");
    try {
      // One after the other: the server admits a single 2D job at a time.
      const runs = [];
      for (const orders of ladder(design)) {
        const result = await hub.engine.solve(
          { ...design, solver: { harmonics_x: orders[0], harmonics_y: orders[1] } },
          { signal: controller.signal, priority: "interactive" },
        );
        runs.push({ orders, result });
      }
      if (!controller.signal.aborted) setCheck({ key, runs });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  }

  const summary = useMemo(() => {
    if (!check) return null;
    const [a, b] = check.runs.map((r) => series(r.result, pol));
    let worst = 0;
    let at = a.wavelengths[0];
    for (let i = 0; i < a.R.length; i++) {
      const d = Math.max(Math.abs(a.R[i] - b.R[i]), Math.abs(a.T[i] - b.T[i]));
      if (d > worst) {
        worst = d;
        at = a.wavelengths[i];
      }
    }
    const layers: ChartLayer[] = check.runs.map((r, i) => ({
      id: `h${i}`,
      label: `${r.orders.join("×")} orders`,
      series: series(r.result, pol),
      kind: i === check.runs.length - 1 ? "main" : "overlay",
    }));
    return { worst, at, layers };
  }, [check, pol]);

  const [lo, hi] = ladder(design);
  const atLimit = hi[0] === design.solver.harmonics_x && hi[1] === design.solver.harmonics_y && (lo[0] !== hi[0] || lo[1] !== hi[1]);
  return (
    <div className="analysis">
      <p className="analysis-note">
        RCWA truncates the Fourier series. If the spectrum barely changes with more orders, the result has converged for this design.
        This compares ±{lo.join("×")} with ±{hi.join("×")} orders.
      </p>
      <div className="analysis-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run()}>
          {busy ? "Checking…" : "Check convergence"}
        </button>
        {check && check.key !== key && <span className="stale-note">This check belongs to earlier inputs.</span>}
      </div>
      {error && <p className="field-error">{error}</p>}
      {check && summary && (
        <>
          <div className={`verdict ${summary.worst < TOLERANCE ? "verdict-good" : "verdict-poor"}`} role="status">
            <strong>{summary.worst < TOLERANCE ? "Converged" : "Not converged"}.</strong>{" "}
            The largest change in R or T is {(summary.worst * 100).toFixed(2)} percentage points, at {summary.at} nm.{" "}
            {summary.worst < TOLERANCE
              ? "The spectrum is stable to within 0.5 points."
              : atLimit
                ? "The design already uses the most orders this app allows; treat sharp features with care."
                : "Raise the orders in Lattice until this check passes."}
          </div>
          <SpectrumChart layers={summary.layers} showSpecular={false} showAbsorption={false} cursor={cursor} onCursor={setCursor} height={240} />
          <p className="analysis-note">Solid: {check.runs[check.runs.length - 1].orders.join("×")} orders. Dotted: {check.runs[0].orders.join("×")}.</p>
        </>
      )}
    </div>
  );
}
