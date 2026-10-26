import { useMemo, useState } from "react";
import { spectrumColor } from "../../core/color";
import { nearestIndex, series } from "../../core/spectrum";
import { useStore } from "../../state/store";
import { SpectrumChart } from "./SpectrumChart";

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function Swatch({
  label,
  color,
}: {
  label: string;
  color: { css: string; hex: string; approximate: boolean } | null;
}) {
  return (
    <div className="swatch">
      <span
        className={`swatch-chip${color ? "" : " swatch-empty"}`}
        style={color ? { background: color.css } : undefined}
        aria-hidden
      />
      <span className="swatch-label">{label}</span>
      <span className="swatch-value">
        {color
          ? color.approximate
            ? "Approximate"
            : color.hex
          : "Needs 450–650 nm in range"}
      </span>
    </div>
  );
}

export function SpectrumView() {
  const full = useStore((s) => s.full);
  const preview = useStore((s) => s.preview);
  const key = useStore((s) => s.key);
  const cursor = useStore((s) => s.cursor);
  const setCursor = useStore((s) => s.setCursor);
  const polarization = useStore((s) => s.design.illumination.polarization);
  const [table, setTable] = useState(false);
  // The light the design asks for: unpolarized is the mean of s and p.
  const pol = polarization === "both" ? "avg" : polarization;
  // One curve set: the full result for these inputs, else their preview, else
  // the newest result until the next one arrives (the status line says which).
  const source = useMemo(() => {
    const runs = [full, preview].filter((run) => run !== null);
    return runs.find((run) => run.key === key) ?? runs.sort((a, b) => b.at - a.at)[0] ?? null;
  }, [full, preview, key]);
  const main = useMemo(() => (source ? series(source.result, pol) : null), [source, pol]);
  if (!source || !main)
    return (
      <p className="empty-note">
        Results appear here after the first calculation.
      </p>
    );
  const i = nearestIndex(main.wavelengths, cursor);
  const reflected = spectrumColor(main.wavelengths, main.R);
  const transmitted = spectrumColor(main.wavelengths, main.T);

  return (
    <div className="spectrum-view">
      <div className="spectrum-main">
        <div className="spectrum-toolbar">
          <div className="legend" aria-label="Curves">
            <span className="key key-r">Reflected</span>
            <span className="key key-t">Transmitted</span>
            <span className="key key-a">Absorbed</span>
          </div>
        </div>
        <SpectrumChart
          series={main}
          cursor={main.wavelengths[i]}
          onCursor={setCursor}
        />
        <input
          type="range"
          className="field-slider cursor-slider"
          aria-label="Inspected wavelength"
          min={0}
          max={main.wavelengths.length - 1}
          value={i}
          onChange={(e) => setCursor(main.wavelengths[Number(e.target.value)])}
        />
      </div>
      <aside
        className="spectrum-side"
        aria-label="Values at the inspected wavelength"
      >
        <div className="readout">
          <div className="readout-wl">
            {main.wavelengths[i]} <span>nm</span>
          </div>
          <dl>
            <div className="r">
              <dt>Reflected</dt>
              <dd>{pct(main.R[i])}</dd>
            </div>
            <div className="t">
              <dt>Transmitted</dt>
              <dd>{pct(main.T[i])}</dd>
            </div>
            <div className="a">
              <dt>Absorbed</dt>
              <dd>{pct(Math.max(0, main.A[i]))}</dd>
            </div>
          </dl>
        </div>
        <div className="swatches">
          <Swatch label="Reflects as" color={reflected} />
          <Swatch label="Transmits as" color={transmitted} />
        </div>
        {source.result.warnings.length > 0 && (
          <ul className="spectrum-warnings" aria-label="Calculation notes">
            {source.result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => setTable(!table)}
          aria-expanded={table}
        >
          {table ? "Hide data table" : "Show data table"}
        </button>
      </aside>
      {table && (
        <div
          className="table-scroll data-table"
          tabIndex={0}
          role="region"
          aria-label="Spectrum data"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">λ (nm)</th>
                <th scope="col">R</th>
                <th scope="col">T</th>
                <th scope="col">A</th>
                <th scope="col">R specular</th>
                <th scope="col">T specular</th>
              </tr>
            </thead>
            <tbody>
              {main.wavelengths.map((w, j) => (
                <tr key={w} className={j === i ? "specular" : undefined}>
                  <th scope="row">{w}</th>
                  <td>{main.R[j].toFixed(5)}</td>
                  <td>{main.T[j].toFixed(5)}</td>
                  <td>{main.A[j].toFixed(5)}</td>
                  <td>{main.Rspec[j].toFixed(5)}</td>
                  <td>{main.Tspec[j].toFixed(5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
