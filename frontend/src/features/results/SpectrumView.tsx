import { useMemo, useState } from "react";
import { spectrumColor } from "../../core/color";
import { nearestIndex, polLabel, series } from "../../core/spectrum";
import { useStore } from "../../state/store";
import { Segmented } from "../../ui/Segmented";
import { SpectrumChart, type ChartLayer } from "./SpectrumChart";

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function Swatch({ label, color }: { label: string; color: { css: string; hex: string } | null }) {
  return (
    <div className="swatch">
      <span
        className={`swatch-chip${color ? "" : " swatch-empty"}`}
        style={color ? { background: color.css } : undefined}
        aria-hidden
      />
      <span className="swatch-label">{label}</span>
      <span className="swatch-value">{color ? color.hex : "Needs 400–700 nm"}</span>
    </div>
  );
}

export function SpectrumView() {
  const full = useStore((s) => s.full);
  const preview = useStore((s) => s.preview);
  const ghost = useStore((s) => s.ghost);
  const overlays = useStore((s) => s.overlays);
  const key = useStore((s) => s.key);
  const cursor = useStore((s) => s.cursor);
  const setCursor = useStore((s) => s.setCursor);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const [showGhost, setShowGhost] = useState(true);
  const [showAbsorption, setShowAbsorption] = useState(true);
  const [table, setTable] = useState(false);
  const pol = settings.polarization;
  const current = !!full && full.key === key;
  const livePreview = !current && preview?.key === key ? preview : null;

  const layers = useMemo(() => {
    const out: ChartLayer[] = [];
    if (full) out.push({ id: "full", label: current ? "Current" : "Previous inputs", series: series(full.result, pol), kind: current ? "main" : "stale" });
    if (livePreview) out.push({ id: "preview", label: "Preview", series: series(livePreview.result, pol), kind: "preview" });
    if (showGhost && ghost && current) out.push({ id: "ghost", label: "Before last change", series: series(ghost.result, pol), kind: "ghost" });
    for (const o of overlays) out.push({ id: o.id, label: o.label, series: series(o.result, pol), kind: "overlay" });
    return out;
  }, [full, current, livePreview, ghost, showGhost, overlays, pol]);

  const main = full ? series(full.result, pol) : livePreview ? series(livePreview.result, pol) : null;
  if (!main) return <p className="empty-note">Results appear here after the first calculation.</p>;
  const i = nearestIndex(main.wavelengths, cursor);
  const reflected = spectrumColor(main.wavelengths, main.R);
  const transmitted = spectrumColor(main.wavelengths, main.T);
  const source = full ?? livePreview!;

  return (
    <div className="spectrum-view">
      <div className="spectrum-main">
        <div className="spectrum-toolbar">
          <Segmented
            label="Polarization shown"
            value={pol}
            options={[
              { value: "avg", label: "Unpolarized" },
              { value: "s", label: "s" },
              { value: "p", label: "p" },
            ]}
            onChange={(polarization) => update({ polarization })}
          />
          <div className="legend" aria-label="Curves">
            <span className="key key-r">R reflected</span>
            <span className="key key-t">T transmitted</span>
            <label className="toggle">
              <input type="checkbox" checked={showAbsorption} onChange={(e) => setShowAbsorption(e.target.checked)} />
              <span className="key key-a">A absorbed</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.showSpecular}
                onChange={(e) => update({ showSpecular: e.target.checked })}
              />
              Specular only (dashed)
            </label>
            {ghost && (
              <label className="toggle">
                <input type="checkbox" checked={showGhost} onChange={(e) => setShowGhost(e.target.checked)} />
                <span className="key key-ghost">Before last change</span>
              </label>
            )}
          </div>
        </div>
        <SpectrumChart
          layers={layers}
          showSpecular={settings.showSpecular}
          showAbsorption={showAbsorption}
          cursor={main.wavelengths[i]}
          onCursor={setCursor}
        />
        <input
          type="range"
          className="cursor-slider"
          aria-label="Inspected wavelength"
          min={0}
          max={main.wavelengths.length - 1}
          value={i}
          onChange={(e) => setCursor(main.wavelengths[Number(e.target.value)])}
        />
        {!current && full && (
          <p className="stale-note">
            {livePreview ? "Dashed curves preview your edit with fewer orders. " : ""}Faded curves belong to the previous inputs.
          </p>
        )}
      </div>
      <aside className="spectrum-side" aria-label="Values at the inspected wavelength">
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
          <p className="readout-note">
            {polLabel(source.result, pol)} light · {source.result.harmonics.join("×")} orders
          </p>
        </div>
        <div className="swatches">
          <Swatch label="Reflected color" color={reflected} />
          <Swatch label="Transmitted color" color={transmitted} />
        </div>
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
