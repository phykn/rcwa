import { useState } from "react";
import type { Layer2D } from "../core/project2d";
import { layerColor } from "../core/layerColors";
import { newLayer } from "../core/design";
import { useStore, type Selection } from "../state/store";
import { Popover } from "../ui/Popover";
import { SHAPES } from "./Inspector";

function summary(layer: Layer2D) {
  const t = `${layer.thickness_nm} nm thick`;
  if (layer.geometry === "circular_hole_2d") return `⌀${layer.diameter_nm} nm holes, ${t}`;
  if (layer.geometry === "rectangle_2d") return `${layer.cd_x_nm}×${layer.cd_y_nm} nm blocks, ${t}`;
  if (layer.geometry === "rectangle_1d") return `${layer.cd_nm} nm lines, ${t}`;
  return `Film, ${t}`;
}

function same(a: Selection, b: Selection) {
  return a.kind === b.kind && (a.kind !== "layer" || (b.kind === "layer" && a.index === b.index));
}

export function StackPanel() {
  const design = useStore((s) => s.design);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const edit = useStore((s) => s.edit);
  const [adding, setAdding] = useState(false);
  const full = design.layers.length >= 8;
  const index = selection.kind === "layer" ? selection.index : -1;

  const move = (from: number, to: number) => {
    edit((d) => {
      const layers = [...d.layers];
      const [layer] = layers.splice(from, 1);
      layers.splice(to, 0, layer);
      return { ...d, layers };
    });
    select({ kind: "layer", index: to });
  };

  // The bar's color matches the layer in the 3D view.
  const row = (key: string, sel: Selection, label: string, detail: string, color?: string) => (
    <li key={key}>
      <button
        type="button"
        className={`stack-row${same(sel, selection) ? " selected" : ""}`}
        aria-pressed={same(sel, selection)}
        onClick={() => select(sel)}
      >
        <span className="stack-bar" style={color ? { background: color } : undefined} aria-hidden />
        <span className="stack-text">
          <span className="stack-name">{label}</span>
          <span className="stack-detail">{detail}</span>
        </span>
      </button>
    </li>
  );

  return (
    <nav className="stack-panel" aria-label="Layer stack">
      <div className="panel-head">
        <h2>Stack</h2>
        <div className="add-wrap">
          <button
            type="button"
            className="btn btn-quiet"
            disabled={full}
            title={full ? "Up to 8 layers" : undefined}
            aria-haspopup="dialog"
            onClick={() => setAdding(true)}
          >
            Add layer
          </button>
          {adding && (
            <Popover label="Add a layer" onClose={() => setAdding(false)} className="menu">
              {SHAPES.map((shape) => (
                <button
                  key={shape.value}
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    const at = index >= 0 ? index + 1 : design.layers.length;
                    edit((d) => {
                      const layers = [...d.layers];
                      layers.splice(at, 0, newLayer(shape.value, d, d.layers.length));
                      return { ...d, layers };
                    });
                    select({ kind: "layer", index: at });
                    setAdding(false);
                  }}
                >
                  {shape.title}
                </button>
              ))}
            </Popover>
          )}
        </div>
      </div>
      <ol className="stack-list">
        {row("ambient", { kind: "ambient" }, "Incident medium", design.ambient.name)}
        {design.layers.map((layer, i) => row(`layer-${i}`, { kind: "layer", index: i }, layer.name, summary(layer), layerColor(i)))}
        {row("substrate", { kind: "substrate" }, "Substrate", design.substrate.name)}
      </ol>
      {index >= 0 && (
        <div className="stack-actions" role="toolbar" aria-label={`Layer ${index + 1} actions`}>
          <button type="button" className="btn btn-quiet" disabled={index === 0} onClick={() => move(index, index - 1)}>
            Move up
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={index === design.layers.length - 1}
            onClick={() => move(index, index + 1)}
          >
            Move down
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={full}
            onClick={() => {
              edit((d) => {
                const layers = [...d.layers];
                layers.splice(index + 1, 0, { ...d.layers[index], name: `${d.layers[index].name} copy`.slice(0, 100) });
                return { ...d, layers };
              });
              select({ kind: "layer", index: index + 1 });
            }}
          >
            Duplicate
          </button>
          <button
            type="button"
            className="btn btn-quiet danger"
            disabled={design.layers.length === 1}
            onClick={() => edit((d) => ({ ...d, layers: d.layers.filter((_, i) => i !== index) }))}
          >
            Delete
          </button>
        </div>
      )}
    </nav>
  );
}
