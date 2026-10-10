import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
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
import { SpectrumPlot } from "./Visuals";
import { ThreeStructure } from "./ThreeStructure";
type Dimension = "width" | "height" | "pitch";
type Sheet =
  | Dimension
  | "ridge"
  | "groove"
  | "ambient"
  | "substrate"
  | "materials"
  | "light"
  | "accuracy";
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
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const number = Number(text);
  const invalid =
    text === "" ||
    !Number.isFinite(number) ||
    (min !== undefined && number < min) ||
    (max !== undefined && number > max) ||
    (step === 1 && !Number.isInteger(number));
  return (
    <label className="field">
      <span>
        {label}
        {unit && <small>{unit}</small>}
      </span>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        aria-invalid={invalid}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const v = Number(next);
          if (
            next !== "" &&
            Number.isFinite(v) &&
            (min === undefined || v >= min) &&
            (max === undefined || v <= max) &&
            (step !== 1 || Number.isInteger(v))
          )
            onChange(v);
        }}
      />
      {invalid ? (
        <small className="input-error">
          Use {min ?? "a number"}–{max ?? "∞"}
          {step === 1 ? " in whole steps" : ""}. Last valid value is kept.
        </small>
      ) : (
        help && <small className="field-help">{help}</small>
      )}
    </label>
  );
}
function DimensionEditor({
  dimension,
  value,
  max,
  min,
  onChange,
}: {
  dimension: Dimension;
  value: number;
  max: number;
  min: number;
  onChange: (value: number) => void;
}) {
  const help = {
    width: "The width of each ridge, also called critical dimension (CD).",
    height:
      "The ridge height above the substrate. Zero height removes the patterned layer.",
    pitch:
      "The distance from one ridge to the next. Pitch cannot be smaller than the current width.",
  };
  return (
    <>
      <p className="sheet-help">{help[dimension]}</p>
      <Field
        key={dimension}
        label={
          dimension === "width"
            ? "Width (CD)"
            : dimension === "height"
              ? "Height"
              : "Pitch"
        }
        id={`dimension-${dimension}`}
        value={value}
        min={min}
        max={max}
        step={0.1}
        unit="nm"
        onChange={onChange}
      />
      <input
        aria-label={`${dimension} range`}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="range-labels">
        <span>{min} nm</span>
        <span>{max} nm</span>
      </div>
      <p className="sheet-hint">
        Changes appear immediately. Tap outside or close to return.
      </p>
      <p className="keyboard-note">
        On the 3D handles, arrow keys edit by 1 nm. Hold Shift for 10 nm.
      </p>
    </>
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
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [sceneFallback, setSceneFallback] = useState(false);
  const inspector = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const actionVersion = useRef(0);
  const savedRequest = useRef(0);
  const startingRef = useRef(false);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [loadingProject, setLoadingProject] = useState<string | null>(null);
  function openSheet(next: Sheet) {
    previousFocus.current = document.activeElement as HTMLElement;
    setSheet(next);
  }
  useEffect(() => {
    if (sheet) {
      inspector.current?.showModal();
      inspector.current
        ?.querySelector<HTMLInputElement>("input:not([type=file])")
        ?.focus();
    } else if (inspector.current?.open) {
      inspector.current.close();
      previousFocus.current?.focus();
    }
  }, [sheet]);
  const [project, setProject] = useState<Project>(
    structuredClone(defaultProject),
  );
  const [result, setResult] = useState<ForwardResult | null>(null);
  const [resultOrigin, setResultOrigin] = useState<
    "computed" | "server" | "imported" | "reference"
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
          if (!alive) return;
          setConnection("offline");
          if (inputsChanged.current) return;
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
        closeSaved();
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
          setConnection("online");
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
    actionVersion.current += 1;
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
        wavelengths_nm: count === 1 ? [start] : linspace(start, end, count),
      },
    });
  }
  async function run() {
    if (staticPreview || busy || startingRef.current || errors.length) return;
    startingRef.current = true;
    actionVersion.current += 1;
    inputsChanged.current = true;
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
      startingRef.current = false;
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
  function closeSaved() {
    savedRequest.current += 1;
    setShowSaved(false);
    setLoadingProject(null);
  }
  async function openSaved() {
    const request = ++savedRequest.current;
    setShowSaved(true);
    setLoadingSaved(true);
    setSaved([]);
    setError("");
    try {
      const list = await api.list();
      if (request !== savedRequest.current) return;
      setSaved(list);
      setConnection("online");
    } catch (e) {
      if (request === savedRequest.current) setError(errorText(e));
    } finally {
      if (request === savedRequest.current) setLoadingSaved(false);
    }
  }
  async function load(id: string) {
    const request = ++savedRequest.current;
    const version = actionVersion.current;
    setLoadingProject(id);
    try {
      const data = await api.load(id);
      if (request !== savedRequest.current || version !== actionVersion.current)
        return;
      const parsed = parseProjectFile(JSON.stringify(data));
      update(parsed.project);
      // Only an API envelope can establish server-owned provenance.
      setResultOrigin(
        data.provenance?.source === "server_computed" ? "server" : "imported",
      );
      setResult(parsed.result || null);
      setResultProject(parsed.result ? parsed.project : null);
      setPolarization(parsed.result?.spectra.s ? "s" : "p");
      closeSaved();
      setNotice("Project loaded.");
      setError("");
    } catch (e) {
      if (request === savedRequest.current && version === actionVersion.current)
        setError(errorText(e));
    } finally {
      if (request === savedRequest.current) setLoadingProject(null);
    }
  }
  async function importProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const version = ++actionVersion.current;
    inputsChanged.current = true;
    try {
      if (file.size > 20 * 1024 * 1024)
        throw new Error("Project JSON must be smaller than 20 MB.");
      const data = parseProjectFile(await file.text());
      if (version !== actionVersion.current) return;
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
      if (version !== actionVersion.current) return;
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
    const version = ++actionVersion.current;
    inputsChanged.current = true;
    try {
      const data = await readReference();
      if (version !== actionVersion.current) return;
      update(data.project);
      setResult(data.result || null);
      setResultProject(data.project);
      setResultOrigin("reference");
      setPolarization("s");
      setNotice("Stored reference results loaded. No new calculation was run.");
      setError("");
    } catch (e) {
      if (version !== actionVersion.current) return;
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
    const version = ++actionVersion.current;
    inputsChanged.current = true;
    try {
      const example = await api.example();
      if (version !== actionVersion.current) return;
      update(example);
      setConnection("online");
      setNotice("Example inputs loaded.");
      setError("");
    } catch (e) {
      if (version !== actionVersion.current) return;
      setError(errorText(e));
      setConnection("offline");
    }
  }

  function changeDimension(dimension: Dimension, value: number) {
    if (busy) return;
    if (dimension === "pitch") update({ ...project, period_nm: value });
    else
      updateLayer(
        dimension === "width" ? { cd_nm: value } : { thickness_nm: value },
      );
  }
  const dimensionValues = {
    width: layer.cd_nm,
    height: layer.thickness_nm,
    pitch: project.period_nm,
  };
  const titles: Record<Sheet, string> = {
    width: "Ridge width",
    height: "Ridge height",
    pitch: "Pattern pitch",
    ridge: "Ridge material",
    groove: "Groove material",
    ambient: "Ambient material",
    substrate: "Substrate material",
    materials: "Optical materials",
    light: "Incident light",
    accuracy: "Calculation settings",
  };
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#main" aria-label="RCWA home">
          <svg
            width="25"
            height="25"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.65"
            aria-hidden="true"
          >
            <path d="M4 17V7h4v10h4V7h4v10h4" />
          </svg>
          RCWA<span className="brand-caption">Optical design</span>
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
          </details>{" "}
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
      <main id="main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR STRUCTURE</p>
            <h1>
              <input
                aria-label="Project name"
                id="project-name"
                value={project.name}
                maxLength={100}
                disabled={busy}
                onChange={(e) => update({ ...project, name: e.target.value })}
              />
            </h1>
            <p className="subtitle">Shape the structure. Explore the light.</p>
          </div>
          <div className="scope">
            <span>1D</span>Single layer
          </div>
        </div>
        <div className="workspace">
          <section
            className="design"
            id="build"
            aria-label="Interactive grating editor"
          >
            <div className="canvas-head">
              <span>Shape your structure</span>
              <span className="canvas-scale">1D grating</span>
            </div>
            <ThreeStructure
              project={project}
              disabled={busy}
              onChange={changeDimension}
              onOpen={openSheet}
              onFallbackChange={setSceneFallback}
            />
            <div className="gesture-note">
              <span>
                {sceneFallback
                  ? "Tap a value to edit."
                  : "Drag the dots. Tap values or materials."}
              </span>
              <button
                className="reset"
                aria-label="Reset example"
                disabled={busy}
                onClick={staticPreview ? loadReference : resetExample}
              >
                ↶
              </button>
            </div>
            <fieldset disabled={busy} className="setup-rows">
              <button
                className="setting-row"
                onClick={() => openSheet("light")}
                aria-label="Edit light"
              >
                <span className="setting-icon">☼</span>
                <span className="setting-name">Incident light</span>
                <span className="setting-value">
                  {waves.length === 1
                    ? waves[0]
                    : `${waves[0]}–${waves.at(-1)}`}{" "}
                  nm
                  <span>
                    {project.illumination.angle_deg}° ·{" "}
                    {project.illumination.polarization === "both"
                      ? "s & p"
                      : project.illumination.polarization}
                  </span>
                </span>
                <Icon name="arrow" />
              </button>
              <button
                className="setting-row"
                onClick={() => openSheet("materials")}
                aria-label="Edit materials"
              >
                <span className="setting-icon">◈</span>
                <span className="setting-name">Materials</span>
                <span className="setting-value">
                  Ridge · groove<span>Ambient · substrate</span>
                </span>
                <Icon name="arrow" />
              </button>
              <button
                className="setting-row"
                onClick={() => openSheet("accuracy")}
                aria-label="Edit calculation settings"
              >
                <span className="setting-icon">≋</span>
                <span className="setting-name">Calculation</span>
                <span className="setting-value">
                  Order N = {project.solver.harmonics}
                  <span>
                    {2 * project.solver.harmonics + 1} retained orders
                  </span>
                </span>
                <Icon name="arrow" />
              </button>
            </fieldset>
            <p className="model-footnote">
              One rectangular 1D layer. Default optical constants are synthetic.
            </p>
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

            {connection === "offline" && (
              <div className="connection-banner">
                <span>
                  {staticPreview
                    ? "This preview edits inputs locally. New calculations require the local Python solver."
                    : "The local solver is offline. You can still edit, import and export inputs."}
                </span>
                {!staticPreview && (
                  <button onClick={reconnect} disabled={busy}>
                    Reconnect
                  </button>
                )}
                <a
                  href="https://github.com/phykn/rcwa#quickstart"
                  target="_blank"
                  rel="noreferrer"
                >
                  Local setup ↗
                </a>
              </div>
            )}
          </section>
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
            <section
              className={`result panel spectrum-panel ${stale ? "stale" : ""}`}
              id="spectrum"
            >
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">
                    {resultOrigin === "reference"
                      ? "REFERENCE RESULT"
                      : "YOUR RESULT"}
                  </span>
                </div>
                <span
                  className={`result-badge ${stale ? "stale" : result ? "ready" : ""}`}
                  title={
                    result && resultOrigin === "server"
                      ? "This result was computed and saved by the local server. Origin does not certify numerical convergence or scientific accuracy."
                      : result && resultOrigin === "imported"
                        ? "Unverified imported result. Origin claims in JSON files are not trusted."
                        : undefined
                  }
                >
                  {stale
                    ? "Inputs changed"
                    : result
                      ? resultOrigin === "reference"
                        ? "Precomputed example"
                        : resultOrigin === "imported"
                          ? "Unverified import"
                          : resultOrigin === "server"
                            ? "Server-computed"
                            : "Computed"
                      : "No result yet"}
                </span>
              </div>
              <h2>
                Light, reflected
                <br className="desktop-break" /> and transmitted.
              </h2>
              <p className="result-intro">
                {result
                  ? "Inspect the spectrum and its original inputs."
                  : "Calculate how your structure interacts with light."}
              </p>
              {stale && (
                <div className="stale-note">
                  {staticPreview
                    ? "Inputs changed. This stored spectrum has not recalculated; export your inputs to calculate locally."
                    : "Inputs changed. Run again to update this spectrum."}
                </div>
              )}
              {resultOrigin === "reference" && result && !stale && (
                <div className="reference-note">
                  Precomputed with meent.{" "}
                  {staticPreview
                    ? "Editing does not recalculate this spectrum. "
                    : "No new calculation was run. "}
                </div>
              )}
              <SpectrumPlot
                result={result}
                polarization={polarization}
                onPolarization={setPolarization}
                staticPreview={staticPreview}
              />
            </section>
          </div>
        </div>
        <div className="supplemental">
          {" "}
          <SyntheticFit
            project={project}
            staticPreview={staticPreview}
            locked={forwardBusy}
            onBusyChange={(next) => {
              if (next) {
                actionVersion.current += 1;
                inputsChanged.current = true;
              }
              setFitBusy(next);
            }}
            onApply={(cd_nm) => updateLayer({ cd_nm })}
          />
          <details className="notes-panel">
            <summary>
              Results details & model assumptions{" "}
              <span className="chevron" aria-hidden="true">
                ⌄
              </span>
            </summary>
            <p className="control-note">
              The 3D view shows three finite repeats of an infinite 1D pattern.
              Width, height and pitch share one scale. Substrate depth and
              groove length are schematic; colors identify regions, not optical
              constants.
            </p>
            {result && resultOrigin === "reference" && (
              <p className="control-note">
                This result is the bundled precomputed meent example, not a new
                calculation.
              </p>
            )}
            {resultProject && (
              <p className="result-inputs">
                Original inputs: pitch {resultProject.period_nm} nm · width{" "}
                {resultProject.layers[0].cd_nm} nm · height{" "}
                {resultProject.layers[0].thickness_nm} nm ·{" "}
                {resultProject.illumination.angle_deg}° · N ={" "}
                {resultProject.solver.harmonics}.{" "}
                {resultProject.illumination.wavelengths_nm.length} wavelength
                samples,{" "}
                {resultProject.illumination.polarization === "both"
                  ? "s and p"
                  : resultProject.illumination.polarization}{" "}
                polarization.
              </p>
            )}
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
              <b>Total ≠ specular.</b> R and T sum power contributions over all
              retained diffraction orders. R₀ and T₀ contain only the zeroth
              order.
            </div>
            <div className="notes-grid">
              <p>
                <b>Plane-wave baseline</b>An infinite periodic grating with one
                layer and semi-infinite ambient/substrate. Finite beam,
                numerical aperture, and finite-target effects are omitted.
              </p>
              <p>
                <b>Power normalization</b>R/T are normalized to incident power.
                For an absorbing substrate, T is entrance-plane power flux, not
                backside transmission. Higher retained orders may carry flux.
                1−R−T is an energy balance.
              </p>
              <p>
                <b>Numerical confidence</b>Check wavelength sampling and Fourier
                order separately. Energy conservation alone does not establish
                spectral convergence or experimental accuracy.
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
        <footer className="page-footer">
          <span>RCWA</span>
          <p>
            {staticPreview
              ? "Stored example · calculate with the local solver"
              : "Local optical design workbench"}
          </p>
        </footer>
      </main>
      <dialog
        ref={inspector}
        className="inspector"
        aria-labelledby="inspector-title"
        onCancel={(e) => {
          e.preventDefault();
          setSheet(null);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSheet(null);
        }}
      >
        <div className="sheet-body">
          <div className="sheet-grabber" />
          <div className="sheet-heading">
            <div>
              <p className="eyebrow">EDIT STRUCTURE</p>
              <h2 id="inspector-title">{sheet ? titles[sheet] : "Settings"}</h2>
            </div>
            <button
              className="icon-button"
              aria-label="Close settings"
              onClick={() => setSheet(null)}
            >
              ×
            </button>
          </div>
          <fieldset disabled={busy}>
            {sheet && ["width", "height", "pitch"].includes(sheet) && (
              <DimensionEditor
                dimension={sheet as Dimension}
                value={dimensionValues[sheet as Dimension]}
                min={sheet === "pitch" ? Math.max(20, layer.cd_nm) : 0}
                max={
                  sheet === "pitch"
                    ? 5000
                    : sheet === "height"
                      ? 2000
                      : project.period_nm
                }
                onChange={(value) => changeDimension(sheet as Dimension, value)}
              />
            )}
            {sheet &&
              ["ridge", "groove", "ambient", "substrate", "materials"].includes(
                sheet,
              ) && (
                <>
                  <p className="sheet-help">
                    n controls refraction; k controls absorption. Constant
                    values and imported tables both drive the same solver.
                  </p>
                  <div
                    className="material-tabs"
                    role="group"
                    aria-label="Choose material"
                  >
                    {(["ridge", "groove", "ambient", "substrate"] as const).map(
                      (key) => (
                        <button
                          key={key}
                          aria-pressed={sheet === key}
                          onClick={() => setSheet(key)}
                        >
                          {key[0].toUpperCase() + key.slice(1)}
                        </button>
                      ),
                    )}
                  </div>
                  {(sheet === "ridge" || sheet === "materials") && (
                    <MaterialEditor
                      label="Ridge"
                      material={layer.material}
                      onChange={(material) => updateLayer({ material })}
                    />
                  )}
                  {(sheet === "groove" || sheet === "materials") && (
                    <MaterialEditor
                      label="Groove"
                      material={layer.background}
                      onChange={(background) => updateLayer({ background })}
                    />
                  )}
                  {(sheet === "ambient" || sheet === "materials") && (
                    <MaterialEditor
                      label="Ambient"
                      material={project.ambient}
                      lossless
                      onChange={(ambient) => update({ ...project, ambient })}
                    />
                  )}
                  {(sheet === "substrate" || sheet === "materials") && (
                    <MaterialEditor
                      label="Substrate"
                      material={project.substrate}
                      onChange={(substrate) =>
                        update({ ...project, substrate })
                      }
                    />
                  )}
                  <p className="sheet-hint">
                    Tables use linear interpolation without extrapolation. The
                    ambient must have k = 0. Default constants are synthetic,
                    not measured data.
                  </p>
                </>
              )}
            {sheet === "light" && (
              <>
                <p className="sheet-help">
                  Light arrives from the ambient toward the grating. The angle
                  is measured from the surface normal.
                </p>
                <div className="field-grid">
                  <Field
                    label={waves.length === 1 ? "Wavelength" : "λ start"}
                    step={0.1}
                    unit="nm"
                    value={waves[0]}
                    min={200}
                    max={2500}
                    onChange={(v) =>
                      updateWavelengths(v, waves.at(-1)!, waves.length)
                    }
                  />
                  {waves.length > 1 && (
                    <Field
                      label="λ end"
                      step={0.1}
                      unit="nm"
                      value={waves.at(-1)!}
                      min={200}
                      max={2500}
                      onChange={(v) =>
                        updateWavelengths(waves[0], v, waves.length)
                      }
                    />
                  )}
                  <Field
                    label="Wavelength samples"
                    value={waves.length}
                    min={1}
                    max={81}
                    onChange={(v) =>
                      v === 1
                        ? update({
                            ...project,
                            illumination: {
                              ...project.illumination,
                              wavelengths_nm: [waves[0]],
                            },
                          })
                        : updateWavelengths(waves[0], waves.at(-1)!, v)
                    }
                  />
                  <Field
                    label="Incidence angle · θ"
                    unit="°"
                    value={project.illumination.angle_deg}
                    min={0}
                    max={75}
                    step={0.1}
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
                <p className="sheet-hint">
                  The incidence plane is x–z; grooves run along y. Use Import
                  JSON for an exact, nonuniform wavelength list.
                </p>
              </>
            )}
            {sheet === "accuracy" && (
              <>
                <p className="sheet-help">
                  Increase Fourier order N and compare results to assess
                  convergence. A higher order alone does not guarantee accuracy.
                </p>
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
                <div className="fixed-setting">
                  <span>Geometry</span>
                  <strong>1D rectangular grating</strong>
                </div>
                <div className="fixed-setting">
                  <span>Layers</span>
                  <strong>One</strong>
                </div>
                <p className="sheet-hint">
                  The 3D view illustrates a 1D model. It does not add a finite
                  target, multiple layers or 2D periodicity.
                </p>
              </>
            )}
          </fieldset>
          {errors.length > 0 && (
            <ul className="validation-list" role="alert">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      </dialog>
      {showSaved && (
        <div
          className="dialog-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeSaved();
          }}
        >
          <section
            className="dialog panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="saved-title"
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSaved();
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
                onClick={closeSaved}
                aria-label="Close saved projects"
              >
                ×
              </button>
            </div>
            <p className="control-note">
              Projects saved on the Python server. Use Import JSON to open a
              local JSON file.
            </p>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            {loadingSaved ? (
              <p className="saved-empty" role="status">
                Loading saved projects…
              </p>
            ) : saved.length ? (
              saved.map((item) => (
                <button
                  className="saved-item"
                  key={item.id}
                  disabled={loadingProject !== null}
                  onClick={() => load(item.id)}
                >
                  <span>
                    <b>
                      {item.name}
                      {loadingProject === item.id ? " · Loading…" : ""}
                    </b>
                    <small>
                      {new Date(
                        item.updated_at || item.created_at,
                      ).toLocaleString()}
                      {" · "}
                      {item.provenance?.source === "server_computed"
                        ? "Server-computed"
                        : "Unverified import"}
                    </small>
                  </span>
                  <Icon name="arrow" />
                </button>
              ))
            ) : (
              <p className="saved-empty">No saved projects yet.</p>
            )}
            <button className="dialog-close" onClick={closeSaved}>
              Close
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
