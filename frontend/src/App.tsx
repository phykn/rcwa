import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { api, apiDescription, ApiError } from "./api";
import {
  defaultProject,
  downloadProject,
  isForwardResult,
  linspace,
  parseProjectFile,
  sameProject,
  validateProject,
} from "./model";
import type {
  ForwardResult,
  Job,
  Material,
  Project,
  SavedProject,
} from "./model";
import { Geometry, SpectrumPlot } from "./Visuals";
import type { Dimension } from "./Visuals";
import { SyntheticFit } from "./SyntheticFit";

function Icon({
  name,
}: {
  name: "play" | "download" | "upload" | "folder" | "save" | "check" | "arrow";
}) {
  const paths = {
    play: <path d="m8 5 11 7-11 7z" />,
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5" />
        <path d="M5 16v5h14v-5" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V4m-5 5 5-5 5 5" />
        <path d="M5 16v5h14v-5" />
      </>
    ),
    folder: <path d="M3 6h7l2 2h9v12H3z" />,
    save: (
      <>
        <path d="M4 3h14l3 3v15H3V3z" />
        <path d="M7 3v6h10V3M7 21v-8h10v8" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  };
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill={name === "play" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
function Field({
  label,
  unit,
  value,
  onChange,
  min,
  max,
  step = 1,
  help,
  id,
  selected = false,
  onFocus,
}: {
  label: string;
  unit?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
  id?: string;
  selected?: boolean;
  onFocus?: () => void;
}) {
  return (
    <label className={`field ${selected ? "dimension-selected" : ""}`}>
      <span>
        {label}
        {unit && <small>{unit}</small>}
      </span>
      <input
        id={id}
        onFocus={onFocus}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {help && <small className="field-help">{help}</small>}
    </label>
  );
}
function Section({
  title,
  children,
  open = true,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="control-section" data-section={title} open={open}>
      <summary>
        {title}
        <span className="chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="section-body">{children}</div>
    </details>
  );
}
function MaterialEditor({
  label,
  material,
  onChange,
  lossless = false,
}: {
  label: string;
  material: Material;
  onChange: (m: Material) => void;
  lossless?: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  async function importMaterial(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    try {
      if (selected.size > 1024 * 1024)
        throw new Error("Material JSON must be smaller than 1 MB.");
      const next = JSON.parse(await selected.text()) as Material;
      if (
        !next ||
        typeof next.name !== "string" ||
        next.kind !== "tabulated" ||
        !Array.isArray(next.wavelengths_nm) ||
        !Array.isArray(next.n_values) ||
        !Array.isArray(next.k_values)
      )
        throw new Error(
          "Use a tabulated Material object with wavelengths_nm, n_values, and k_values.",
        );
      const candidate = {
        ...next,
        n: next.n ?? 1,
        k: next.k ?? 0,
        name: next.name || `${label} table`,
      };
      const validation = validateProject({
        ...defaultProject,
        illumination: {
          ...defaultProject.illumination,
          wavelengths_nm: [
            Math.max(200, Math.min(2500, next.wavelengths_nm[0])),
          ],
        },
        layers: [{ ...defaultProject.layers[0], material: candidate }],
      });
      if (validation.length) throw new Error(validation.join(" "));
      if (lossless && candidate.k_values?.some((k) => k !== 0))
        throw new Error("Ambient table must be lossless (k = 0).");
      onChange(candidate);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid material JSON.");
    } finally {
      event.target.value = "";
    }
  }
  return (
    <div className="material-row">
      <div className="material-heading">
        <span className={`material-dot ${label.toLowerCase()}`} />
        <strong>{label}</strong>
        <span>{material.kind === "tabulated" ? "Table" : "Constant"}</span>
      </div>
      <input
        className="material-name"
        aria-label={`${label} material name`}
        value={material.name}
        maxLength={100}
        onChange={(e) => onChange({ ...material, name: e.target.value })}
      />
      {material.kind === "constant" ? (
        <div className="field-grid">
          <Field
            label={`${label} n`}
            value={material.n}
            min={0.001}
            max={10}
            step={0.01}
            onChange={(n) => onChange({ ...material, n })}
          />
          <Field
            label={`${label} k`}
            value={material.k}
            min={0}
            max={lossless ? 0 : 10}
            step={0.01}
            onChange={(k) => onChange({ ...material, k })}
          />
        </div>
      ) : (
        <div className="table-summary">
          {material.wavelengths_nm?.length} samples ·{" "}
          {material.wavelengths_nm?.[0]}–{material.wavelengths_nm?.at(-1)} nm
          <button
            type="button"
            onClick={() =>
              onChange({
                name: material.name,
                kind: "constant",
                n: material.n ?? 1,
                k: material.k ?? 0,
              })
            }
          >
            Use constant
          </button>
        </div>
      )}
      <button
        className="text-button"
        type="button"
        onClick={() => file.current?.click()}
      >
        Import n/k table JSON <span>↗</span>
      </button>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={importMaterial}
      />
      {error && <p className="inline-error">{error}</p>}
    </div>
  );
}
const staticPreview =
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_STATIC_PREVIEW === "true";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "An unexpected error occurred.";

export default function App() {
  const [selectedDimension, setSelectedDimension] = useState<Dimension | null>(
    null,
  );
  function selectDimension(dimension: Dimension) {
    setSelectedDimension(dimension);
    document.getElementById(`dimension-${dimension}`)?.focus();
  }
  function showSettings(title: string) {
    const settings =
      document.querySelector<HTMLDetailsElement>(".more-settings");
    if (settings) settings.open = true;
    const section = document.querySelector<HTMLDetailsElement>(
      `[data-section="${title}"]`,
    );
    if (section) {
      section.open = true;
      section.querySelector<HTMLElement>("summary")?.focus();
    }
  }
  const [project, setProject] = useState<Project>(
    structuredClone(defaultProject),
  );
  const [result, setResult] = useState<ForwardResult | null>(null);
  const [resultOrigin, setResultOrigin] = useState<
    "computed" | "imported" | "reference"
  >("computed");
  const [resultProject, setResultProject] = useState<Project | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [fitBusy, setFitBusy] = useState(false);
  const [connection, setConnection] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [polarization, setPolarization] = useState<"s" | "p">("s");
  const [saved, setSaved] = useState<SavedProject[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const inputFile = useRef<HTMLInputElement>(null);
  const inputsChanged = useRef(false);
  const jobProject = useRef<Project | null>(null);
  const activeJob = useRef<string | null>(null);
  const jobStart = useRef(0);
  const forwardBusy =
    starting || job?.status === "queued" || job?.status === "running";
  const busy = forwardBusy || fitBusy;
  const errors = validateProject(project);
  const stale = result !== null && !sameProject(resultProject, project);
  const layer = project.layers[0];
  const waves = project.illumination.wavelengths_nm;
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const selectedSpectrum = result?.spectra[polarization];

  useEffect(() => {
    let alive = true;
    if (staticPreview) {
      readReference()
        .then((data) => {
          if (!alive || inputsChanged.current) return;
          setProject(data.project);
          setResult(data.result || null);
          setResultProject(data.project);
          setResultOrigin("reference");
          setConnection("offline");
        })
        .catch((error) => {
          if (alive) {
            setConnection("offline");
            setError(errorText(error));
          }
        });
      return () => {
        alive = false;
      };
    }
    api
      .example()
      .then((example) => {
        if (!alive) return;
        if (validateProject(example).length)
          throw new Error("The server returned an unsupported example.");
        setConnection("online");
        if (!inputsChanged.current) setProject(example);
      })
      .catch(async () => {
        if (alive) {
          setConnection("offline");
          if (!inputsChanged.current) {
            try {
              const data = await readReference();
              if (alive && !inputsChanged.current) {
                setProject(data.project);
                setResult(data.result || null);
                setResultProject(data.project);
                setResultOrigin("reference");
              }
            } catch {
              /* Offline editing remains available if the bundled example is unavailable. */
            }
          }
        }
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!showSaved) return;
    const previous = document.activeElement as HTMLElement | null;
    function trap(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowSaved(false);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".dialog button, .dialog input, .dialog select",
        ),
      ).filter((e) => !e.hasAttribute("disabled"));
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [showSaved]);
  useEffect(() => {
    if (!forwardBusy) return;
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - jobStart.current) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [forwardBusy]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    let stopped = false,
      timer: number;
    const id = job.id;
    async function poll() {
      if (stopped || activeJob.current !== id) return;
      if (Date.now() - jobStart.current > 10 * 60 * 1000) {
        activeJob.current = null;
        setJob((prev) => (prev ? { ...prev, status: "failed" } : prev));
        setError(
          "Calculation exceeded the 10-minute UI limit. Cancellation was requested. Check the server before starting another job.",
        );
        api.cancel(id).catch(() => {});
        return;
      }
      try {
        const next = await api.job(id);
        if (stopped || activeJob.current !== id) return;
        setConnection("online");
        setJob(next);
        if (next.status === "succeeded") {
          activeJob.current = null;
          if (isForwardResult(next.result)) {
            setResultOrigin("computed");
            setResult(next.result);
            setResultProject(jobProject.current);
            setPolarization(next.result.spectra.s ? "s" : "p");
            setError("");
            setNotice("Calculation complete. Results are ready.");
          } else
            setError(
              "The calculation returned an unsupported result. Your previous result is preserved.",
            );
          return;
        }
        if (next.status === "failed") {
          activeJob.current = null;
          setError(next.error || "Calculation failed.");
          return;
        }
        if (next.status === "cancelled") {
          activeJob.current = null;
          setNotice("Calculation cancelled.");
          return;
        }
        timer = window.setTimeout(poll, 700);
      } catch (e) {
        if (stopped || activeJob.current !== id) return;
        if (e instanceof ApiError && e.status === 404) {
          activeJob.current = null;
          setJob((previous) =>
            previous ? { ...previous, status: "failed" } : previous,
          );
          setError(
            "This job no longer exists, possibly because the API restarted. Please run again.",
          );
          return;
        }
        setConnection("offline");
        setError(
          `Connection interrupted. Retrying job status… ${errorText(e)}`,
        );
        timer = window.setTimeout(poll, 3000);
      }
    }
    timer = window.setTimeout(poll, 300);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [job?.id, job?.status]);

  function update(next: Project) {
    inputsChanged.current = true;
    setProject(next);
    setNotice("");
  }
  function updateLayer(values: Partial<typeof layer>) {
    update({ ...project, layers: [{ ...layer, ...values }] });
  }
  function updateWavelengths(start: number, end: number, count: number) {
    update({
      ...project,
      illumination: {
        ...project.illumination,
        wavelengths_nm: linspace(start, end, count),
      },
    });
  }
  async function run() {
    if (staticPreview || busy || errors.length) return;
    setStarting(true);
    setError("");
    setNotice("");
    jobStart.current = Date.now();
    setElapsed(0);
    jobProject.current = structuredClone(project);
    try {
      const next = await api.start(project);
      setConnection("online");
      activeJob.current = next.id;
      setJob(next);
    } catch (e) {
      setError(errorText(e));
      setConnection(e instanceof ApiError ? "online" : "offline");
    } finally {
      setStarting(false);
    }
  }
  async function cancel() {
    if (!job) return;
    const id = job.id;
    try {
      const next = await api.cancel(id);
      if (activeJob.current !== id) return;
      setJob(next);
      if (next.status === "succeeded" && isForwardResult(next.result)) {
        activeJob.current = null;
        setResultOrigin("computed");
        setResult(next.result);
        setResultProject(jobProject.current);
        setPolarization(next.result.spectra.s ? "s" : "p");
        setNotice("The calculation completed before cancellation.");
        setError("");
      } else if (next.status === "cancelled") {
        activeJob.current = null;
        setNotice("Calculation cancelled.");
        setError("");
      } else if (next.status === "failed") {
        activeJob.current = null;
        setError(next.error || "Calculation failed.");
      }
    } catch (e) {
      setError(`Could not confirm cancellation: ${errorText(e)}`);
    }
  }
  async function save() {
    if (errors.length) return;
    setSaving(true);
    setError("");
    try {
      await api.save(project, stale ? null : result);
      setNotice("Project saved to the local server.");
      setConnection("online");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  async function openSaved() {
    setShowSaved(true);
    setError("");
    try {
      setSaved(await api.list());
      setConnection("online");
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function load(id: string) {
    try {
      const data = await api.load(id);
      const parsed = parseProjectFile(JSON.stringify(data));
      update(parsed.project);
      setResultOrigin("imported");
      setResult(parsed.result || null);
      setResultProject(parsed.result ? parsed.project : null);
      setPolarization(parsed.result?.spectra.s ? "s" : "p");
      setShowSaved(false);
      setNotice("Project loaded.");
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function importProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024)
        throw new Error("Project JSON must be smaller than 20 MB.");
      const data = parseProjectFile(await file.text());
      update(data.project);
      setResultOrigin("imported");
      setResult(data.result || null);
      setResultProject(
        data.result ? data.result_project || data.project : null,
      );
      setPolarization(data.result?.spectra.s ? "s" : "p");
      setNotice("JSON loaded. Review the inputs and saved results.");
      setError("");
      setJob(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      event.target.value = "";
    }
  }
  async function readReference() {
    const response = await fetch(
      new URL("./reference-example.json", document.baseURI),
    );
    if (!response.ok)
      throw new Error("The bundled reference could not be loaded.");
    return parseProjectFile(await response.text());
  }
  async function loadReference() {
    try {
      const data = await readReference();
      update(data.project);
      setResult(data.result || null);
      setResultProject(data.project);
      setResultOrigin("reference");
      setPolarization("s");
      setNotice("Stored reference results loaded. No new calculation was run.");
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function reconnect() {
    try {
      await api.example();
      setConnection("online");
      setNotice("Solver connected. Your current inputs have been preserved.");
      setError("");
    } catch (e) {
      setError(errorText(e));
      setConnection("offline");
    }
  }
  async function resetExample() {
    if (staticPreview) {
      await loadReference();
      return;
    }
    try {
      const example = await api.example();
      update(example);
      setConnection("online");
      setNotice("Example inputs loaded.");
      setError("");
    } catch (e) {
      setError(errorText(e));
      setConnection("offline");
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#main" aria-label="RCWA home">
          RCWA
        </a>
        <div className="header-right">
          <details
            className="project-menu"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.currentTarget.open = false;
                event.currentTarget
                  .querySelector<HTMLElement>("summary")
                  ?.focus();
              }
            }}
          >
            <summary>
              Project <span aria-hidden="true">⌄</span>
            </summary>
            <div
              className="file-actions"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, a")) {
                  const menu = event.currentTarget.closest("details");
                  if (menu) menu.open = false;
                }
              }}
            >
              <button
                disabled={busy || staticPreview}
                onClick={openSaved}
                title={
                  staticPreview
                    ? "Requires the local Python API"
                    : "Open from local server"
                }
              >
                <Icon name="folder" />
                <span>Open</span>
              </button>
              <button
                disabled={busy}
                onClick={() => inputFile.current?.click()}
              >
                <Icon name="upload" />
                <span>Import JSON</span>
              </button>
              <button
                disabled={!!errors.length}
                onClick={() => downloadProject(project, result, resultProject)}
              >
                <Icon name="download" />
                <span>Export</span>
              </button>
              <button
                className="icon-button"
                aria-label="Save project to local server"
                title="Save to local server"
                disabled={staticPreview || busy || saving || !!errors.length}
                onClick={save}
              >
                <Icon name="save" /> Save to local server
              </button>
              <a
                href="https://github.com/phykn/rcwa#quickstart"
                target="_blank"
                rel="noreferrer"
              >
                Local solver setup ↗
              </a>
              <input
                type="file"
                ref={inputFile}
                accept="application/json,.json"
                hidden
                onChange={importProject}
              />
            </div>
          </details>

          <span className={`connection ${connection}`} title={apiDescription}>
            <i />
            {staticPreview
              ? "Static preview"
              : connection === "online"
                ? "Solver connected"
                : connection === "checking"
                  ? "Connecting…"
                  : "Solver offline"}
          </span>
        </div>
      </header>
      <nav className="task-nav" aria-label="Workbench sections">
        <a href="#build">Build</a>
        <a href="#spectrum">Spectrum</a>
        <a href="#fit">Fit demo</a>
      </nav>
      <main id="main">
        {connection === "offline" && (
          <div className="connection-banner">
            <span>
              <b>{staticPreview ? "" : "The calculation server is offline."}</b>
              {staticPreview
                ? "Edits change the drawing only. New calculations run locally."
                : "You can edit inputs and import or export JSON. Calculations require the Python API."}
            </span>
            <button
              disabled={busy}
              onClick={staticPreview ? loadReference : reconnect}
            >
              {staticPreview ? "Reset example" : "Reconnect"}
            </button>
          </div>
        )}
        <div className="workspace">
          <aside className="controls panel" id="build">
            <div className="control-heading">
              <div>
                <label htmlFor="project-name" className="project-label">
                  Build a grating
                </label>
                <input
                  id="project-name"
                  aria-label="Project name"
                  value={project.name}
                  maxLength={100}
                  disabled={busy}
                  onChange={(e) => update({ ...project, name: e.target.value })}
                />
              </div>
            </div>
            <section
              className="geometry-panel"
              aria-label="Grating cross section"
            >
              <p className="builder-hint">
                A repeating ridge pattern. Select a dimension to edit.
              </p>
              <Geometry
                project={project}
                selectedDimension={selectedDimension}
                onSelectDimension={selectDimension}
              />
              <div className="geometry-footer">
                <span>
                  <i className="ridge-dot" />
                  {layer.material.name} <small>ridge</small>
                </span>
                <span>
                  <i className="groove-dot" />
                  {layer.background.name} <small>groove</small>
                </span>
                <span className="periodic-tag">
                  Cross section · not to scale
                </span>
              </div>
            </section>
            <fieldset disabled={busy}>
              <div className="geometry-inputs">
                <Field
                  label="Pitch"
                  id="dimension-pitch"
                  selected={selectedDimension === "pitch"}
                  onFocus={() => setSelectedDimension("pitch")}
                  unit="nm"
                  value={project.period_nm}
                  min={20}
                  max={5000}
                  onChange={(period_nm) => update({ ...project, period_nm })}
                />
                <Field
                  label="Width (CD)"
                  id="dimension-width"
                  selected={selectedDimension === "width"}
                  onFocus={() => setSelectedDimension("width")}
                  unit="nm"
                  value={layer.cd_nm}
                  min={0}
                  max={project.period_nm}
                  onChange={(cd_nm) => updateLayer({ cd_nm })}
                />
                <Field
                  label="Height"
                  id="dimension-height"
                  selected={selectedDimension === "height"}
                  onFocus={() => setSelectedDimension("height")}
                  unit="nm"
                  value={layer.thickness_nm}
                  min={0}
                  max={2000}
                  onChange={(thickness_nm) => updateLayer({ thickness_nm })}
                />
              </div>
              <div className="setting-summaries">
                <button
                  type="button"
                  onClick={() => showSettings("Materials")}
                  aria-label="Edit materials"
                >
                  <strong>Materials</strong>
                  <span>
                    {layer.material.name} / {project.substrate.name}
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
                <button
                  type="button"
                  onClick={() => showSettings("Light")}
                  aria-label="Edit light"
                >
                  <strong>Light</strong>
                  <span>
                    {waves[0]}–{waves.at(-1)} nm ·{" "}
                    {project.illumination.angle_deg}° ·{" "}
                    {project.illumination.polarization === "both"
                      ? "s & p, separate"
                      : project.illumination.polarization}
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              </div>
              <details className="more-settings">
                <summary>
                  More settings{" "}
                  <span className="chevron" aria-hidden="true">
                    ⌄
                  </span>
                </summary>
                <Section title="Light" open={false}>
                  <div className="field-grid">
                    <Field
                      label="λ start"
                      unit="nm"
                      value={waves[0]}
                      min={200}
                      max={2500}
                      onChange={(v) =>
                        updateWavelengths(v, waves.at(-1)!, waves.length)
                      }
                    />
                    <Field
                      label="λ end"
                      unit="nm"
                      value={waves.at(-1)!}
                      min={200}
                      max={2500}
                      onChange={(v) =>
                        updateWavelengths(waves[0], v, waves.length)
                      }
                    />
                  </div>
                  <div className="field-grid">
                    <Field
                      label="Wavelength samples"
                      value={waves.length}
                      min={2}
                      max={81}
                      onChange={(v) =>
                        updateWavelengths(waves[0], waves.at(-1)!, v)
                      }
                    />
                    <Field
                      label="Incidence angle · θ"
                      unit="°"
                      value={project.illumination.angle_deg}
                      min={0}
                      max={75}
                      step={1}
                      onChange={(angle_deg) =>
                        update({
                          ...project,
                          illumination: { ...project.illumination, angle_deg },
                        })
                      }
                    />
                  </div>
                  <label className="field">
                    <span>Polarization</span>
                    <select
                      value={project.illumination.polarization}
                      onChange={(e) =>
                        update({
                          ...project,
                          illumination: {
                            ...project.illumination,
                            polarization: e.target
                              .value as Project["illumination"]["polarization"],
                          },
                        })
                      }
                    >
                      <option value="both">Separate s and p curves</option>
                      <option value="s">s / TE · E ∥ grooves</option>
                      <option value="p">p / TM · H ∥ grooves</option>
                    </select>
                  </label>
                  <p className="control-note">
                    Polarization describes the electric-field direction: s is
                    along the grooves; p lies in the cross section. θ is
                    measured from the surface normal. The incidence plane is
                    x–z; grooves run along y.
                  </p>
                </Section>
                <Section title="Materials" open={false}>
                  <p className="control-note">
                    n controls refraction; k controls absorption (0 = no
                    absorption). Defaults describe synthetic materials, not
                    measured optical constants.
                  </p>
                  <MaterialEditor
                    label="Ridge"
                    material={layer.material}
                    onChange={(material) => updateLayer({ material })}
                  />
                  <MaterialEditor
                    label="Groove"
                    material={layer.background}
                    onChange={(background) => updateLayer({ background })}
                  />
                  <MaterialEditor
                    label="Ambient"
                    material={project.ambient}
                    lossless
                    onChange={(ambient) => update({ ...project, ambient })}
                  />
                  <MaterialEditor
                    label="Substrate"
                    material={project.substrate}
                    onChange={(substrate) => update({ ...project, substrate })}
                  />
                  <p className="control-note">
                    Tables use linear interpolation without extrapolation. The
                    incident ambient must have k = 0.
                  </p>
                </Section>
                <Section title="Solver" open={false}>
                  <Field
                    label="Harmonic order N"
                    value={project.solver.harmonics}
                    min={1}
                    max={20}
                    onChange={(harmonics) =>
                      update({ ...project, solver: { harmonics } })
                    }
                    help={`Retained orders: −${project.solver.harmonics} … +${project.solver.harmonics} (${2 * project.solver.harmonics + 1} total)`}
                  />
                  <p className="control-note">
                    Increase N and compare results to assess convergence. A
                    higher order alone does not guarantee accuracy.
                  </p>
                </Section>
              </details>
            </fieldset>
            <div className="run-area">
              {errors.length > 0 && (
                <ul className="validation-list" role="alert">
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
              {staticPreview ? (
                <button
                  className="export-inputs"
                  disabled={!!errors.length}
                  onClick={() =>
                    downloadProject(project, result, resultProject)
                  }
                >
                  Export inputs
                </button>
              ) : (
                <button
                  className="run-button"
                  onClick={run}
                  disabled={staticPreview || busy || !!errors.length}
                >
                  {busy ? <span className="spinner" /> : <Icon name="play" />}
                  {fitBusy
                    ? "Fit in progress"
                    : forwardBusy
                      ? "Calculating…"
                      : "Run simulation"}
                  <span>{forwardBusy ? `${elapsed}s` : "↵"}</span>
                </button>
              )}
              {forwardBusy ? (
                <div className="job-progress">
                  <span>
                    <i />
                    {starting
                      ? "Submitting"
                      : job?.status === "queued"
                        ? "Queued"
                        : "RCWA solver running"}
                  </span>
                  <button
                    className="text-button"
                    disabled={!job || starting}
                    onClick={cancel}
                  >
                    Cancel
                  </button>
                </div>
              ) : !staticPreview ? (
                <div>
                  <button
                    className="example-button"
                    disabled={busy}
                    onClick={resetExample}
                  >
                    Reset inputs
                  </button>
                  <button
                    className="example-button"
                    disabled={busy}
                    onClick={loadReference}
                  >
                    Load reference result
                  </button>
                </div>
              ) : null}
            </div>
          </aside>
          <div className="results-column">
            {error && (
              <div className="message error" role="alert">
                <span>
                  <b>Check required</b>
                  {error}
                </span>
                <button aria-label="Dismiss error" onClick={() => setError("")}>
                  ×
                </button>
              </div>
            )}
            {notice && (
              <div className="message success" role="status">
                <Icon name="check" />
                {notice}
                <button
                  aria-label="Dismiss notification"
                  onClick={() => setNotice("")}
                >
                  ×
                </button>
              </div>
            )}
            <section className="panel spectrum-panel" id="spectrum">
              <div className="panel-heading">
                <div>
                  <h2>Spectrum</h2>
                </div>
                <span
                  className={`result-badge ${stale ? "stale" : result ? "ready" : ""}`}
                >
                  {stale
                    ? "Inputs changed"
                    : result
                      ? resultOrigin === "reference"
                        ? "Precomputed example"
                        : resultOrigin === "imported"
                          ? "Imported result"
                          : "Computed"
                      : "No result yet"}
                </span>
              </div>
              {stale && (
                <div className="stale-note">
                  {staticPreview
                    ? "Inputs changed. This is still the reference spectrum; export your inputs to calculate locally."
                    : "Inputs changed. Run again to update this spectrum."}
                </div>
              )}
              {resultOrigin === "reference" && result && (
                <div className="reference-note">
                  Stored meent calculation:
                  {resultProject && (
                    <span>
                      {" "}
                      Λ {resultProject.period_nm} nm · CD{" "}
                      {resultProject.layers[0].cd_nm} nm · h{" "}
                      {resultProject.layers[0].thickness_nm} nm · θ{" "}
                      {resultProject.illumination.angle_deg}°.
                    </span>
                  )}
                </div>
              )}
              <SpectrumPlot
                result={result}
                polarization={polarization}
                onPolarization={setPolarization}
              />
            </section>
            <SyntheticFit
              project={project}
              staticPreview={staticPreview}
              locked={forwardBusy}
              onBusyChange={setFitBusy}
              onApply={(cd_nm) => updateLayer({ cd_nm })}
            />
            <details className="notes-panel">
              <summary>
                Results details & model assumptions{" "}
                <span className="chevron" aria-hidden="true">
                  ⌄
                </span>
              </summary>
              {selectedSpectrum && (
                <div className="metrics-row">
                  <div className="metric panel">
                    <span>Mean reflectance</span>
                    <strong>
                      {(100 * mean(selectedSpectrum.R)).toFixed(2)}
                      <small>%</small>
                    </strong>
                    <p>Sum over retained reflected orders</p>
                  </div>
                  <div className="metric panel">
                    <span>Mean transmittance</span>
                    <strong>
                      {(100 * mean(selectedSpectrum.T)).toFixed(2)}
                      <small>%</small>
                    </strong>
                    <p>Sum over retained transmitted orders</p>
                  </div>
                  <div className="metric panel">
                    <span>Mean 1 − R − T</span>
                    <strong>
                      {mean(selectedSpectrum.A_balance).toExponential(2)}
                    </strong>
                    <p>Energy balance, not a convergence proof</p>
                  </div>
                </div>
              )}
              <div className="spectrum-note">
                <b>Total ≠ specular.</b> R and T sum power contributions over
                all retained diffraction orders. R₀ and T₀ contain only the
                zeroth order.
              </div>
              <div className="notes-grid">
                <p>
                  <b>Plane-wave baseline</b>An infinite periodic grating with
                  one layer and semi-infinite ambient/substrate. Finite beam,
                  numerical aperture, and finite-target effects are omitted.
                </p>
                <p>
                  <b>Power normalization</b>R/T are normalized to incident
                  power. For an absorbing substrate, T is entrance-plane power
                  flux, not backside transmission. Higher retained orders may
                  carry flux. 1−R−T is an energy balance.
                </p>
                <p>
                  <b>Numerical confidence</b>Check wavelength sampling and
                  Fourier order separately. Energy conservation alone does not
                  establish spectral convergence or experimental accuracy.
                </p>
              </div>
              {result && result.warnings.length > 0 && (
                <div className="numerical-warnings">
                  <b>Solver warnings</b>
                  <ul>
                    {result.warnings.map((w, i) => (
                      <li key={i}>{String(w)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result?.metadata && (
                <details className="metadata">
                  <summary>Calculation metadata</summary>
                  <pre>{JSON.stringify(result.metadata, null, 2)}</pre>
                </details>
              )}
            </details>
          </div>
        </div>
      </main>
      {showSaved && (
        <div
          className="dialog-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowSaved(false);
          }}
        >
          <section
            className="dialog panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="saved-title"
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowSaved(false);
            }}
          >
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Local storage</span>
                <h2 id="saved-title">Saved projects</h2>
              </div>
              <button
                className="icon-button"
                autoFocus
                onClick={() => setShowSaved(false)}
                aria-label="Close saved projects"
              >
                ×
              </button>
            </div>
            <p className="control-note">
              Projects saved on the Python server. Use Import JSON to open a
              local JSON file.
            </p>
            {saved.length ? (
              saved.map((item) => (
                <button
                  className="saved-item"
                  key={item.id}
                  onClick={() => load(item.id)}
                >
                  <span>
                    <b>{item.name}</b>
                    <small>
                      {new Date(
                        item.updated_at || item.created_at,
                      ).toLocaleString()}
                    </small>
                  </span>
                  <Icon name="arrow" />
                </button>
              ))
            ) : (
              <p className="saved-empty">No saved projects yet.</p>
            )}
            <button
              className="dialog-close"
              onClick={() => setShowSaved(false)}
            >
              Close
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
