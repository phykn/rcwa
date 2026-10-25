import { useEffect, useMemo, useRef, useState } from "react";
import { previewDesign } from "../../engine/chunks";
import {
  getValue,
  parameters,
  refinementOrder,
  setValue,
} from "../../core/parameters";
import { rayleighLines } from "../../core/rayleigh";
import { series, type PolView } from "../../core/spectrum";
import { wavelengthRange } from "../../core/design";
import { useServices } from "../../state/context";
import { useStore } from "../../state/store";
import { NumberField } from "../../ui/NumberField";
import { Segmented } from "../../ui/Segmented";
import { Heatmap } from "./Heatmap";

type Quantity = "R" | "T" | "A";

interface Sweep {
  parameterId: string;
  label: string;
  unit: string;
  values: number[];
  wavelengths: number[];
  rows: ({ R: number[]; T: number[]; A: number[] } | null)[];
  done: number;
  failures: number;
  failed: string;
}

export default function SweepView() {
  const design = useStore((s) => s.design);
  const edit = useStore((s) => s.edit);
  const setCursor = useStore((s) => s.setCursor);
  const advanced = useStore((s) => s.settings.advanced);
  const pol = (
    advanced ? useStore.getState().settings.polarization : "avg"
  ) as PolView;
  const { hub } = useServices();
  const params = useMemo(() => parameters(design), [design]);
  const [paramId, setParamId] = useState(params[0].id);
  const param = params.find((p) => p.id === paramId) ?? params[0];
  const current = getValue(design, param);
  const [from, setFrom] = useState(() =>
    Math.max(param.min, Math.round(current * 0.6)),
  );
  const [to, setTo] = useState(() =>
    Math.min(param.max, Math.round(current * 1.4) || 10),
  );
  const [steps, setSteps] = useState(21);
  const [points, setPoints] = useState(41);
  const [fast, setFast] = useState(true);
  const [quantity, setQuantity] = useState<Quantity>("R");
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  // Leaving the tab removes the Stop button, so stop the work with it.
  useEffect(() => () => abort.current?.abort(), []);
  const [running, setRunning] = useState(false);

  const choose = (id: string) => {
    const p = params.find((x) => x.id === id)!;
    const v = getValue(design, p);
    setParamId(id);
    if (p.id === "angle") {
      setFrom(0);
      setTo(60);
    } else {
      setFrom(Math.max(p.min, Math.round(v * 0.6)));
      setTo(Math.min(p.max, Math.max(Math.round(v * 1.4), Math.round(v) + 10)));
    }
  };

  async function run() {
    abort.current?.abort();
    const controller = (abort.current = new AbortController());
    setError("");
    setRunning(true);
    const ws = design.illumination.wavelengths_nm;
    const wavelengths = wavelengthRange(
      ws[0],
      ws[ws.length - 1],
      Math.max(2, points),
    );
    const values = Array.from(
      { length: steps },
      (_, i) =>
        Math.round((from + ((to - from) * i) / (steps - 1)) * 100) / 100,
    );
    const base = {
      ...design,
      illumination: { ...design.illumination, wavelengths_nm: wavelengths },
    };
    const state: Sweep = {
      parameterId: param.id,
      label: param.label,
      unit: param.unit,
      values,
      wavelengths,
      rows: values.map(() => null),
      done: 0,
      failures: 0,
      failed: "",
    };
    setSweep({ ...state });
    const engine = hub.browserEngine;
    try {
      await Promise.all(
        refinementOrder(values.length).map(async (i) => {
          let d = setValue(base, param, values[i]);
          if (fast) d = { ...previewDesign(d), illumination: d.illumination };
          try {
            const result = await engine.solve(d, {
              priority: "background",
              signal: controller.signal,
            });
            const s = series(result, pol);
            state.rows[i] = { R: s.R, T: s.T, A: s.A };
          } catch (e) {
            if (controller.signal.aborted) throw e;
            // A row the solver rejects (e.g. a feature wider than the pitch) stays empty.
            state.failed = `${values[i]} ${param.unit}: ${e instanceof Error ? e.message : String(e)}`;
            state.failures++;
          }
          state.done++;
          if (!controller.signal.aborted)
            setSweep({ ...state, rows: [...state.rows] });
        }),
      );
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        setRunning(false);
      }
    }
  }

  const overlays = useMemo(
    () =>
      sweep
        ? rayleighLines(
            design,
            params.find((p) => p.id === sweep.parameterId) ?? param,
            sweep.values,
            [
              sweep.wavelengths[0],
              sweep.wavelengths[sweep.wavelengths.length - 1],
            ],
          )
        : [],
    [sweep, design, params, param],
  );
  const rows = useMemo(
    () => sweep?.rows.map((r) => (r ? r[quantity] : null)) ?? [],
    [sweep, quantity],
  );
  const range = useMemo<[number, number]>(() => {
    const values = rows.flatMap((r) => r ?? []);
    if (!values.length) return [0, 1];
    const lo = Math.floor(Math.min(...values) * 100) / 100;
    const hi = Math.ceil(Math.max(...values) * 100) / 100;
    return hi > lo ? [lo, hi] : [lo, lo + 0.01];
  }, [rows]);

  return (
    <div className="analysis">
      <p className="analysis-note">
        Map one input against wavelength. Each row is a full spectrum; the
        picture sharpens as rows arrive.
      </p>
      <div className="analysis-controls">
        <label className="field">
          <span className="field-label">Vary</span>
          <select
            className="select"
            value={param.id}
            onChange={(e) => choose(e.target.value)}
          >
            {params.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <NumberField
          label="From"
          unit={param.unit}
          value={from}
          min={param.min}
          max={param.max}
          slider={false}
          onChange={setFrom}
        />
        <NumberField
          label="To"
          unit={param.unit}
          value={to}
          min={param.min}
          max={param.max}
          slider={false}
          onChange={setTo}
        />
        <NumberField
          label="Steps"
          value={steps}
          min={3}
          max={61}
          integer
          slider={false}
          onChange={setSteps}
        />
        {advanced && (
          <>
            <NumberField
              label="Wavelengths"
              value={points}
              min={5}
              max={121}
              integer
              slider={false}
              onChange={setPoints}
            />
            <Segmented
              label="Accuracy"
              value={fast ? "fast" : "full"}
              options={[
                { value: "fast", label: "Fast" },
                { value: "full", label: "Design orders" },
              ]}
              onChange={(v) => setFast(v === "fast")}
            />
          </>
        )}
      </div>
      <div className="analysis-actions">
        {running ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              abort.current?.abort();
              abort.current = null;
              setRunning(false);
            }}
          >
            Stop sweep
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!(to > from)}
            onClick={() => void run()}
          >
            Run sweep
          </button>
        )}
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            choose("angle");
          }}
        >
          Angle–wavelength preset
        </button>
        {sweep && (
          <span className="analysis-note">
            {sweep.done} of {sweep.values.length} rows
          </span>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
      {sweep && sweep.failures > 0 && (
        <p className="field-error">
          {sweep.failures} {sweep.failures === 1 ? "row" : "rows"} could not be
          calculated, for example {sweep.failed}
        </p>
      )}
      {sweep && (
        <>
          <Segmented
            label="Show"
            value={quantity}
            options={[
              { value: "R", label: "Reflected" },
              { value: "T", label: "Transmitted" },
              { value: "A", label: "Absorbed" },
            ]}
            onChange={setQuantity}
          />
          <Heatmap
            fileName={`sweep-${sweep.parameterId}-${quantity}.png`}
            rows={rows}
            xs={sweep.wavelengths}
            ys={sweep.values}
            xLabel="Wavelength (nm)"
            yLabel={`${sweep.label} (${sweep.unit})`}
            valueLabel={
              quantity === "R"
                ? "Reflectance"
                : quantity === "T"
                  ? "Transmittance"
                  : "Absorptance"
            }
            range={range}
            overlays={overlays}
            marker={
              sweep.parameterId === param.id
                ? { x: sweep.wavelengths[0], y: current }
                : null
            }
            describe={(x, y, v) =>
              `${x} nm, ${y} ${sweep.unit}: ${(v * 100).toFixed(1)}%`
            }
            onPick={(xi, yi) => {
              const p = params.find((x) => x.id === sweep.parameterId);
              if (!p) return;
              edit((d) => setValue(d, p, sweep.values[yi]));
              setCursor(sweep.wavelengths[xi]);
            }}
          />
          <p className="analysis-note">
            Dashed lines mark where a diffraction order turns grazing
            (Wood–Rayleigh anomalies).
          </p>
        </>
      )}
    </div>
  );
}
