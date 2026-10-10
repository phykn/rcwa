import { useEffect, useRef, useState } from "react";
import type { ForwardResult, Spectrum } from "./model";

const series = [
  { key: "R", label: "Reflectance", color: "#c2410c", dash: "" },
  { key: "T", label: "Transmittance", color: "#0e7490", dash: "" },
  { key: "R_specular", label: "R₀ specular", color: "#9a3412", dash: "6 4" },
  { key: "T_specular", label: "T₀ specular", color: "#155e75", dash: "6 4" },
] as const;
export function SpectrumPlot({
  result,
  polarization,
  onPolarization,
  staticPreview = false,
}: {
  result: ForwardResult | null;
  polarization: "s" | "p";
  onPolarization: (value: "s" | "p") => void;
  staticPreview?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [view, setView] = useState<"all" | "total" | "specular">("total");
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(350);
  useEffect(() => {
    const node = plotRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(280, entry.contentRect.width)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const spectrum: Spectrum | undefined = result?.spectra[polarization];
  const waves = result?.wavelengths_nm || [];
  const selected = Math.min(index, Math.max(0, waves.length - 1));
  const active = series.filter(
    (s) =>
      view === "all" ||
      (view === "total"
        ? !s.key.includes("specular")
        : s.key.includes("specular")),
  );
  const points = active.flatMap((s) => spectrum?.[s.key] || []);
  const ymin = Math.min(0, ...points),
    ymax = Math.max(1, ...points);
  const left = 55,
    right = 20,
    top = 16,
    height = 196;
  const ticks = width < 420 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const x = (w: number) =>
    left +
    ((w - (waves[0] || 0)) /
      ((waves[waves.length - 1] || 1) - (waves[0] || 0) || 1)) *
      (width - left - right);
  const y = (v: number) => top + height - ((v - ymin) / (ymax - ymin)) * height;
  return (
    <div ref={plotRef} className="spectrum-content">
      <div className="plot-toolbar">
        <div className="segmented" aria-label="Spectrum polarization">
          {(["s", "p"] as const).map((p) => (
            <button
              key={p}
              className={polarization === p ? "selected" : ""}
              aria-pressed={polarization === p}
              disabled={!result?.spectra[p]}
              onClick={() => {
                onPolarization(p);
                setIndex(0);
              }}
            >
              {p === "s" ? "s / TE" : "p / TM"}
            </button>
          ))}
        </div>
        <select
          aria-label="Spectrum quantity"
          aria-describedby="spectrum-quantity-help"
          value={view}
          onChange={(e) => setView(e.target.value as typeof view)}
        >
          <option value="all">Total + specular</option>
          <option value="total">Total only</option>
          <option value="specular">Specular only</option>
        </select>
      </div>
      <p className="sr-only" id="spectrum-quantity-help">
        {view === "total"
          ? "Total includes all diffraction directions."
          : "Specular is the zeroth order: mirror reflection and the directly transmitted beam."}
      </p>
      {!spectrum ? (
        <div className="empty-spectrum">
          <h3>No spectrum yet</h3>
          <p>
            {staticPreview
              ? "Import a saved result or choose Project → Reset example."
              : "Select Run simulation to calculate these inputs."}
          </p>
        </div>
      ) : (
        <>
          <svg
            className="spectrum-svg"
            viewBox={`0 0 ${width} 260`}
            role="img"
            aria-label={`${polarization} polarized reflection and transmission spectra. Read individual values with the wavelength slider below.`}
            onPointerMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relative = ((e.clientX - rect.left) / rect.width) * width;
              const target =
                ((relative - left) / (width - left - right)) *
                  ((waves.at(-1) || 0) - waves[0]) +
                waves[0];
              const nearest = waves.reduce(
                (best, w, i) =>
                  Math.abs(w - target) < Math.abs(waves[best] - target)
                    ? i
                    : best,
                0,
              );
              setIndex(nearest);
            }}
          >
            {ticks.map((f) => {
              const v = ymin + f * (ymax - ymin);
              return (
                <g key={f}>
                  <line
                    x1={left}
                    x2={width - right}
                    y1={y(v)}
                    y2={y(v)}
                    stroke="#e4e4e7"
                  />
                  <text
                    x={left - 12}
                    y={y(v) + 4}
                    textAnchor="end"
                    className="chart-tick"
                  >
                    {v.toFixed(2)}
                  </text>
                </g>
              );
            })}
            {ticks.map((f) => {
              const w = waves[0] + f * ((waves.at(-1) || 0) - waves[0]);
              return (
                <text
                  key={f}
                  x={x(w)}
                  y={height + top + 25}
                  textAnchor="middle"
                  className="chart-tick"
                >
                  {Math.round(w)}
                </text>
              );
            })}
            <text
              x={width / 2}
              y="256"
              textAnchor="middle"
              className="chart-axis"
            >
              Wavelength · nm
            </text>
            <text
              x="14"
              y="114"
              transform="rotate(-90,14,114)"
              textAnchor="middle"
              className="chart-axis"
            >
              Power fraction
            </text>
            {active.map((s) => (
              <path
                key={s.key}
                d={spectrum[s.key]
                  .map(
                    (v, i) =>
                      `${i === 0 ? "M" : "L"}${x(waves[i]).toFixed(2)},${y(v).toFixed(2)}`,
                  )
                  .join(" ")}
                fill="none"
                stroke={s.color}
                strokeWidth="2.5"
                strokeDasharray={s.dash}
                strokeLinejoin="round"
              />
            ))}
            <line
              x1={x(waves[selected])}
              x2={x(waves[selected])}
              y1={top}
              y2={height + top}
              stroke="#a1a1aa"
              strokeDasharray="3 4"
            />
            {active.map((s) => (
              <circle
                key={s.key}
                cx={x(waves[selected])}
                cy={y(spectrum[s.key][selected])}
                r="3.5"
                fill={s.color}
                stroke="white"
                strokeWidth="1.5"
              />
            ))}
          </svg>
          <div className="plot-legend">
            {active.map((s) => (
              <span key={s.key}>
                <i
                  style={{
                    borderColor: s.color,
                    borderTopStyle: s.dash ? "dashed" : "solid",
                  }}
                />
                {s.label}
              </span>
            ))}
          </div>
          <p
            className="sr-only"
            id="spectrum-sample-description"
            aria-live="polite"
            aria-atomic="true"
          >
            {`${waves[selected]} nanometers. ${polarization} polarization. ${active.map((item) => `${item.label} ${(100 * spectrum[item.key][selected]).toFixed(1)} percent`).join(". ")}.`}
          </p>
          <div className="sample-readout">
            <label htmlFor="wavelength-sample">
              Wavelength <strong>{waves[selected]} nm</strong>
            </label>
            <input
              id="wavelength-sample"
              aria-label="Inspect wavelength sample"
              aria-valuetext={`${waves[selected]} nanometers`}
              aria-describedby="spectrum-sample-description"
              type="range"
              min="0"
              max={waves.length - 1}
              value={selected}
              onChange={(e) => setIndex(+e.target.value)}
            />
            <div>
              {active.map((s) => (
                <span key={s.key}>
                  <b style={{ color: s.color }}>{s.label}</b>{" "}
                  {(100 * spectrum[s.key][selected]).toFixed(1)}%
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
