import { lazy, Suspense, useEffect, useState } from "react";
import type { EngineState } from "../../engine";
import { useServices } from "../../state/context";
import { useStore } from "../../state/store";
import { OrdersTable } from "./OrdersTable";
import { SpectrumView } from "./SpectrumView";

const SweepView = lazy(() => import("../sweep/SweepView"));
const FieldView = lazy(() => import("../field/FieldView"));
const ConvergenceView = lazy(() => import("../convergence/ConvergenceView"));
const FitView = lazy(() => import("../fit/FitView"));

const ALL_TABS = [
  { id: "spectrum", label: "Spectrum", advanced: false },
  { id: "orders", label: "Orders", advanced: true },
  { id: "sweep", label: "Sweep", advanced: false },
  { id: "field", label: "Field", advanced: false },
  { id: "convergence", label: "Convergence", advanced: true },
  { id: "fit", label: "Fit", advanced: false },
] as const;

function Status() {
  const status = useStore((s) => s.status);
  const full = useStore((s) => s.full);
  const key = useStore((s) => s.key);
  const autoSolve = useStore((s) => s.settings.autoSolve);
  const { calc, hub } = useServices();
  const [engine, setEngine] = useState<EngineState>(hub.state);
  useEffect(() => hub.subscribe(setEngine), [hub]);
  const current = full?.key === key;
  const starting = engine.active === "browser" && engine.browser.phase !== "ready";
  if (status.phase === "error" && status.error)
    return (
      <div className="status status-error" role="alert">
        <span>{status.error.message}</span>
      </div>
    );
  if (starting && engine.browser.phase === "failed")
    return (
      <div className="status status-error" role="alert">
        <span>{engine.browser.detail}</span>
      </div>
    );
  if (starting && !current && (status.phase === "solving" || status.phase === "preview"))
    return (
      <div className="status status-busy" role="status">
        <span className="progress progress-indeterminate" />
        <span>Starting the in-browser engine. The first visit downloads about 25 MB.</span>
      </div>
    );
  if (status.phase === "solving")
    return (
      <div className="status status-busy" role="status">
        <span className="progress" style={{ "--done": status.total ? status.done / status.total : 0 } as React.CSSProperties} />
        <span>
          Calculating {status.done} of {status.total} wavelengths
        </span>
        <button type="button" className="btn btn-quiet" onClick={calc.cancel}>
          Stop
        </button>
      </div>
    );
  if (!current)
    return (
      <div className="status" role="status">
        <span>{status.phase === "preview" ? "Previewing your edit…" : autoSolve ? "Waiting for edits to settle" : "Inputs changed"}</span>
        <button type="button" className="btn btn-primary" onClick={calc.solveNow}>
          Calculate
        </button>
      </div>
    );
  return (
    <div className="status status-ok" role="status">
      <span>
        Calculated in {full!.result.elapsedSeconds.toFixed(1)} s{full!.result.engine === "server" ? " on the local server" : ""}
      </span>
    </div>
  );
}

export function ResultsPanel() {
  const advanced = useStore((s) => s.settings.advanced);
  const TABS = ALL_TABS.filter((t) => advanced || !t.advanced);
  const chosen = useStore((s) => s.tab);
  const tab = TABS.some((t) => t.id === chosen) ? chosen : "spectrum";
  const setTab = useStore((s) => s.setTab);
  const full = useStore((s) => s.full);
  const pol = useStore((s) => s.settings.polarization);
  const cursor = useStore((s) => s.cursor);
  return (
    <section className="results" aria-label="Results">
      <div className="results-head">
        <div role="tablist" aria-label="Result views" className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={tab === t.id ? "on" : ""}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                const i = TABS.findIndex((x) => x.id === tab);
                const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (!d) return;
                const next = TABS[(i + d + TABS.length) % TABS.length];
                setTab(next.id);
                document.getElementById(`tab-${next.id}`)?.focus();
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Status />
      </div>
      <div className="results-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        <Suspense fallback={<p className="empty-note">Loading…</p>}>
          {tab === "spectrum" && <SpectrumView />}
          {tab === "orders" &&
            (full ? (
              <OrdersTable result={full.result} pol={pol} cursor={cursor} />
            ) : (
              <p className="empty-note">Orders appear after the first full calculation.</p>
            ))}
          {tab === "sweep" && <SweepView />}
          {tab === "field" && <FieldView />}
          {tab === "convergence" && <ConvergenceView />}
          {tab === "fit" && <FitView />}
        </Suspense>
      </div>
    </section>
  );
}
