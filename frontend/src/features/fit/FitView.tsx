import { useMemo, useRef, useState } from "react";
import type { FitResult } from "../../engine/browser";
import type { ServerEngine } from "../../engine/server";
import { getValue, parameters, setValue, type Parameter } from "../../core/parameters";
import { useServices } from "../../state/context";
import { useStore } from "../../state/store";
import { NumberField } from "../../ui/NumberField";
import { Segmented } from "../../ui/Segmented";
import { SpectrumChart, type ChartLayer } from "../results/SpectrumChart";

const MAX_POINTS = 31;

/** "wavelength value" rows; values in % are converted to fractions. */
export function parseMeasurement(text: string) {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[#a-z]/i.test(l))
    .map((l) => l.split(/[\s,;\t]+/).map(Number))
    .filter((r) => r.length >= 2 && r.every(Number.isFinite))
    .sort((a, b) => a[0] - b[0]);
  if (rows.length < 3) throw new Error("Paste at least three rows of wavelength (nm) and value.");
  const percent = rows.some((r) => r[1] > 1.5);
  let picked = rows;
  if (rows.length > MAX_POINTS) {
    const step = (rows.length - 1) / (MAX_POINTS - 1);
    picked = Array.from({ length: MAX_POINTS }, (_, i) => rows[Math.round(i * step)]);
  }
  const unique = picked.filter((r, i) => !i || r[0] > picked[i - 1][0]);
  return {
    wavelengths: unique.map((r) => r[0]),
    values: unique.map((r) => (percent ? r[1] / 100 : r[1])),
    thinned: rows.length > MAX_POINTS,
    percent,
  };
}

interface Choice {
  id: string;
  lower: number;
  upper: number;
}

export default function FitView() {
  const design = useStore((s) => s.design);
  const edit = useStore((s) => s.edit);
  const cursor = useStore((s) => s.cursor);
  const setCursor = useStore((s) => s.setCursor);
  const { hub } = useServices();
  const params = useMemo(() => parameters(design).filter((p) => p.id !== "azimuth"), [design]);
  const [text, setText] = useState("");
  const [quantity, setQuantity] = useState<"R" | "T">("R");
  const [pol, setPol] = useState<"avg" | "s" | "p">(design.illumination.polarization === "both" ? "avg" : design.illumination.polarization);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [fast, setFast] = useState(true);
  const [result, setResult] = useState<(FitResult & { params: Parameter[] }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);

  const measurement = useMemo(() => {
    try {
      return text.trim() ? parseMeasurement(text) : null;
    } catch {
      return null;
    }
  }, [text]);

  const toggle = (p: Parameter) => {
    if (choices.some((c) => c.id === p.id)) return setChoices(choices.filter((c) => c.id !== p.id));
    if (choices.length >= 3) return;
    const v = getValue(design, p);
    setChoices([...choices, { id: p.id, lower: Math.max(p.min, Math.round(v * 0.7)), upper: Math.min(p.max, Math.max(Math.round(v * 1.3), Math.round(v) + 5)) }]);
  };

  async function run() {
    if (!measurement) return setError("Paste a measured spectrum first.");
    abort.current?.abort();
    const controller = (abort.current = new AbortController());
    setBusy(true);
    setError("");
    const chosen = choices.map((c) => ({ c, p: params.find((p) => p.id === c.id)! }));
    try {
      const solver = fast
        ? { harmonics_x: Math.min(2, design.solver.harmonics_x), harmonics_y: Math.min(2, design.solver.harmonics_y) }
        : design.solver;
      // The local server fits with native BLAS when it is in use; otherwise this browser does.
      const engine = hub.engine.kind === "server" ? (hub.engine as ServerEngine) : hub.browserEngine;
      const out = await engine.fit(
        { ...design, solver },
        {
          parameters: chosen.map(({ c, p }) => ({ path: p.path, linked: p.linked, lower: c.lower, upper: c.upper })),
          wavelengths_nm: measurement.wavelengths,
          values: measurement.values,
          quantity,
          polarization: pol,
        },
        { signal: controller.signal, priority: "interactive" },
      );
      if (!controller.signal.aborted) setResult({ ...out, params: chosen.map((x) => x.p) });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  }

  const layers: ChartLayer[] = [];
  if (measurement) {
    const zeros = measurement.values.map(() => 0);
    const asSeries = (v: number[]) => ({ wavelengths: measurement.wavelengths, R: quantity === "R" ? v : zeros, T: quantity === "T" ? v : zeros, A: zeros, Rspec: zeros, Tspec: zeros });
    layers.push({ id: "measured", label: "Measured", series: asSeries(measurement.values), kind: "overlay" });
    if (result) layers.push({ id: "fitted", label: "Fitted", series: asSeries(result.fitted), kind: "main" });
  }

  return (
    <div className="analysis">
      <p className="analysis-note">
        Paste a measured spectrum, choose up to three dimensions to adjust, and fit the model to it. The fit runs on the local
        server when one is in use, otherwise in this browser.
      </p>
      <div className="fit-grid">
        <label className="field">
          <span className="field-label">Measured spectrum: wavelength (nm) and value per line, as a fraction or %</span>
          <textarea
            className="textarea"
            rows={7}
            spellCheck={false}
            placeholder={"450, 0.052\n470, 0.048\n…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <span className="field-hint">
            {measurement
              ? `${measurement.wavelengths.length} points${measurement.thinned ? ` (thinned to ${MAX_POINTS})` : ""}${measurement.percent ? ", read as %" : ""}`
              : text.trim()
                ? "Could not read this data yet."
                : "Or load a CSV file below."}
          </span>
          <input type="file" accept=".csv,.txt,.tsv" aria-label="Load measured spectrum file" onChange={async (e) => e.target.files?.[0] && setText(await e.target.files[0].text())} />
        </label>
        <div className="fit-options">
          <Segmented label="Quantity" value={quantity} options={[{ value: "R", label: "Reflectance" }, { value: "T", label: "Transmittance" }]} onChange={setQuantity} />
          <Segmented
            label="Accuracy"
            value={fast ? "fast" : "full"}
            options={[
              { value: "fast", label: "Fast (±2 orders)" },
              { value: "full", label: "Design orders" },
            ]}
            onChange={(v) => setFast(v === "fast")}
          />
          <Segmented label="Light" value={pol} options={[{ value: "avg", label: "Unpolarized" }, { value: "s", label: "s" }, { value: "p", label: "p" }]} onChange={setPol} />
          <fieldset className="fit-params">
            <legend className="field-label">Adjust (up to 3)</legend>
            {params.map((p) => {
              const choice = choices.find((c) => c.id === p.id);
              return (
                <div key={p.id} className="fit-param">
                  <label className="toggle">
                    <input type="checkbox" checked={!!choice} disabled={!choice && choices.length >= 3} onChange={() => toggle(p)} />
                    {p.label} <span className="field-hint">now {getValue(design, p)} {p.unit}</span>
                  </label>
                  {choice && (
                    <div className="field-grid">
                      <NumberField label="Lower" unit={p.unit} value={choice.lower} min={p.min} max={p.max} slider={false} onChange={(v) => setChoices(choices.map((c) => (c.id === p.id ? { ...c, lower: v } : c)))} />
                      <NumberField label="Upper" unit={p.unit} value={choice.upper} min={p.min} max={p.max} slider={false} onChange={(v) => setChoices(choices.map((c) => (c.id === p.id ? { ...c, upper: v } : c)))} />
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
        </div>
      </div>
      <div className="analysis-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !measurement || !choices.length || choices.some((c) => !(c.upper > c.lower))} onClick={() => void run()}>
          {busy ? "Fitting…" : "Fit"}
        </button>
        {busy && (
          <button type="button" className="btn" onClick={() => { abort.current?.abort(); setBusy(false); }}>
            Stop
          </button>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
      {layers.length > 0 && <SpectrumChart layers={layers} showSpecular={false} showAbsorption={false} cursor={cursor} onCursor={setCursor} height={240} />}
      {result && (
        <div className="fit-result">
          <table>
            <thead>
              <tr>
                <th scope="col">Dimension</th>
                <th scope="col">Fitted</th>
                <th scope="col">± 1σ</th>
                <th scope="col">Now</th>
              </tr>
            </thead>
            <tbody>
              {result.params.map((p, i) => (
                <tr key={p.id}>
                  <th scope="row">{p.label}</th>
                  <td>
                    {result.values[i].toFixed(2)} {p.unit}
                    {result.at_bound[i] ? " (at bound)" : ""}
                  </td>
                  <td>{result.sigma[i] === null ? "–" : result.sigma[i]!.toFixed(2)}</td>
                  <td>{getValue(design, p)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="analysis-note">
            RMS residual {(result.rms * 100).toFixed(2)} points after {result.evaluations} model runs ({result.elapsed_seconds.toFixed(1)} s). {result.note}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => edit((d) => result.params.reduce((acc, p, i) => setValue(acc, p, Math.round(result.values[i] * 100) / 100), d))}
          >
            Apply fitted values
          </button>
        </div>
      )}
    </div>
  );
}
