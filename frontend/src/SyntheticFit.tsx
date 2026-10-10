import { useRef, useState } from "react";
import { api, ApiError } from "./api";
import { validateProject } from "./model";
import type { Project } from "./model";

interface FitSummary {
  status: "converged" | "not_converged";
  fit_cd_nm: number;
  target_cd_nm: number;
  rmse: number;
  nfev: number;
  warnings: string[];
}
function isFitSummary(value: unknown): value is FitSummary {
  if (!value || typeof value !== "object") return false;
  const data = value as FitSummary;
  return (
    ["converged", "not_converged"].includes(data.status) &&
    [data.fit_cd_nm, data.target_cd_nm, data.rmse, data.nfev].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    ) &&
    Array.isArray(data.warnings) &&
    data.warnings.every((v) => typeof v === "string")
  );
}

export function SyntheticFit({
  project,
  staticPreview,
  locked,
  onBusyChange,
  onApply,
}: {
  project: Project;
  staticPreview: boolean;
  locked: boolean;
  onBusyChange: (busy: boolean) => void;
  onApply: (cd: number) => void;
}) {
  const [target, setTarget] = useState(220);
  const [lower, setLower] = useState(40);
  const [upper, setUpper] = useState(360);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<FitSummary | null>(null);
  const [resultInputs, setResultInputs] = useState("");
  const id = useRef<string | null>(null);
  const fingerprint = JSON.stringify({ project, target, lower, upper });
  const validation = validateProject(project);
  if (!(
    0 < lower &&
    lower < target &&
    target < upper &&
    upper < project.period_nm
  ))
    validation.push(
      "Bounds must satisfy 0 < lower < target CD < upper < period.",
    );
  if (
    project.illumination.wavelengths_nm.length < 5 ||
    project.illumination.wavelengths_nm.length > 41 ||
    project.solver.harmonics > 12
  )
    validation.push(
      "Fitting requires 5–41 wavelengths and harmonic order N ≤ 12.",
    );
  if (project.layers[0].thickness_nm <= 0)
    validation.push("CD recovery requires a positive layer thickness.");

  async function run() {
    if (running || locked || staticPreview || validation.length) return;
    setRunning(true);
    onBusyChange(true);
    setError("");
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    try {
      let job = await api.fit(project, {
        target_cd_nm: target,
        lower_cd_nm: lower,
        upper_cd_nm: upper,
      });
      id.current = job.id;
      while (job.status === "queued" || job.status === "running") {
        if (Date.now() - started > 150000) {
          await api.cancel(job.id);
          throw new Error(
            "Fit exceeded the 150-second UI limit and cancellation was requested.",
          );
        }
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        try {
          job = await api.job(job.id);
          setError("");
        } catch (error) {
          if (error instanceof ApiError && error.status === 404)
            throw new Error(
              "Fit job no longer exists. The API may have restarted.",
              { cause: error },
            );
          setError("Connection interrupted. Retrying fit status…");
        }
      }
      if (job.status === "cancelled") {
        setError("Synthetic recovery cancelled.");
        return;
      }
      if (job.status === "failed")
        throw new Error(job.error || "Synthetic fit failed.");
      if (!isFitSummary(job.result))
        throw new Error("The API returned an unsupported fit result.");
      setResult(job.result);
      setResultInputs(fingerprint);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Fit failed.");
    } finally {
      id.current = null;
      window.clearInterval(timer);
      setRunning(false);
      onBusyChange(false);
    }
  }
  async function cancel() {
    if (!id.current) return;
    try {
      await api.cancel(id.current);
    } catch (error) {
      setError(
        `Could not confirm cancellation: ${error instanceof Error ? error.message : "network error"}`,
      );
    }
  }

  return (
    <details className="panel fit-panel">
      <summary>
        <div>
          <h2>Synthetic CD recovery</h2>
        </div>
        <span className="small-badge">
          <span className="chevron">⌄</span>
        </span>
      </summary>
      <div className="fit-body">
        <p className="fit-explanation">
          A known target CD generates a synthetic R₀/T₀ spectrum; the optimizer
          recovers CD from that spectrum. Other geometry and material values
          stay fixed. This noiseless, same-model example does not validate
          experimental accuracy or uniqueness.
        </p>
        {staticPreview && (
          <p className="fit-static-note">
            This calculation is disabled in the static preview. Use the local
            app connected to the Python API.
          </p>
        )}
        <fieldset
          disabled={staticPreview || locked || running}
          className="fit-fields"
        >
          <label className="field">
            <span>
              Target CD <small>nm</small>
            </span>
            <input
              aria-label="Synthetic target CD"
              type="number"
              value={target}
              min={0}
              max={project.period_nm}
              onChange={(e) => setTarget(Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>
              Lower bound <small>nm</small>
            </span>
            <input
              aria-label="Fit lower CD bound"
              type="number"
              value={lower}
              min={0}
              onChange={(e) => setLower(Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>
              Upper bound <small>nm</small>
            </span>
            <input
              aria-label="Fit upper CD bound"
              type="number"
              value={upper}
              max={project.period_nm}
              onChange={(e) => setUpper(Number(e.target.value))}
            />
          </label>
        </fieldset>
        {validation.length > 0 && (
          <ul className="validation-list">
            {validation.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
        <div className="fit-actions">
          <button
            className="fit-run"
            disabled={staticPreview || locked || running || !!validation.length}
            onClick={run}
          >
            {running ? `Recovering CD… ${elapsed}s` : "Run synthetic recovery"}
          </button>
          {running && (
            <button disabled={!id.current} onClick={cancel}>
              Cancel fit
            </button>
          )}
          <span>Bounded, multi-start fit · R₀ + T₀</span>
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {result && (
          <div className="fit-result" role="status">
            <div className="fit-result-heading">
              <b>
                {result.status === "converged"
                  ? "Synthetic target recovered"
                  : "Recovery not converged"}
              </b>
              {resultInputs !== fingerprint && <span>PREVIOUS INPUTS</span>}
            </div>
            <div className="fit-values">
              <div>
                <span>Target CD</span>
                <strong>
                  {result.target_cd_nm.toFixed(3)} <small>nm</small>
                </strong>
              </div>
              <div>
                <span>Recovered CD</span>
                <strong data-testid="recovered-cd">
                  {result.fit_cd_nm.toFixed(3)} <small>nm</small>
                </strong>
              </div>
              <div>
                <span>RMSE · power fraction</span>
                <strong>{result.rmse.toExponential(2)}</strong>
              </div>
            </div>
            <p>
              {result.nfev} forward evaluations. Small residuals alone do not
              establish accuracy.
            </p>
            <button
              disabled={
                running ||
                locked ||
                staticPreview ||
                result.fit_cd_nm > project.period_nm
              }
              onClick={() => onApply(result.fit_cd_nm)}
            >
              Apply recovered CD to inputs
            </button>
            <details className="fit-warnings">
              <summary>Fit warnings</summary>
              <ul>
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </div>
    </details>
  );
}
