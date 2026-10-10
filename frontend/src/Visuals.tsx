import { useEffect, useId, useRef, useState } from "react";
import type { ForwardResult, Project, Spectrum } from "./model";

export type Dimension = "pitch" | "width" | "height";
export function Geometry({
  project,
  selectedDimension,
  onSelectDimension,
}: {
  project: Project;
  selectedDimension: Dimension | null;
  onSelectDimension: (dimension: Dimension) => void;
}) {
  const id = useId().replace(/:/g, "");
  const layer = project.layers[0];
  const fill = Math.max(0, Math.min(1, layer.cd_nm / project.period_nm));
  const pitch = 132,
    ridgeWidth = pitch * fill;
  const depth =
    layer.thickness_nm === 0
      ? 0
      : Math.max(
          15,
          Math.min(92, (layer.thickness_nm / project.period_nm) * pitch),
        );
  const bottom = 204,
    top = bottom - depth;
  const angle = (project.illumination.angle_deg * Math.PI) / 180;
  const rayX = 267 - Math.sin(angle) * 96,
    rayY = top - Math.cos(angle) * 96;
  return (
    <>
      <svg
        className="geometry-svg"
        viewBox="0 0 610 265"
        role="img"
        aria-label={`One-dimensional grating, period ${project.period_nm} nanometers, CD ${layer.cd_nm} nanometers, thickness ${layer.thickness_nm} nanometers. Schematic not to scale.`}
      >
        <defs>
          <pattern
            id={`${id}-hatch`}
            width="9"
            height="9"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(35)"
          >
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="9"
              stroke="#6d878b"
              strokeWidth="1"
              opacity=".22"
            />
          </pattern>
          <marker
            id={`${id}-arrow`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#cf6838" />
          </marker>
          <marker
            id={`${id}-dim`}
            viewBox="0 0 10 10"
            refX="5"
            refY="5"
            markerWidth="4"
            markerHeight="4"
            orient="auto-start-reverse"
          >
            <path
              d="M 10 0 L 0 5 L 10 10"
              fill="none"
              stroke="#687a7e"
              strokeWidth="1.5"
            />
          </marker>
        </defs>
        <rect x="36" y={top} width="528" height={depth} fill="#edf3f1" />
        <rect x="36" y={bottom} width="528" height="35" fill="#d4dfe0" />
        <rect
          x="36"
          y={bottom}
          width="528"
          height="35"
          fill={`url(#${id}-hatch)`}
        />
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            x={36 + i * pitch + (pitch - ridgeWidth) / 2}
            y={top}
            width={ridgeWidth}
            height={depth}
            rx="1"
            fill="#476c72"
            stroke="#31545c"
            strokeWidth="1"
          />
        ))}
        {selectedDimension === "pitch" && (
          <rect
            className="dimension-highlight"
            data-testid="pitch-highlight"
            x="168"
            y={top - 6}
            width={pitch}
            height={depth + 12}
            fill="none"
            stroke="#3266b5"
            strokeWidth="4"
            strokeDasharray="7 4"
          />
        )}
        {selectedDimension === "width" && (
          <line
            className="dimension-highlight"
            data-testid="width-highlight"
            x1={168 + (pitch - ridgeWidth) / 2}
            x2={168 + (pitch + ridgeWidth) / 2}
            y1={top}
            y2={top}
            stroke="#3266b5"
            strokeWidth="7"
          />
        )}
        {selectedDimension === "height" && (
          <line
            className="dimension-highlight"
            data-testid="height-highlight"
            x1={168 + (pitch + ridgeWidth) / 2}
            x2={168 + (pitch + ridgeWidth) / 2}
            y1={top}
            y2={bottom}
            stroke="#3266b5"
            strokeWidth="7"
          />
        )}
        <line x1="36" x2="564" y1={bottom} y2={bottom} stroke="#93aaaa" />
        <line
          x1="267"
          x2="267"
          y1={top - 95}
          y2={top}
          stroke="#c2caca"
          strokeDasharray="4 4"
        />
        <line
          x1={rayX}
          y1={rayY}
          x2="267"
          y2={top - 4}
          stroke="#cf6838"
          strokeWidth="2.5"
          markerEnd={`url(#${id}-arrow)`}
        />
        <text
          x={rayX - 10}
          y={Math.max(18, rayY - 12)}
          textAnchor="end"
          className="svg-accent"
        >
          θ = {project.illumination.angle_deg}°
        </text>
        <text x="550" y="32" textAnchor="end" className="svg-label">
          {project.ambient.name || "Ambient"} · ambient
        </text>
        <text x="550" y="228" textAnchor="end" className="svg-label">
          {project.substrate.name || "Substrate"} · substrate
        </text>
        <line
          x1="168"
          x2="300"
          y1="251"
          y2="251"
          stroke="#687a7e"
          markerStart={`url(#${id}-dim)`}
          markerEnd={`url(#${id}-dim)`}
        />
        <text x="234" y="244" textAnchor="middle" className="svg-small">
          Λ {project.period_nm} nm
        </text>
        {ridgeWidth > 0 && (
          <>
            <line
              x1={168 + (pitch - ridgeWidth) / 2}
              x2={168 + (pitch + ridgeWidth) / 2}
              y1={top - 12}
              y2={top - 12}
              stroke="#687a7e"
              markerStart={`url(#${id}-dim)`}
              markerEnd={`url(#${id}-dim)`}
            />
            <text
              x="234"
              y={top - 20}
              textAnchor="middle"
              className="svg-small"
            >
              CD {layer.cd_nm} nm
            </text>
          </>
        )}
        {depth > 0 && (
          <>
            <line
              x1="584"
              x2="584"
              y1={top}
              y2={bottom}
              stroke="#687a7e"
              markerStart={`url(#${id}-dim)`}
              markerEnd={`url(#${id}-dim)`}
            />
            <text
              x="591"
              y={top + depth / 2 + 4}
              className="svg-small"
              transform={`rotate(90,591,${top + depth / 2 + 4})`}
            >
              h {layer.thickness_nm} nm
            </text>
          </>
        )}
        <text x="41" y="31" className="svg-axis">
          z ↓
        </text>
        <text x="43" y="47" className="svg-axis">
          x →
        </text>
      </svg>
      <div
        className="dimension-controls"
        aria-label="Select a dimension to edit"
      >
        {(["pitch", "width", "height"] as const).map((dimension) => (
          <button
            type="button"
            key={dimension}
            aria-label={`Edit ${dimension}`}
            aria-pressed={selectedDimension === dimension}
            onClick={() => onSelectDimension(dimension)}
          >
            {dimension[0].toUpperCase() + dimension.slice(1)}
            <span aria-hidden="true">↗</span>
          </button>
        ))}
      </div>
    </>
  );
}
const series = [
  { key: "R", label: "Reflectance", color: "#ca653d", dash: "" },
  { key: "T", label: "Transmittance", color: "#267e80", dash: "" },
  { key: "R_specular", label: "R₀ specular", color: "#b48953", dash: "6 4" },
  { key: "T_specular", label: "T₀ specular", color: "#839690", dash: "6 4" },
] as const;
export function SpectrumPlot({
  result,
  polarization,
  onPolarization,
}: {
  result: ForwardResult | null;
  polarization: "s" | "p";
  onPolarization: (value: "s" | "p") => void;
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
      <p className="spectrum-help">
        Reflectance: light sent back. Transmittance: light entering the
        substrate.
      </p>
      <div className="plot-toolbar">
        <div className="segmented" aria-label="Spectrum polarization">
          {(["s", "p"] as const).map((p) => (
            <button
              key={p}
              className={polarization === p ? "selected" : ""}
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
          value={view}
          onChange={(e) => setView(e.target.value as typeof view)}
        >
          <option value="all">Total + specular</option>
          <option value="total">Total only</option>
          <option value="specular">Specular only</option>
        </select>
      </div>
      <p className="quantity-help">
        {view === "total"
          ? "Total includes all diffraction directions."
          : "Specular is the zeroth order: mirror reflection and the directly transmitted beam."}
      </p>
      {!spectrum ? (
        <div className="empty-spectrum">
          <h3>No spectrum yet</h3>
          <p>Select Run simulation to calculate these inputs.</p>
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
                    stroke="#e7eae5"
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
              stroke="#abb8b8"
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
          <div className="sample-readout">
            <label htmlFor="wavelength-sample">
              λ <strong>{waves[selected]} nm</strong>
            </label>
            <input
              id="wavelength-sample"
              aria-label="Inspect wavelength sample"
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
                  {spectrum[s.key][selected].toFixed(4)}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
