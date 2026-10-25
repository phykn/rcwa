import { useMemo, useState } from "react";
import { spectrumColor } from "../../core/color";
import { nearestIndex, polLabel, series } from "../../core/spectrum";
import { useStore } from "../../state/store";
import { Segmented } from "../../ui/Segmented";
import { SpectrumChart, type ChartLayer } from "./SpectrumChart";

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
  const ghost = useStore((s) => s.ghost);
  const overlays = useStore((s) => s.overlays);
  const key = useStore((s) => s.key);
  const cursor = useStore((s) => s.cursor);
  const setCursor = useStore((s) => s.setCursor);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const showGhost = true;
  const showAbsorption = true;
  const [table, setTable] = useState(false);
  const [zoom, setZoom] = useState(false);
  // Simple mode always shows unpolarized light (the mean of s and p when both exist).
  const pol = settings.advanced ? settings.polarization : "avg";
  const current = !!full && full.key === key;
  const livePreview = !current && preview?.key === key ? preview : null;

  const layers = useMemo(() => {
    const out: ChartLayer[] = [];
    if (full)
      out.push({
        id: "full",
        label: current ? "Current" : "Previous inputs",
        series: series(full.result, pol),
        kind: current ? "main" : "stale",
      });
    if (livePreview)
      out.push({
        id: "preview",
        label: "Preview",
        series: series(livePreview.result, pol),
        kind: "preview",
      });
    if (showGhost && ghost && current)
      out.push({
        id: "ghost",
        label: "Before last change",
        series: series(ghost.result, pol),
        kind: "ghost",
      });
    for (const o of overlays)
      out.push({
        id: o.id,
        label: o.label,
        series: series(o.result, pol),
        kind: "overlay",
      });
    return out;
  }, [full, current, livePreview, ghost, showGhost, overlays, pol]);

  const main = full
    ? series(full.result, pol)
    : livePreview
      ? series(livePreview.result, pol)
      : null;
  if (!main)
    return (
      <p className="empty-note">
        Results appear here after the first calculation.
      </p>
    );
  const i = nearestIndex(main.wavelengths, cursor);
  const reflected = spectrumColor(main.wavelengths, main.R);
  const transmitted = spectrumColor(main.wavelengths, main.T);
  const source = full ?? livePreview!;

  return (
    <div className="spectrum-view">
      <div className="spectrum-main">
        <div className="spectrum-toolbar">
          {settings.advanced && (
            <Segmented
              label="Polarization shown"
              hideLabel
              value={pol}
              options={[
                { value: "avg", label: "Unpolarized" },
                { value: "s", label: "s" },
                { value: "p", label: "p" },
              ]}
              onChange={(polarization) => update({ polarization })}
            />
          )}
          <div className="legend" aria-label="Curves">
            <span className="key key-r">Reflected</span>
            <span className="key key-t">Transmitted</span>
            <span className="key key-a">Absorbed</span>
            {ghost && <span className="key key-ghost">Before last change</span>}
            {settings.advanced && (
              <>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.showSpecular}
                    onChange={(e) => update({ showSpecular: e.target.checked })}
                  />
                  Specular (dashed)
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={zoom}
                    onChange={(e) => setZoom(e.target.checked)}
                  />
                  Zoom to data
                </label>
              </>
            )}
          </div>
        </div>
        <SpectrumChart
          layers={layers}
          showSpecular={settings.advanced && settings.showSpecular}
          showAbsorption={showAbsorption}
          zoom={settings.advanced && zoom}
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
        {!current && full && (
          <p className="stale-note">
            {livePreview
              ? "Dashed curves preview your edit with fewer orders. "
              : ""}
            Faded curves belong to the previous inputs.
          </p>
        )}
      </div>
      <aside
        className="spectrum-side"
        aria-label="Values at the inspected wavelength"
      >
        <div className={`readout${full && !current ? " readout-stale" : ""}`}>
          {full && !current && <p className="stale-note">These values belong to the previous inputs.</p>}
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
          {settings.advanced && (
            <p className="readout-note">
              {polLabel(source.result, pol)} light, {source.result.harmonics.join("×")} orders
            </p>
          )}
        </div>
        <div className={`swatches${full && !current ? " readout-stale" : ""}`}>
          <Swatch label="Reflects as" color={reflected} />
          <Swatch label="Transmits as" color={transmitted} />
        </div>
        {settings.advanced && (
          <details className="details" open>
            <summary>Run details</summary>
            <p>
              Engine: meent 0.13.2 {source.result.engine === "server" ? "on the local server" : "in this browser"},{" "}
              {source.result.harmonics.join("×")} orders, {source.result.elapsedSeconds.toFixed(2)} s
            </p>
            <p>
              Lossless flux error:{" "}
              {source.result.maxLosslessFluxError === null
                ? "not applicable (lossy)"
                : source.result.maxLosslessFluxError.toExponential(1)}
            </p>
            <p>Input hashes:</p>
            {source.result.inputHashes.map((h) => (
              <code key={h}>{h}</code>
            ))}
            <ul>
              {source.result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
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
          {full && !current && <p className="stale-note">This table belongs to the previous inputs.</p>}
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
