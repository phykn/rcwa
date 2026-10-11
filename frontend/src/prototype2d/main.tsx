import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrototypeScene } from "./Scene";
import type {
  PrototypeGeometryProject,
  PrototypeGeometryLayer,
} from "./geometry";
import input from "../fixtures/default-project-2d.json";
import { layerColor } from "../layerColors";
import "../fonts.css";
import "../styles.css";
import "./prototype.css";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Project = Mutable<Omit<PrototypeGeometryProject, "layers">> & {
  layers: Mutable<PrototypeGeometryLayer>[];
  name: string;
  illumination: {
    angle_deg: number;
    azimuth_deg: number;
    wavelengths_nm: number[];
    polarization: string;
  };
  solver: { harmonics_x: number; harmonics_y: number };
};
type Series = { R: number[]; T: number[] };
type Result = {
  wavelengths_nm: number[];
  spectra: { s: Series; p: Series };
  metadata: { input_hash: string };
};
type Sheet = "width" | "thickness" | "pitch" | "settings" | "light";
const original = input as Project;
const same = (a: Project, b: Project) =>
  JSON.stringify(a) === JSON.stringify(b);
const pretty = (value: number) =>
  Number.isInteger(value)
    ? String(value)
    : Number(value.toPrecision(6)).toString();

function NumericField({
  label,
  value,
  min,
  max,
  reason,
  onStart,
  onEnd,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  reason?: string;
  onStart: () => void;
  onEnd: () => void;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const valid =
    draft.trim() !== "" &&
    Number.isFinite(Number(draft)) &&
    Number(draft) >= min &&
    Number(draft) <= max;
  const id = `p2-${label.replaceAll(" ", "-").toLowerCase()}`;
  return (
    <div className="p2-field">
      <label htmlFor={id}>
        {label}
        <span>nm</span>
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step="any"
        min={min}
        max={max}
        value={draft}
        aria-invalid={!valid}
        aria-describedby={!valid ? `${id}-error` : undefined}
        onFocus={onStart}
        onBlur={onEnd}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const next = Number(text);
          if (
            text.trim() !== "" &&
            Number.isFinite(next) &&
            next >= min &&
            next <= max
          )
            onChange(next);
        }}
      />
      {!valid && (
        <p id={`${id}-error`} className="p2-error" role="alert">
          {reason || `${label} must be ${min}–${max} nm.`}{" "}
          {draft || "This value"} is not applied. Keeping {value} nm.
        </p>
      )}
    </div>
  );
}

function Plot({ result, stale }: { result: Result | null; stale: boolean }) {
  const [polarization, setPolarization] = useState<"s" | "p">("s");
  const [sample, setSample] = useState(0);
  if (!result)
    return (
      <section id="spectrum" className="p2-result">
        <h2>Spectrum</h2>
        <p>No result yet. The stored example could not be loaded.</p>
      </section>
    );
  const spectrum = result.spectra[polarization],
    waves = result.wavelengths_nm;
  const line = (values: number[]) =>
    values
      .map((v, i) => `${40 + (280 * i) / (values.length - 1)},${205 - 180 * v}`)
      .join(" ");
  return (
    <section id="spectrum" className="p2-result">
      <div className="p2-result-heading">
        <h2>Spectrum</h2>
        <span className={stale ? "p2-stale" : "p2-reference"}>
          {stale ? "Inputs changed" : "Precomputed example"}
        </span>
      </div>
      {stale ? (
        <p className="p2-stale-note">
          This stored spectrum no longer matches your inputs.
        </p>
      ) : (
        <p className="p2-result-note">
          Synthetic 2D example. Edits don't recalculate this spectrum.
        </p>
      )}
      <div className="segmented" aria-label="Incident polarization">
        {(["s", "p"] as const).map((p) => (
          <button
            key={p}
            aria-pressed={p === polarization}
            className={p === polarization ? "selected" : ""}
            onClick={() => setPolarization(p)}
          >
            {p} incident
          </button>
        ))}
      </div>
      <svg
        viewBox="0 0 350 255"
        role="img"
        aria-label={`Precomputed ${polarization} incident total reflectance and transmittance spectrum`}
      >
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line
              x1="40"
              y1={205 - v * 180}
              x2="320"
              y2={205 - v * 180}
              stroke="#e4e4e7"
            />
            <text x="30" y={210 - v * 180} textAnchor="end">
              {v.toFixed(1)}
            </text>
          </g>
        ))}
        {[0, 10, 20].map((i) => (
          <text key={i} x={40 + (280 * i) / 20} y="225" textAnchor="middle">
            {waves[i]}
          </text>
        ))}
        <polyline
          points={line(spectrum.R)}
          fill="none"
          stroke="#c2410c"
          strokeWidth="2"
        />
        <polyline
          points={line(spectrum.T)}
          fill="none"
          stroke="#0e7490"
          strokeWidth="2"
        />
        <text x="180" y="250" textAnchor="middle">
          Wavelength · nm
        </text>
      </svg>
      <div className="p2-spectrum-legend">
        <span>— Reflectance</span>
        <span>— Transmittance</span>
      </div>
      <label className="p2-wavelength" htmlFor="p2-sample">
        Wavelength <strong>{waves[sample]} nm</strong>
      </label>
      <input
        id="p2-sample"
        type="range"
        min={0}
        max={waves.length - 1}
        value={sample}
        aria-valuetext={`${waves[sample]} nanometers`}
        onChange={(e) => setSample(Number(e.target.value))}
      />
      <div className="p2-readouts" aria-live="polite">
        <span>
          Reflectance<strong>{(100 * spectrum.R[sample]).toFixed(2)}%</strong>
        </span>
        <span>
          Transmittance<strong>{(100 * spectrum.T[sample]).toFixed(2)}%</strong>
        </span>
      </div>
      <p className="p2-result-note">
        A stored solver result. Live calculation requires the local solver.
      </p>
    </section>
  );
}

function Prototype() {
  const [project, setProject] = useState<Project>(() =>
    structuredClone(original),
  );
  const current = useRef(project);
  current.current = project;
  const [selected, setSelected] = useState(0);
  const [cutaway, setCutaway] = useState(true);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<{
    past: Project[];
    future: Project[];
  }>({ past: [], future: [] });
  const session = useRef<Project | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const chipStrip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = chipStrip.current;
    const chip = strip?.querySelector<HTMLElement>(
      `[data-index="${selected}"]`,
    );
    if (!strip || !chip) return;
    const left = chip.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (left + chip.offsetWidth > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = left + chip.offsetWidth - strip.clientWidth;
  }, [selected, project.layers.length]);
  const layer = project.layers[selected];
  const stale = !same(project, original);
  useEffect(() => {
    let alive = true;
    fetch("/reference-2d.json")
      .then((r) => {
        if (!r.ok) throw new Error("Reference unavailable");
        return r.json();
      })
      .then((data) => {
        if (
          data.result.metadata.input_hash !==
            "eeb26da3484602221944f1784b4b93ce2ed76f89b61e95d34bb68730be7bddc7" ||
          !same(data.project, original)
        )
          throw new Error("Reference identity mismatch");
        if (alive) setResult(data.result);
      })
      .catch(() => {
        if (alive) setResult(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  function begin() {
    session.current ??= structuredClone(current.current);
  }
  function end() {
    const start = session.current;
    session.current = null;
    if (start && !same(start, current.current))
      setHistory((h) => ({ past: [...h.past, start], future: [] }));
  }
  function edit(change: (next: Project) => void) {
    const next = structuredClone(current.current);
    change(next);
    current.current = next;
    setProject(next);
  }
  function open(next: Sheet) {
    previousFocus.current = document.activeElement as HTMLElement;
    setSheet(next);
  }
  function close() {
    end();
    setSheet(null);
  }
  useEffect(() => {
    if (sheet) dialog.current?.showModal();
    else if (dialog.current?.open) {
      dialog.current.close();
      previousFocus.current?.focus({ preventScroll: true });
    }
  }, [sheet]);
  function historyStep(direction: "undo" | "redo") {
    end();
    setHistory((h) => {
      const from = direction === "undo" ? h.past : h.future;
      if (!from.length) return h;
      const next = from[from.length - 1];
      const prior = current.current;
      current.current = next;
      setProject(next);
      setSelected((index) => Math.min(index, next.layers.length - 1));
      return direction === "undo"
        ? { past: h.past.slice(0, -1), future: [...h.future, prior] }
        : { past: [...h.past, prior], future: h.future.slice(0, -1) };
    });
  }
  function addLayer(kind: "rectangle_2d" | "homogeneous") {
    if (current.current.layers.length >= 8) return;
    begin();
    const index = current.current.layers.length;
    edit((p) => {
      const source = p.layers[0];
      const base = {
        name: kind === "homogeneous" ? "Uniform film" : "2D pattern",
        thickness_nm: 90,
        material: structuredClone(source.material),
      };
      if (kind === "homogeneous") p.layers.push({ ...base, geometry: kind });
      else
        p.layers.push({
          ...base,
          geometry: kind,
          cd_x_nm: p.period_nm / 2,
          cd_y_nm: p.period_y_nm / 2,
          background: {
            name: "Synthetic background",
            kind: "constant",
            n: 1.45,
            k: 0,
          },
        });
    });
    end();
    setSelected(index);
  }
  const maxWidth = (axis: "x" | "y") =>
    project.layers.reduce(
      (largest, item, index) => {
        const width =
          item.geometry === "rectangle_2d"
            ? axis === "x"
              ? item.cd_x_nm
              : item.cd_y_nm
            : item.geometry === "rectangle_1d" && axis === "x"
              ? item.cd_nm
              : 0;
        return width > largest.value ? { value: width, index } : largest;
      },
      { value: 20, index: -1 },
    );
  const widthX =
    layer.geometry === "rectangle_2d"
      ? layer.cd_x_nm
      : layer.geometry === "rectangle_1d"
        ? layer.cd_nm
        : 0;
  const widthY = layer.geometry === "rectangle_2d" ? layer.cd_y_nm : null;
  const scope =
    sheet === "pitch"
      ? "Shared pitch"
      : sheet === "settings"
        ? `Layer ${selected + 1}`
        : sheet === "light"
          ? "Light"
          : `Layer ${selected + 1} · ${sheet === "width" ? "Width" : "Thickness"}`;
  return (
    <div
      className="app-shell p2"
      data-project={JSON.stringify(project)}
      data-history-count={history.past.length}
    >
      <header className="topbar">
        <a className="wordmark" href="#main">
          <span aria-hidden="true">↳</span> RCWA
        </a>
        <div className="header-right">
          <details className="project-menu">
            <summary>Project ⌄</summary>
            <div className="file-actions">
              <button
                disabled={!history.past.length}
                onClick={() => historyStep("undo")}
              >
                ↶ Undo
              </button>
              <button
                disabled={!history.future.length}
                onClick={() => historyStep("redo")}
              >
                ↷ Redo
              </button>
              <button
                onClick={() => {
                  begin();
                  edit((p) => Object.assign(p, structuredClone(original)));
                  end();
                }}
              >
                Reset example
              </button>
            </div>
          </details>
          <span className="p2-static">• Static preview</span>
        </div>
      </header>
      <main id="main">
        <div className="p2-heading">
          <h1>Build your structure</h1>
          <div>
            <span>Project</span>
            <span className="p2-project-name" title={project.name}>
              {project.name}
            </span>
          </div>
        </div>
        <div className="p2-columns">
          <section className="p2-editor" aria-label="2D structure editor">
            <div className="p2-layer-heading">
              <h2>
                Choose a layer <small>· {project.layers.length}</small>
              </h2>
              <details className="p2-add">
                <summary
                  aria-disabled={project.layers.length >= 8}
                  onClick={(e) => {
                    if (project.layers.length >= 8) e.preventDefault();
                  }}
                >
                  {project.layers.length >= 8 ? "8-layer limit" : "+ Add layer"}
                </summary>
                <div>
                  <button
                    onClick={(e) => {
                      addLayer("rectangle_2d");
                      e.currentTarget.closest("details")!.open = false;
                    }}
                  >
                    2D pattern
                  </button>
                  <button
                    onClick={(e) => {
                      addLayer("homogeneous");
                      e.currentTarget.closest("details")!.open = false;
                    }}
                  >
                    Uniform film
                  </button>
                </div>
              </details>
            </div>
            <div
              className="p2-layers"
              ref={chipStrip}
              aria-label="Layers top to bottom"
            >
              {project.layers.map((item, i) => (
                <button
                  key={i}
                  data-index={i}
                  aria-label={`Select layer ${i + 1}: ${item.name}`}
                  aria-pressed={i === selected}
                  onClick={() => setSelected(i)}
                >
                  <span
                    className="p2-layer-number"
                    style={{ background: layerColor(i) }}
                  >
                    {i + 1}
                  </span>
                  {item.geometry === "homogeneous" ? "Film" : "Pattern"}
                  {i === selected && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
            <div className="p2-scene">
              <PrototypeScene
                project={project}
                selected={selected}
                cutaway={cutaway}
                onSelect={setSelected}
              />
              <div className="p2-view-control">
                <label>
                  <span>View</span>
                  <select
                    aria-label="Structure view"
                    value={cutaway ? "cutaway" : "full"}
                    onChange={(e) => setCutaway(e.target.value === "cutaway")}
                  >
                    <option value="full">Full stack</option>
                    <option value="cutaway">Cutaway</option>
                  </select>
                </label>
                {cutaway && <span className="p2-cut-note">Corner hidden</span>}
              </div>
              <details
                className="p2-guide"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.currentTarget.open = false;
                    e.currentTarget.querySelector("summary")?.focus();
                  }
                }}
              >
                <summary aria-label="View guide">ⓘ</summary>
                <div tabIndex={0} role="region" aria-label="View guide details">
                  <p>
                    A corner is hidden in Cutaway to show inner layers; your
                    structure is unchanged.
                  </p>
                  <p>
                    X and Y stay fixed to the structure. Width is one pattern's
                    size; pitch is its repeat spacing. The dashed outline marks
                    one repeat cell.
                  </p>
                  <p>
                    Colors identify layers from top to bottom; pale gray is
                    background material. The gray base is the substrate, shown
                    at a schematic depth.
                  </p>
                </div>
              </details>
              <div className="p2-selection">
                <span style={{ background: layerColor(selected) }} />
                Selected: Layer {selected + 1}
              </div>
            </div>
            <div className="p2-context">
              <strong>Edit Layer {selected + 1}</strong>
              <button onClick={() => open("settings")}>Layer settings ↗</button>
            </div>
            <div
              className="p2-dimensions"
              data-uniform={layer.geometry === "homogeneous"}
            >
              {layer.geometry !== "homogeneous" && (
                <button
                  aria-label={`Edit Layer ${selected + 1} width: X ${widthX} nanometers${widthY !== null ? `, Y ${widthY} nanometers` : ""}`}
                  onClick={() => open("width")}
                >
                  <span>Width</span>
                  <strong>
                    <small>X</small> {pretty(widthX)}
                    <small>nm</small>
                  </strong>
                  {widthY !== null && (
                    <strong>
                      <small>Y</small> {pretty(widthY)}
                      <small>nm</small>
                    </strong>
                  )}
                  <em>Edit ↗</em>
                </button>
              )}
              <button
                aria-label={`Edit Layer ${selected + 1} thickness: ${layer.thickness_nm} nanometers`}
                onClick={() => open("thickness")}
              >
                <span>Thickness</span>
                <strong>
                  {pretty(layer.thickness_nm)}
                  <small>nm</small>
                </strong>
                <em>Edit ↗</em>
              </button>
              <button
                aria-label={`Edit shared pitch: X ${project.period_nm} nanometers, Y ${project.period_y_nm} nanometers`}
                onClick={() => open("pitch")}
              >
                <span>Shared pitch</span>
                <strong>
                  <small>X</small> {pretty(project.period_nm)}
                  <small>nm</small>
                </strong>
                <strong>
                  <small>Y</small> {pretty(project.period_y_nm)}
                  <small>nm</small>
                </strong>
                <em>Edit ↗</em>
              </button>
            </div>
            <button className="p2-light" onClick={() => open("light")}>
              <span>☼ &nbsp; Light</span>
              <span>
                <strong>450–850 nm</strong>
                <small>20° · azimuth 25° · s & p</small>
              </span>
              <span>→</span>
            </button>
            <a className="p2-primary" href="#spectrum">
              View example spectrum <span>↓</span>
            </a>
            <p className="p2-static-note">
              Preview only. Edits won't calculate a new spectrum.
            </p>
          </section>
          <Plot result={result} stale={stale} />
        </div>
      </main>
      <dialog
        ref={dialog}
        className="p2-dialog"
        aria-label={scope}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        {sheet && (
          <div className="p2-sheet" key={`${sheet}-${selected}`}>
            <header>
              <div>
                <h2>{scope}</h2>
                {sheet === "pitch" && <p>Repeat spacing for all layers.</p>}
                {sheet === "width" && (
                  <p>Size of one pattern within each repeat.</p>
                )}
              </div>
              <button aria-label="Close settings" onClick={close}>
                ×
              </button>
            </header>
            {sheet === "width" && (
              <>
                <NumericField
                  label="Width X"
                  value={widthX}
                  min={0}
                  max={project.period_nm}
                  onStart={begin}
                  onEnd={end}
                  onChange={(v) =>
                    edit((p) => {
                      const l = p.layers[selected];
                      if (l.geometry === "rectangle_2d") l.cd_x_nm = v;
                      else if (l.geometry === "rectangle_1d") l.cd_nm = v;
                    })
                  }
                />
                {widthY !== null && (
                  <NumericField
                    label="Width Y"
                    value={widthY}
                    min={0}
                    max={project.period_y_nm}
                    onStart={begin}
                    onEnd={end}
                    onChange={(v) =>
                      edit((p) => {
                        const l = p.layers[selected];
                        if (l.geometry === "rectangle_2d") l.cd_y_nm = v;
                      })
                    }
                  />
                )}
              </>
            )}
            {sheet === "thickness" && (
              <NumericField
                label="Thickness"
                value={layer.thickness_nm}
                min={0}
                max={2000}
                onStart={begin}
                onEnd={end}
                onChange={(v) =>
                  edit((p) => {
                    p.layers[selected].thickness_nm = v;
                  })
                }
              />
            )}
            {sheet === "pitch" &&
              (["x", "y"] as const).map((axis) => {
                const bound = maxWidth(axis);
                return (
                  <NumericField
                    key={axis}
                    label={`Pitch ${axis.toUpperCase()}`}
                    value={
                      axis === "x" ? project.period_nm : project.period_y_nm
                    }
                    min={bound.value}
                    max={5000}
                    reason={`Pitch ${axis.toUpperCase()} must be at least ${bound.value} nm${bound.index >= 0 ? ` because of Layer ${bound.index + 1}` : ""}.`}
                    onStart={begin}
                    onEnd={end}
                    onChange={(v) =>
                      edit((p) => {
                        if (axis === "x") p.period_nm = v;
                        else p.period_y_nm = v;
                      })
                    }
                  />
                );
              })}
            {sheet === "settings" && (
              <>
                <p>{layer.name}</p>
                <p>
                  Layer colors identify position. The pattern and its background
                  are separate materials.
                </p>
                <dl>
                  <dt>Pattern material</dt>
                  <dd>
                    n {layer.material.n} · k {layer.material.k}
                  </dd>
                  {layer.geometry !== "homogeneous" && (
                    <>
                      <dt>Background material</dt>
                      <dd>
                        n {layer.background.n} · k {layer.background.k}
                      </dd>
                    </>
                  )}
                </dl>
              </>
            )}
            {sheet === "light" && (
              <p>
                The approved stored example uses 21 wavelengths from450 to850nm,
                incidence20°, azimuth25°, and both incident polarizations.
              </p>
            )}
            <button className="p2-done" onClick={close}>
              Done
            </button>
          </div>
        )}
      </dialog>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Prototype />);
