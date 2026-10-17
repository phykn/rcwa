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

/** Orders to compare: the design's own and one step finer, or one coarser at the limit. */
function ladder(design: Design): [number, number][] {
  const { harmonics_x: hx, harmonics_y: hy } = design.solver;
  const up: [number, number] = [Math.min(MAX_ORDERS, hx + 1), Math.min(MAX_ORDERS, hy + 1)];
  if (up[0] !== hx || up[1] !== hy) return [[hx, hy], up];
  return [[Math.max(1, hx - 1), Math.max(1, hy - 1)], [hx, hy]];
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
      const runs = await Promise.all(
        ladder(design).map(async (orders) => ({
          orders,
          result: await hub.engine.solve(
            { ...design, solver: { harmonics_x: orders[0], harmonics_y: orders[1] } },
            { signal: controller.signal, priority: "interactive" },
          ),
        })),
      );
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
              : hi[0] >= MAX_ORDERS && hi[1] >= MAX_ORDERS
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
