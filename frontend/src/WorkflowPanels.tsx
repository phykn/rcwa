import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Project, SavedProject, Spectrum } from "./model";
import { totalThickness, stackSummary } from "./model";
import { semanticEqual, comparisonConditionsDiffer } from "./workflow";
import { materialColor } from "./structureGeometry";
import { reviewInputChanges } from "./reviewChanges";
import { stringify2DEnvelope } from "./project2d";

function fullInputs(project: Project) {
  return project.schema_version === "1.2"
    ? stringify2DEnvelope(project)
    : JSON.stringify(project, null, 2);
}

function Modal({
  title,
  children,
  onClose,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      element?.close();
      if (
        previous?.isConnected &&
        previous !== document.body &&
        previous.getClientRects().length
      )
        previous.focus({ preventScroll: true });
      else
        document.querySelector<HTMLElement>(".project-menu > summary")?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`workflow-dialog ${className}`}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button, input, select, textarea, a[href], summary, [tabindex]",
          ),
        ).filter(
          (element) =>
            !element.matches(':disabled, [hidden], [tabindex="-1"]') &&
            element.getClientRects().length > 0,
        );
        const first = controls[0],
          last = controls.at(-1);
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        const active = document.activeElement;
        const outside =
          active === event.currentTarget ||
          !event.currentTarget.contains(active);
        if (event.shiftKey && (active === first || outside)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || outside)) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="workflow-body">
        <div className="panel-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label={`Close ${title.toLowerCase()}`}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

function geometry(project: Project) {
  return { height: totalThickness(project), pitch: project.period_nm };
}
function GeometryCard({
  project,
  label,
  scale,
}: {
  project: Project;
  label: string;
  scale: number;
}) {
  const { height, pitch } = geometry(project);
  const is2D = project.schema_version === "1.2";
  let depth = 0;
  return (
    <section className="geometry-preview-card">
      <h3>{label}</h3>
      <svg
        viewBox="0 0 260 128"
        role="img"
        aria-label={`${label}: ${stackSummary(project)}; ${is2D ? `pitch X ${pitch} nm, pitch Y ${project.period_y_nm} nm. X–Z cross-section through the cell center; Y extent is not shown` : `pitch ${pitch} nm`}. Same geometric scale as the other preview.`}
      >
        <rect
          x="15"
          y="99"
          width={pitch * scale}
          height="7"
          fill={materialColor(project.substrate)}
        />
        {project.layers.map((layer, index) => {
          const top = 99 - (height - depth) * scale;
          depth += layer.thickness_nm;
          // Centered rectangles intersect y = 0 only when their Y width is
          // positive. A zero-Y inclusion must not appear as a finite ridge.
          const width =
            layer.geometry === "rectangle_1d"
              ? layer.cd_nm
              : layer.geometry === "rectangle_2d"
                ? layer.cd_y_nm > 0
                  ? layer.cd_x_nm
                  : 0
                : pitch;
          return (
            <g key={index}>
              {layer.geometry !== "homogeneous" && (
                <rect
                  x="15"
                  y={top}
                  width={pitch * scale}
                  height={layer.thickness_nm * scale}
                  fill={materialColor(layer.background)}
                />
              )}
              {width > 0 && layer.thickness_nm > 0 && (
                <rect
                  x={15 + ((pitch - width) * scale) / 2}
                  y={top}
                  width={width * scale}
                  height={layer.thickness_nm * scale}
                  fill={materialColor(layer.material)}
                />
              )}
              <line
                x1="15"
                x2={15 + pitch * scale}
                y1={top}
                y2={top}
                stroke="#a1a1aa"
                strokeWidth="0.5"
              />
            </g>
          );
        })}
        <line
          x1="15"
          x2={15 + pitch * scale}
          y1="99"
          y2="99"
          stroke="#a1a1aa"
        />
        <line
          x1="15"
          x2={15 + pitch * scale}
          y1="114"
          y2="114"
          stroke="#71717a"
        />
        <line x1="15" x2="15" y1="109" y2="119" stroke="#71717a" />
        <line
          x1={15 + pitch * scale}
          x2={15 + pitch * scale}
          y1="109"
          y2="119"
          stroke="#71717a"
        />
      </svg>
      <dl>
        <div>
          <dt>Layers</dt>
          <dd>{project.layers.length}</dd>
        </div>
        <div>
          <dt>Thickness</dt>
          <dd>{height} nm</dd>
        </div>
        <div>
          <dt>{is2D ? "Pitch X" : "Pitch"}</dt>
          <dd>{pitch} nm</dd>
        </div>
        {is2D && (
          <div>
            <dt>Pitch Y</dt>
            <dd>{project.period_y_nm} nm</dd>
          </div>
        )}
      </dl>
      {is2D && (
        <p className="preview-scale-note">
          X–Z section through the cell center. Y extent is not shown.
        </p>
      )}
    </section>
  );
}
export function ReviewPanel({
  title,
  baseProject,
  candidateProject,
  blockedReason,
  note,
  warnings,
  onApply,
  onClose,
}: {
  title: string;
  baseProject: Project;
  candidateProject: Project;
  blockedReason: string;
  note: string;
  warnings: string[];
  onApply: () => void;
  onClose: () => void;
}) {
  const before = geometry(baseProject),
    after = geometry(candidateProject);
  const scale = Math.min(
    230 / Math.max(before.pitch, after.pitch),
    90 / Math.max(1, before.height, after.height),
  );
  const changes = reviewInputChanges(baseProject, candidateProject);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="control-note">{note}</p>
      <div className="geometry-previews">
        <GeometryCard project={baseProject} label="Current" scale={scale} />
        <GeometryCard
          project={candidateProject}
          label="Proposed"
          scale={scale}
        />
      </div>
      <p className="preview-scale-note">
        Cross-sections use the same scale. No new spectrum has been calculated.
      </p>
      <div className="change-list" aria-label="Input changes">
        {changes.length ? (
          changes.map((change) => (
            <div key={change.key}>
              <span>{change.label}</span>
              <span>
                {change.before} <span aria-label="changes to">→</span>{" "}
                <strong>{change.after}</strong>
                {change.detail && (
                  <small className="change-detail">{change.detail}</small>
                )}
              </span>
            </div>
          ))
        ) : (
          <p>No input changes.</p>
        )}
      </div>
      <details className="workflow-details">
        <summary>Full inputs</summary>
        <h3>Current</h3>
        <pre>{fullInputs(baseProject)}</pre>
        <h3>Proposed</h3>
        <pre>{fullInputs(candidateProject)}</pre>
      </details>
      {warnings.length > 0 && (
        <div
          className="comparison-warning"
          role="note"
          aria-label="Proposal warnings"
        >
          <strong>Input warnings</strong>
          <ul>
            {warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {blockedReason && (
        <p className="inline-error" role="alert">
          {blockedReason}
        </p>
      )}
      <div className="workflow-actions">
        <button className="text-button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="dialog-close"
          disabled={!!blockedReason}
          onClick={onApply}
        >
          Apply changes
        </button>
      </div>
    </Modal>
  );
}

const candidateStyles = [
  { color: "#4f46e5", dash: "" },
  { color: "#c2410c", dash: "7 4" },
  { color: "#047857", dash: "2 4" },
];
const quantities = [
  { key: "R", name: "Total reflectance" },
  { key: "T", name: "Total transmittance" },
  { key: "R_specular", name: "Specular reflectance" },
  { key: "T_specular", name: "Specular transmittance" },
] as const;
type Quantity = (typeof quantities)[number]["key"];
export function ComparisonPanel({
  candidates,
  onUse,
  onClose,
}: {
  candidates: SavedProject[];
  onUse: (candidate: SavedProject) => void;
  onClose: () => void;
}) {
  const [polarization, setPolarization] = useState<"s" | "p">("s");
  const [quantity, setQuantity] = useState<Quantity>("R");
  const [index, setIndex] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(260, entry.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const waves = candidates[0]?.result?.wavelengths_nm || [];
  const missing = candidates.find(
    (candidate) => !candidate.result?.spectra[polarization],
  );
  const mismatch = candidates.some(
    (candidate) => !semanticEqual(candidate.result?.wavelengths_nm, waves),
  );
  const blocked = missing
    ? `${missing.name} has no ${polarization}-polarized spectrum.`
    : mismatch
      ? "Wavelength grids differ. Compare candidates calculated at the same exact wavelengths; no interpolation is applied."
      : "";
  const sample = Math.min(index, Math.max(0, waves.length - 1));
  const spectra = candidates.map(
    (candidate) =>
      candidate.result?.spectra[polarization] as Spectrum | undefined,
  );
  const values = spectra.flatMap((spectrum) => spectrum?.[quantity] || []);
  const ymin = Math.min(0, ...values),
    ymax = Math.max(1, ...values);
  const left = 45,
    right = width - 12,
    top = 12,
    bottom = 188;
  const x = (wave: number) =>
    waves.length === 1
      ? (left + right) / 2
      : left +
        ((wave - waves[0]) / (waves.at(-1)! - waves[0])) * (right - left);
  const y = (value: number) =>
    bottom - ((value - ymin) / (ymax - ymin)) * (bottom - top);
  const conditionsDiffer = candidates
    .slice(1)
    .some((candidate) =>
      comparisonConditionsDiffer(candidates[0].project, candidate.project),
    );
  return (
    <Modal
      title="Compare candidates"
      className="comparison-dialog"
      onClose={onClose}
    >
      <div className="candidate-cards">
        {candidates.map((candidate, i) => (
          <section className="candidate-card" key={candidate.id}>
            <h3>
              <i
                style={{
                  borderColor: candidateStyles[i].color,
                  borderTopStyle: i ? "dashed" : "solid",
                }}
              />
              {i + 1}. {candidate.name}
            </h3>
            <span className="candidate-origin">
              {candidate.provenance?.source === "server_computed"
                ? "Server-computed"
                : "Unverified import"}
            </span>
            <p>
              {candidate.project.schema_version === "1.2"
                ? `Schema 1.2 · Pitch X ${candidate.project.period_nm} nm · Pitch Y ${candidate.project.period_y_nm} nm`
                : `Pitch ${candidate.project.period_nm} nm`}{" "}
              · {stackSummary(candidate.project)}
            </p>
            <p>
              {candidate.project.illumination.angle_deg}° ·{" "}
              {candidate.project.schema_version === "1.2" &&
                `Azimuth ${candidate.project.illumination.azimuth_deg}° · `}
              {candidate.project.illumination.polarization === "both"
                ? "s & p"
                : candidate.project.illumination.polarization}{" "}
              ·{" "}
              {candidate.project.schema_version === "1.2"
                ? `Hx = ${candidate.project.solver.harmonics_x} · Hy = ${candidate.project.solver.harmonics_y}`
                : `N = ${candidate.project.solver.harmonics}`}{" "}
              · {candidate.result?.wavelengths_nm.length} wavelengths
            </p>
            <details className="workflow-details">
              <summary>Run details</summary>
              <p>Snapshot {candidate.id}</p>
              <p>Schema {candidate.project.schema_version}</p>
              <p>
                Wavelengths: {candidate.result?.wavelengths_nm.join(", ")} nm
              </p>
              {candidate.result?.warnings.length ? (
                <ul>
                  {candidate.result.warnings.map((warning, wi) => (
                    <li key={wi}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              <pre>{fullInputs(candidate.project)}</pre>
            </details>
            <button
              className="text-button"
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                onUse(candidate);
              }}
            >
              Review candidate {i + 1}
            </button>
          </section>
        ))}
      </div>
      <div className="comparison-controls">
        <label>
          Quantity
          <select
            aria-label="Comparison quantity"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value as Quantity)}
          >
            {quantities.map((item) => (
              <option key={item.key} value={item.key}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Polarization
          <select
            aria-label="Comparison polarization"
            value={polarization}
            onChange={(event) =>
              setPolarization(event.target.value as "s" | "p")
            }
          >
            <option value="s">s / TE</option>
            <option value="p">p / TM</option>
          </select>
        </label>
      </div>
      {conditionsDiffer && (
        <p className="comparison-warning">
          Incidence angle, azimuth, polarization, geometry, Fourier orders,
          optical materials or schema differ. Check each candidate’s run details
          when interpreting these curves.
        </p>
      )}
      <div ref={host} className="comparison-plot">
        {blocked ? (
          <p className="inline-error" role="alert">
            {blocked}
          </p>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${width} 234`}
              role="img"
              aria-label={`${quantities.find((item) => item.key === quantity)?.name}, ${polarization} polarization, for ${candidates.length} saved candidates. Exact samples are listed below.`}
            >
              {[0, 0.5, 1].map((fraction) => (
                <g key={fraction}>
                  <line
                    x1={left}
                    x2={right}
                    y1={y(ymin + fraction * (ymax - ymin))}
                    y2={y(ymin + fraction * (ymax - ymin))}
                    stroke="#e4e4e7"
                  />
                  <text
                    x={left - 8}
                    y={y(ymin + fraction * (ymax - ymin)) + 4}
                    textAnchor="end"
                    className="chart-tick"
                  >
                    {(ymin + fraction * (ymax - ymin)).toFixed(2)}
                  </text>
                </g>
              ))}
              {(waves.length === 1
                ? [waves[0]]
                : [
                    waves[0],
                    waves[Math.floor((waves.length - 1) / 2)],
                    waves.at(-1)!,
                  ]
              ).map((wave, i) => (
                <text
                  key={i}
                  x={x(wave)}
                  y="208"
                  textAnchor="middle"
                  className="chart-tick"
                >
                  {wave}
                </text>
              ))}
              <text
                x={width / 2}
                y="230"
                textAnchor="middle"
                className="chart-axis"
              >
                Wavelength · nm
              </text>
              {spectra.map(
                (spectrum, i) =>
                  spectrum && (
                    <g key={candidates[i].id}>
                      <path
                        d={spectrum[quantity]
                          .map(
                            (value, wi) =>
                              `${wi ? "L" : "M"}${x(waves[wi])},${y(value)}`,
                          )
                          .join(" ")}
                        fill="none"
                        stroke={candidateStyles[i].color}
                        strokeWidth="2.5"
                        strokeDasharray={candidateStyles[i].dash}
                      />
                      <circle
                        cx={x(waves[sample])}
                        cy={y(spectrum[quantity][sample])}
                        r="4"
                        fill={candidateStyles[i].color}
                        stroke="white"
                      />
                    </g>
                  ),
              )}
            </svg>
            <label className="comparison-sample">
              Exact sample <strong>{waves[sample]} nm</strong>
              <input
                aria-label="Compare exact wavelength sample"
                aria-valuetext={`${waves[sample]} nanometers`}
                aria-describedby="comparison-sample-description"
                type="range"
                min="0"
                max={Math.max(0, waves.length - 1)}
                value={sample}
                onChange={(event) => setIndex(Number(event.target.value))}
              />
            </label>
            <p
              className="sr-only"
              id="comparison-sample-description"
              aria-live="polite"
              aria-atomic="true"
            >
              {`${waves[sample]} nanometers. ${quantities.find((item) => item.key === quantity)?.name}, ${polarization} polarization. ${candidates.map((candidate, i) => `${candidate.name}: ${(spectra[i]![quantity][sample] * 100).toFixed(3)} percent`).join(". ")}.`}
            </p>
            <div className="comparison-values">
              {candidates.map((candidate, i) => (
                <p key={candidate.id}>
                  <span>
                    <i
                      style={{
                        borderColor: candidateStyles[i].color,
                        borderTopStyle: i ? "dashed" : "solid",
                      }}
                    />
                    {i + 1}. {candidate.name}
                  </span>
                  <strong>
                    {spectra[i]
                      ? (spectra[i]![quantity][sample] * 100).toFixed(3)
                      : "—"}
                    %
                  </strong>
                </p>
              ))}
            </div>
          </>
        )}
      </div>
      <p className="preview-scale-note">
        Saved results only. This comparison does not establish convergence or an
        optimum.
      </p>
    </Modal>
  );
}
