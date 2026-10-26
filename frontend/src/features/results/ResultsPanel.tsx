import { useEffect, useState } from "react";
import type { EngineState } from "../../engine";
import { useServices } from "../../state/context";
import { useStore } from "../../state/store";
import { SpectrumView } from "./SpectrumView";

function Status() {
  const status = useStore((s) => s.status);
  const full = useStore((s) => s.full);
  const key = useStore((s) => s.key);
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
        <span>{status.phase === "preview" ? "Previewing your edit…" : "Waiting for edits to settle"}</span>
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
  return (
    <section className="results" aria-label="Results">
      <div className="results-head">
        <h2 className="results-title">Spectrum</h2>
        <Status />
      </div>
      <div className="results-body">
        <SpectrumView />
      </div>
    </section>
  );
}
