import { useMemo, useRef, useState } from "react";
import type { FieldMap } from "../../engine/browser";
import { nearestIndex } from "../../core/spectrum";
import { useServices } from "../../state/context";
import { useStore } from "../../state/store";
import { Segmented } from "../../ui/Segmented";
import { Heatmap } from "../sweep/Heatmap";

export default function FieldView() {
  const design = useStore((s) => s.design);
  const key = useStore((s) => s.key);
  const cursor = useStore((s) => s.cursor);
  const { hub } = useServices();
  const ws = design.illumination.wavelengths_nm;
  const wavelength = ws[nearestIndex(ws, cursor)];
  const [pol, setPol] = useState<"s" | "p">(design.illumination.polarization === "p" ? "p" : "s");
  const [plane, setPlane] = useState<"xz" | "xy">("xz");
  const [layer, setLayer] = useState(0);
  const [resolution, setResolution] = useState<"24" | "40" | "56">("40");
  const [map, setMap] = useState<(FieldMap & { key: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);

  async function compute() {
    abort.current?.abort();
    const controller = (abort.current = new AbortController());
    setBusy(true);
    setError("");
    try {
      const out = await hub.browserEngine.field(design, wavelength, pol, Number(resolution), { signal: controller.signal, priority: "interactive" });
      if (!controller.signal.aborted) setMap({ ...out, key });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  }

  const view = useMemo(() => {
    if (!map) return null;
    if (plane === "xz") {
      // Depth grows downward; the heat map's y axis grows upward, so flip rows.
      const rows = [...map.xz].reverse();
      const ys = [...map.depth_nm].reverse().map((z) => -z);
      const boundaries = map.layer_tops_nm.map((z) => [
        { x: map.x_nm[0], y: -z },
        { x: map.x_nm[map.x_nm.length - 1], y: -z },
      ]);
      return { rows, xs: map.x_nm, ys, overlays: boundaries, xLabel: "x (nm)", yLabel: "Height below the top surface (nm, negative down)" };
    }
    const index = Math.min(layer, map.xy.length - 1);
    return { rows: [...map.xy[index]].reverse(), xs: map.x_nm, ys: [...map.y_nm].reverse(), overlays: [], xLabel: "x (nm)", yLabel: "y (nm)" };
  }, [map, plane, layer]);

  const stale = map && map.key !== key;
  return (
    <div className="analysis">
      <p className="analysis-note">
        Electric-field intensity |E|² inside the stack for one wavelength, relative to the incident wave. Pick the wavelength on the
        spectrum first.
      </p>
      <div className="analysis-controls">
        <div className="field">
          <span className="field-label">Wavelength</span>
          <span className="field-static">{wavelength} nm</span>
        </div>
        <Segmented label="Incident polarization" value={pol} options={[{ value: "s", label: "s (TE)" }, { value: "p", label: "p (TM)" }]} onChange={setPol} />
        <Segmented label="Detail" value={resolution} options={[{ value: "24", label: "Low" }, { value: "40", label: "Medium" }, { value: "56", label: "High" }]} onChange={setResolution} />
      </div>
      <div className="analysis-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void compute()}>
          {busy ? "Calculating field…" : map ? "Recalculate field" : "Calculate field"}
        </button>
        {stale && <span className="stale-note">The map belongs to earlier inputs.</span>}
      </div>
      {error && <p className="field-error">{error}</p>}
      {map && view && (
        <>
          <div className="analysis-controls">
            <Segmented label="Plane" value={plane} options={[{ value: "xz", label: "Side cut (x–z, y at centre)" }, { value: "xy", label: "Top cut (x–y)" }]} onChange={setPlane} />
            {plane === "xy" && (
              <label className="field">
                <span className="field-label">Layer mid-plane</span>
                <select className="select" value={layer} onChange={(e) => setLayer(Number(e.target.value))}>
                  {map.layer_indices.map((li, i) => (
                    <option key={li} value={i}>
                      Layer {li + 1}: {design.layers[li]?.name ?? ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <Heatmap
            rows={view.rows}
            xs={view.xs}
            ys={view.ys}
            xLabel={view.xLabel}
            yLabel={view.yLabel}
            valueLabel="|E|²"
            ramp="inferno"
            range={[0, Math.max(1, Math.ceil(map.max_intensity * 10) / 10)]}
            overlays={view.overlays}
            describe={(x, y, v) => `x ${x.toFixed(0)} nm, ${plane === "xz" ? `depth ${(-y).toFixed(0)}` : `y ${y.toFixed(0)}`} nm: |E|² ${v.toFixed(3)}`}
          />
          <p className="analysis-note">
            {map.wavelength_nm} nm, {map.polarization}-polarized: R {(map.R * 100).toFixed(1)}%, T {(map.T * 100).toFixed(1)}%. Peak |E|²{" "}
            {map.max_intensity.toFixed(2)}. Dashed lines are layer interfaces.
          </p>
        </>
      )}
    </div>
  );
}
