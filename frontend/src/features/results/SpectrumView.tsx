import { useMemo, useState } from "react";
import { spectrumColor } from "../../core/color";
import { nearestIndex, series } from "../../core/spectrum";
import { useStore } from "../../state/store";
import { SpectrumChart } from "./SpectrumChart";

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
// Rounding a tiny negative balance must not print "-0.00000".
const fixed = (v: number) => (Math.abs(v) < 5e-6 ? 0 : v).toFixed(5);

type Color = ReturnType<typeof spectrumColor>;

function ColorRow({ label, color }: { label: string; color: Color }) {
  if (!color) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd className="color-value" title={color.approximate ? "Approximate: the spectrum covers only part of 400–700 nm" : undefined}>
        <span className="color-chip" style={{ background: color.css }} aria-hidden />
        {color.approximate ? "≈ " : ""}
        {color.hex}
      </dd>
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
  if (!source || !main) return <p className="empty-note">Results appear here after the first calculation.</p>;
  const i = nearestIndex(main.wavelengths, cursor);
  const warnings = source.result.warnings;

  return (
    <div className="spectrum-view">
      <SpectrumChart series={main} cursor={main.wavelengths[i]} onCursor={setCursor} />
      <aside className="spectrum-side" aria-label="Spectrum values">
        <div className="readout-wl">
          {main.wavelengths[i]} <span>nm</span>
        </div>
        <dl className="readout">
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
        <dl className="colors">
          <ColorRow label="Reflected color" color={spectrumColor(main.wavelengths, main.R)} />
          <ColorRow label="Transmitted color" color={spectrumColor(main.wavelengths, main.T)} />
        </dl>
        {warnings.length > 0 && (
          <details className="notes">
            <summary>Notes ({warnings.length})</summary>
            <ul>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        <button type="button" className="btn btn-quiet" onClick={() => setTable(!table)} aria-expanded={table}>
          {table ? "Hide data table" : "Show data table"}
        </button>
      </aside>
      {table && (
        <div className="table-scroll data-table" tabIndex={0} role="region" aria-label="Spectrum data">
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
                <tr key={w} className={j === i ? "current" : undefined}>
                  <th scope="row">{w}</th>
                  <td>{fixed(main.R[j])}</td>
                  <td>{fixed(main.T[j])}</td>
                  <td>{fixed(main.A[j])}</td>
                  <td>{fixed(main.Rspec[j])}</td>
                  <td>{fixed(main.Tspec[j])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
