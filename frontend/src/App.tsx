import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { api, apiDescription, ApiError } from "./api";
import {
  defaultProject,
  downloadProject,
  isForwardResult,
  linspace,
  parseProjectFile,
  validateProject,
  editStack,
  maximumPatternedCD,
  stackSummary,
  supportsSyntheticFit,
  validLayerIndex,
} from "./model";
import type {
  ForwardResult,
  Job,
  Material,
  Project,
  SavedProject,
  SavedSummary,
  RectangleLayer,
  StackOperation,
} from "./model";
import { SpectrumPlot } from "./Visuals";
import { ThreeStructure } from "./ThreeStructure";
import { LayerActions, LayerStack } from "./LayerStack";
type Dimension = "width" | "height" | "pitch";
type Sheet =
  | Dimension
  | "ridge"
  | "groove"
  | "ambient"
  | "substrate"
  | "materials"
  | "light"
  | "accuracy"
  | "layer";
import { SyntheticFit } from "./SyntheticFit";
import { ComparisonPanel, ReviewPanel } from "./WorkflowPanels";
import {
  createHistory,
  workspaceReducer,
  createRunRecord,
  semanticEqual,
  normalizeProject,
  parseChangeProposal,
  resultCompatibilityError,
} from "./workflow";
import type { Workspace, RunRecord } from "./workflow";
const validIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const validInputHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
class ForwardContractError extends Error {}
function sameInputs(a: Project | null, b: Project) {
  return a !== null && semanticEqual(normalizeProject(a), normalizeProject(b));
}
type ReviewState = {
  title: string;
  baseProject: Project;
  workspace: Workspace;
  revision: number;
  actionVersion: number;
  note: string;
  blockedReason: string;
  warnings: string[];
};

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
  onEditStart,
  onEditEnd,
  multilayer = false,
}: {
  dimension: Dimension;
  multilayer?: boolean;
  value: number;
  max: number;
  min: number;
  onChange: (value: number) => void;
  onEditStart: () => void;
  onEditEnd: () => void;
}) {
  const activePointer = useRef<number | null>(null);
  const end = useRef(onEditEnd);
  end.current = onEditEnd;
  useEffect(() => {
    function finish(event: globalThis.PointerEvent) {
      if (event.pointerId === activePointer.current) {
        activePointer.current = null;
        end.current();
      }
    }
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (activePointer.current !== null) end.current();
    };
  }, []);
  const help = {
    width: "The width of each ridge, also called critical dimension (CD).",
    height:
      "The selected layer’s thickness. Zero thickness removes its optical slab.",
    pitch:
      "The shared period of every layer. Pitch cannot be smaller than any patterned layer’s width.",
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
              ? multilayer
                ? "Thickness"
                : "Height"
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
        onPointerDown={(event) => {
          onEditEnd();
          onEditStart();
          activePointer.current = event.pointerId;
        }}
        onKeyDown={() => onEditStart()}
        onKeyUp={() => onEditEnd()}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="range-labels">
        <span>{min} nm</span>
        <span>{max} nm</span>
      </div>
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
  const inspector = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const actionVersion = useRef(0);
  const savedRequest = useRef(0);
  const startingRef = useRef(false);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [loadingProject, setLoadingProject] = useState<string | null>(null);
  function openSheet(next: Sheet, layerIndex?: number) {
    if (layerIndex !== undefined) selectLayer(layerIndex);
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
  const [history, setHistory] = useState(() =>
    createHistory({
      project: structuredClone(defaultProject),
      displayedRun: null,
      selectedLayer: 0,
    }),
  );
  const historyRef = useRef(history);
  historyRef.current = history;
  function dispatch(action: Parameters<typeof workspaceReducer>[1]) {
    const next = workspaceReducer(historyRef.current, action);
    historyRef.current = next;
    setHistory(next);
  }
  const { project, displayedRun } = history.present;
  const result = displayedRun?.result || null;
  const resultOrigin = displayedRun?.origin || "computed";
  const resultProject = displayedRun?.inputProject || null;
  const [review, setReview] = useState<ReviewState | null>(null);
  const reviewRef = useRef<ReviewState | null>(null);
  function presentReview(next: ReviewState | null) {
    reviewRef.current = next;
    setReview(next);
  }
  const [comparison, setComparison] = useState<SavedProject[] | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const savingRef = useRef(false);
  const jobContext = useRef<{
    project: Project;
    hash: string;
    version: number;
    revision: number;
  } | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [fitBusy, setFitBusy] = useState(false);
  const [connection, setConnection] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [polarization, setPolarization] = useState<"s" | "p">("s");
  const [saved, setSaved] = useState<SavedSummary[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const inputFile = useRef<HTMLInputElement>(null);
  const inputsChanged = useRef(false);
  const activeJob = useRef<string | null>(null);
  const jobStart = useRef(0);
  const forwardBusy =
    starting || job?.status === "queued" || job?.status === "running";
  const busy = forwardBusy || fitBusy;
  const errors = validateProject(project);
  const stale = result !== null && !sameInputs(resultProject, project);
  const selectedLayer = validLayerIndex(project, history.present.selectedLayer);
  const layer = project.layers[selectedLayer];
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
          dispatch({
            type: "reset",
            workspace: workspaceFromFile(data, "reference"),
          });
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
        if (!inputsChanged.current)
          dispatch({
            type: "reset",
            workspace: { project: example, displayedRun: null },
          });
      })
      .catch(async () => {
        if (alive) {
          setConnection("offline");
          if (!inputsChanged.current) {
            try {
              const data = await readReference();
              if (alive && !inputsChanged.current) {
                dispatch({
                  type: "reset",
                  workspace: workspaceFromFile(data, "reference"),
                });
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
      ).filter(
        (e) => !e.hasAttribute("disabled") && e.getClientRects().length > 0,
      );
      const first = elements[0],
        last = elements.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const missing = !elements.includes(document.activeElement as HTMLElement);
      if (event.shiftKey && (document.activeElement === first || missing)) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && (document.activeElement === last || missing)) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      if (previous?.isConnected && previous.getClientRects().length)
        previous.focus();
      else
        document.querySelector<HTMLElement>(".project-menu > summary")?.focus();
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
        if (!acceptForward(next, id)) return;
        setConnection("online");
        setJob(next);
        if (next.status === "succeeded") {
          activeJob.current = null;
          setError("");
          setNotice("Calculation complete. Results are ready.");
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
        if (e instanceof ForwardContractError) {
          activeJob.current = null;
          setJob((previous) =>
            previous ? { ...previous, status: "failed" } : previous,
          );
          setError(e.message);
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

  function beginEdit() {
    dispatch({ type: "begin-edit" });
  }
  function endEdit() {
    dispatch({ type: "end-edit" });
  }
  function update(next: Project, selection?: number) {
    if (semanticEqual(next, historyRef.current.present.project)) return;
    actionVersion.current += 1;
    inputsChanged.current = true;
    dispatch({
      type: "replace-project",
      project: next,
      selectedLayer: selection,
    });
    setNotice("");
  }
  function install(workspace: Workspace) {
    actionVersion.current += 1;
    inputsChanged.current = true;
    endEdit();
    dispatch({
      type: "replace-workspace",
      workspace: {
        ...workspace,
        selectedLayer: validLayerIndex(
          workspace.project,
          workspace.selectedLayer,
        ),
      },
    });
    setPolarization(workspace.displayedRun?.result.spectra.s ? "s" : "p");
    setJob(null);
  }
  function restoreHistory(direction: "undo" | "redo") {
    if (busy || startingRef.current) return;
    actionVersion.current += 1;
    inputsChanged.current = true;
    endEdit();
    dispatch({ type: direction });
    const restored = historyRef.current.present.displayedRun;
    setPolarization(restored?.result.spectra.s ? "s" : "p");
    setJob(null);
    setNotice(direction === "undo" ? "Edit undone." : "Edit redone.");
    setError("");
  }
  function workspaceFromFile(
    data: {
      project: Project;
      result?: ForwardResult | null;
      result_project?: Project | null;
    },
    origin: RunRecord["origin"],
  ): Workspace {
    return {
      project: data.project,
      displayedRun: data.result
        ? createRunRecord({
            inputProject: data.result_project || data.project,
            result: data.result,
            origin,
          })
        : null,
    };
  }
  function workspaceFromSnapshot(
    data: SavedProject,
    expectedId: string,
  ): Workspace {
    if (!validIdentifier(expectedId) || data.id !== expectedId)
      throw new Error("The server returned a different saved project.");
    if ("result_project" in data)
      throw new Error(
        "A server snapshot cannot supply alternate result inputs.",
      );
    const parsed = parseProjectFile(
      JSON.stringify({ project: data.project, result: data.result }),
    );
    const trusted = data.provenance?.source === "server_computed";
    if (
      trusted &&
      (!data.result ||
        data.result.result_type !== "forward" ||
        !validIdentifier(data.provenance?.job_id) ||
        !validInputHash(data.provenance?.input_hash))
    )
      throw new Error("The saved run is missing its server identity.");
    const workspace = workspaceFromFile(
      parsed,
      trusted ? "server" : "imported",
    );
    if (workspace.displayedRun)
      workspace.displayedRun = createRunRecord({
        ...workspace.displayedRun,
        snapshotId: data.id,
        ...(trusted
          ? {
              sourceJobId: data.provenance!.job_id!,
              inputHash: data.provenance!.input_hash!,
            }
          : {}),
      });
    return workspace;
  }
  function acceptForward(next: Job, id?: string) {
    const context = jobContext.current;
    if (
      !context ||
      context.version !== actionVersion.current ||
      context.revision !== historyRef.current.revision
    )
      return false;
    if (
      !next ||
      typeof next !== "object" ||
      next.kind !== "forward" ||
      (id && next.id !== id) ||
      !validIdentifier(next.id) ||
      next.input_hash !== context.hash ||
      !["running", "succeeded", "failed", "cancelled"].includes(next.status)
    )
      throw new ForwardContractError(
        "The server returned a different or invalid forward job. Your previous result is preserved. Check the server before starting another job.",
      );
    if (next.status === "succeeded") {
      const mismatch = resultCompatibilityError(context.project, next.result);
      if (
        mismatch ||
        !isForwardResult(next.result) ||
        next.result.result_type !== "forward"
      )
        throw new ForwardContractError(
          mismatch || "The forward result is invalid.",
        );
      dispatch({
        type: "set-displayed-run",
        run: createRunRecord({
          inputProject: context.project,
          result: next.result,
          origin: "computed",
          sourceJobId: next.id,
          inputHash: context.hash,
        }),
      });
      setPolarization(next.result.spectra.s ? "s" : "p");
    }
    return true;
  }
  function selectLayer(index: number) {
    endEdit();
    dispatch({ type: "select-layer", index });
    // Material/dimension sheets are reopened for an explicit selection.
    if (sheet === "width" || sheet === "groove") setSheet(null);
  }
  function changeStack(operation: StackOperation) {
    if (busy || startingRef.current) return;
    endEdit();
    const changed = editStack(project, selectedLayer, operation);
    update(changed.project, changed.selectedLayer);
    if (sheet === "width" || sheet === "groove") setSheet(null);
  }
  function updateLayer(values: Partial<RectangleLayer>) {
    if (
      layer.geometry === "homogeneous" &&
      ("cd_nm" in values || "background" in values)
    )
      return;
    update({
      ...project,
      layers: project.layers.map((item, index) =>
        index === selectedLayer
          ? ({ ...item, ...values } as typeof item)
          : item,
      ),
    });
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
    endEdit();
    const version = ++actionVersion.current;
    const revision = historyRef.current.revision;
    const submitted = structuredClone(historyRef.current.present.project);
    inputsChanged.current = true;
    setStarting(true);
    setError("");
    setNotice("");
    setElapsed(0);
    jobStart.current = Date.now();
    try {
      const validation = await api.validate(submitted);
      if (
        version !== actionVersion.current ||
        revision !== historyRef.current.revision
      )
        return;
      if (
        validation.valid !== true ||
        validateProject(validation.project).length ||
        !validInputHash(validation.input_hash) ||
        !sameInputs(validation.project, submitted)
      )
        throw new Error(
          validation.diagnostics?.map((item) => item.message).join(" ") ||
            "The server could not validate these exact inputs.",
        );
      jobContext.current = {
        project: validation.project,
        hash: validation.input_hash,
        version,
        revision,
      };
      const next = await api.start(validation.project);
      if (!acceptForward(next)) return;
      setConnection("online");
      activeJob.current = next.status === "running" ? next.id : null;
      setJob(next);
      if (next.status === "succeeded")
        setNotice("Calculation complete. Results are ready.");
      else if (next.status === "failed")
        setError(next.error || "Calculation failed.");
    } catch (e) {
      if (version === actionVersion.current) {
        setError(errorText(e));
        setConnection(e instanceof ApiError ? "online" : "offline");
      }
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
      if (activeJob.current !== id || !acceptForward(next, id)) return;
      setJob(next);
      if (next.status === "succeeded") {
        activeJob.current = null;
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
      if (activeJob.current === id)
        setError(`Could not confirm cancellation: ${errorText(e)}`);
    }
  }
  async function save() {
    if (staticPreview || busy || savingRef.current || errors.length) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    endEdit();
    const version = actionVersion.current,
      revision = historyRef.current.revision;
    const frame = historyRef.current.present,
      run = frame.displayedRun;
    const currentResult = run && sameInputs(run.inputProject, frame.project);
    try {
      if (currentResult && run.origin === "server" && run.snapshotId) {
        setNotice("This server snapshot is already saved.");
        return;
      }
      if (currentResult && run.origin === "computed") {
        if (!run.sourceJobId || !run.inputHash)
          throw new Error(
            "This run has no server job identity. Export JSON to keep a local copy.",
          );
        const data = await api.snapshot(run.sourceJobId);
        const savedWorkspace = workspaceFromSnapshot(data, data.id);
        if (
          data.provenance?.source !== "server_computed" ||
          data.provenance.job_id !== run.sourceJobId ||
          data.provenance.input_hash !== run.inputHash ||
          !semanticEqual(data.project, run.inputProject) ||
          !semanticEqual(data.result, run.result)
        )
          throw new Error("The saved snapshot does not match this exact run.");
        if (
          version !== actionVersion.current ||
          revision !== historyRef.current.revision
        )
          return;
        dispatch({
          type: "set-displayed-run",
          run: savedWorkspace.displayedRun,
        });
        setNotice("Project saved as an exact server-computed run.");
      } else {
        const saved = await api.save(
          frame.project,
          currentResult ? run.result : null,
        );
        workspaceFromSnapshot(saved, saved.id);
        if (
          saved.provenance?.source !== "unverified_import" ||
          !semanticEqual(saved.project, normalizeProject(frame.project)) ||
          !semanticEqual(saved.result, currentResult ? run.result : null)
        )
          throw new Error(
            "The saved project does not match the inputs sent to the server.",
          );
        if (
          version !== actionVersion.current ||
          revision !== historyRef.current.revision
        )
          return;
        setNotice(
          currentResult
            ? "Project saved with an unverified imported result."
            : "Project saved with inputs only. No current result was included.",
        );
      }
      setConnection("online");
    } catch (e) {
      if (
        version === actionVersion.current &&
        revision === historyRef.current.revision
      )
        setError(
          e instanceof ApiError && e.status === 404
            ? "This job expired before it could be saved. Export JSON to keep a local copy, or run again for a server snapshot."
            : errorText(e),
        );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  function closeSaved() {
    savedRequest.current += 1;
    setShowSaved(false);
    setLoadingProject(null);
    setComparing(false);
  }
  async function openSaved() {
    const request = ++savedRequest.current;
    setShowSaved(true);
    setLoadingSaved(true);
    setSaved([]);
    setSelectedCandidates([]);
    setError("");
    try {
      const list = await api.list();
      if (request !== savedRequest.current) return;
      if (
        !Array.isArray(list) ||
        list.some(
          (item) =>
            !item || !validIdentifier(item.id) || typeof item.name !== "string",
        )
      )
        throw new Error("The saved-project list is invalid.");
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
    const version = actionVersion.current,
      revision = historyRef.current.revision;
    setLoadingProject(id);
    try {
      const data = await api.load(id);
      if (
        request !== savedRequest.current ||
        version !== actionVersion.current ||
        revision !== historyRef.current.revision
      )
        return;
      install(workspaceFromSnapshot(data, id));
      closeSaved();
      setNotice("Project loaded.");
      setError("");
    } catch (e) {
      if (
        request === savedRequest.current &&
        version === actionVersion.current &&
        revision === historyRef.current.revision
      )
        setError(errorText(e));
    } finally {
      if (request === savedRequest.current) setLoadingProject(null);
    }
  }
  async function importProject(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || busy || startingRef.current) return;
    endEdit();
    const version = ++actionVersion.current,
      revision = historyRef.current.revision;
    inputsChanged.current = true;
    try {
      if (file.size > 20 * 1024 * 1024)
        throw new Error("Project JSON must be smaller than 20 MB.");
      const text = await file.text();
      if (
        version !== actionVersion.current ||
        revision !== historyRef.current.revision
      )
        return;
      const envelope: unknown = JSON.parse(text);
      if (
        envelope &&
        typeof envelope === "object" &&
        "schema_version" in envelope &&
        String(envelope.schema_version).startsWith("rcwa-change-proposal/")
      ) {
        const proposal = parseChangeProposal(text);
        const mismatch = !sameInputs(
          proposal.base_project,
          historyRef.current.present.project,
        );
        presentReview({
          title:
            proposal.schema_version === "rcwa-change-proposal/1.1"
              ? "Review stack changes"
              : "Review geometry changes",
          baseProject: historyRef.current.present.project,
          workspace: {
            project: proposal.candidate_project,
            displayedRun: historyRef.current.present.displayedRun,
          },
          revision,
          actionVersion: version,
          note: "Review this external proposal before applying it. Applying changes does not run the solver.",
          warnings: proposal.diagnostics
            .filter((item) => item.severity !== "error")
            .map((item) => item.message),
          blockedReason: mismatch
            ? "This proposal was made for different inputs. Export the current project and request a new proposal."
            : !proposal.valid
              ? proposal.diagnostics
                  .filter((item) => item.severity === "error")
                  .map((item) => item.message)
                  .join(" ")
              : !proposal.diff.length
                ? "This proposal contains no changes."
                : "",
        });
        setError("");
        return;
      }
      const data = parseProjectFile(text);
      install(workspaceFromFile(data, "imported"));
      setNotice("JSON loaded. Review the inputs and saved results.");
      setError("");
    } catch (e) {
      if (version === actionVersion.current) setError(errorText(e));
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
    endEdit();
    const version = ++actionVersion.current,
      revision = historyRef.current.revision;
    inputsChanged.current = true;
    try {
      const data = await readReference();
      if (
        version !== actionVersion.current ||
        revision !== historyRef.current.revision
      )
        return;
      install(workspaceFromFile(data, "reference"));
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
    endEdit();
    const version = ++actionVersion.current,
      revision = historyRef.current.revision;
    inputsChanged.current = true;
    try {
      const example = await api.example();
      if (
        version !== actionVersion.current ||
        revision !== historyRef.current.revision
      )
        return;
      if (validateProject(example).length)
        throw new Error("The server returned an unsupported example.");
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

  async function compareSelected() {
    if (
      staticPreview ||
      comparing ||
      selectedCandidates.length < 2 ||
      selectedCandidates.length > 3
    )
      return;
    const ids = [...selectedCandidates],
      request = ++savedRequest.current,
      version = actionVersion.current,
      revision = historyRef.current.revision;
    setComparing(true);
    setError("");
    try {
      const candidates = await Promise.all(
        ids.map(async (id) => {
          const data = await api.load(id);
          const workspace = workspaceFromSnapshot(data, id);
          if (!workspace.displayedRun)
            throw new Error(
              `${data.name} has no saved spectrum. Run and save it before comparison.`,
            );
          return data;
        }),
      );
      if (
        request !== savedRequest.current ||
        version !== actionVersion.current ||
        revision !== historyRef.current.revision
      )
        return;
      closeSaved();
      setComparison(candidates);
    } catch (e) {
      if (
        request === savedRequest.current &&
        version === actionVersion.current &&
        revision === historyRef.current.revision
      )
        setError(errorText(e));
    } finally {
      if (request === savedRequest.current || !showSaved) setComparing(false);
    }
  }
  function reviewCandidate(candidate: SavedProject) {
    endEdit();
    setComparison(null);
    presentReview({
      title: "Review saved candidate",
      baseProject: historyRef.current.present.project,
      workspace: workspaceFromSnapshot(candidate, candidate.id),
      revision: historyRef.current.revision,
      actionVersion: actionVersion.current,
      note: "Apply this candidate with its exact saved spectrum. You can undo this change without running the solver.",
      blockedReason: "",
      warnings: candidate.result?.warnings || [],
    });
  }
  function applyReview() {
    const pending = reviewRef.current;
    if (
      !pending ||
      pending !== review ||
      busy ||
      startingRef.current ||
      pending.blockedReason
    )
      return;
    if (
      pending.revision !== historyRef.current.revision ||
      pending.actionVersion !== actionVersion.current ||
      !sameInputs(pending.baseProject, historyRef.current.present.project)
    ) {
      presentReview({
        ...pending,
        blockedReason:
          "The project changed while this preview was open. Close it and review a new proposal.",
      });
      return;
    }
    // Consume this review before any state update can schedule another click.
    // A repeated Apply or a queued action after Cancel is therefore a no-op.
    presentReview(null);
    install(pending.workspace);
    setError("");
    setNotice("Changes applied. Undo is available in the Project menu.");
  }
  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        busy ||
        review ||
        comparison ||
        showSaved ||
        target?.closest("input, textarea, select, [contenteditable=true]")
      )
        return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        restoreHistory(event.shiftKey ? "redo" : "undo");
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        restoreHistory("redo");
      }
    }
    document.addEventListener("keydown", shortcuts);
    return () => document.removeEventListener("keydown", shortcuts);
  });
  function changeDimension(dimension: Dimension, value: number) {
    if (busy) return;
    if (dimension === "pitch") {
      if (value < maximumPatternedCD(project)) {
        setError("Pitch cannot be smaller than any patterned layer’s CD.");
        return;
      }
      update({ ...project, period_nm: value });
    } else
      updateLayer(
        dimension === "width" ? { cd_nm: value } : { thickness_nm: value },
      );
  }
  const dimensionValues = {
    width: layer.geometry === "rectangle_1d" ? layer.cd_nm : 0,
    height: layer.thickness_nm,
    pitch: project.period_nm,
  };
  const titles: Record<Sheet, string> = {
    width:
      project.layers.length > 1
        ? `Layer ${selectedLayer + 1} · ${layer.name} · Width`
        : "Ridge width",
    height:
      project.layers.length > 1
        ? `Layer ${selectedLayer + 1} · ${layer.name} · Thickness`
        : "Layer thickness",
    pitch: "Pattern pitch",
    ridge:
      project.layers.length > 1
        ? `Layer ${selectedLayer + 1} · ${layer.name} · Material`
        : layer.geometry === "homogeneous"
          ? "Layer material"
          : "Ridge material",
    groove:
      project.layers.length > 1
        ? `Layer ${selectedLayer + 1} · ${layer.name} · Groove`
        : "Groove material",
    ambient: "Ambient material",
    substrate: "Substrate material",
    materials:
      project.layers.length > 1
        ? `Layer ${selectedLayer + 1} · ${layer.name} · Materials`
        : "Optical materials",
    light: "Incident light",
    accuracy: "Calculation settings",
    layer: `Layer ${selectedLayer + 1} · ${layer.name}`,
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
              <div className="history-menu-actions" aria-label="Edit history">
                <button
                  disabled={
                    busy || (!history.past.length && !history.editTransaction)
                  }
                  onClick={() => restoreHistory("undo")}
                >
                  ↶ Undo
                </button>
                <button
                  disabled={busy || !history.future.length}
                  onClick={() => restoreHistory("redo")}
                >
                  ↷ Redo
                </button>
              </div>
              <small className="history-scope">
                Edit history lasts for this browser session.
              </small>
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
              <button
                aria-label="Reset example"
                disabled={busy}
                onClick={staticPreview ? loadReference : resetExample}
              >
                <span aria-hidden="true">↶</span> Reset example
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
            <h1>
              <input
                aria-label="Project name"
                id="project-name"
                value={project.name}
                maxLength={100}
                disabled={busy}
                onFocus={beginEdit}
                onBlur={endEdit}
                onChange={(e) => update({ ...project, name: e.target.value })}
              />
            </h1>
          </div>
        </div>
        <div className="workspace">
          <section
            className="design"
            id="build"
            aria-label="Interactive grating editor"
          >
            <ThreeStructure
              project={project}
              selectedLayer={selectedLayer}
              onSelectLayer={selectLayer}
              disabled={busy}
              onChange={changeDimension}
              onOpen={openSheet}
              onEditStart={beginEdit}
              onEditEnd={endEdit}
            />
            <LayerStack
              project={project}
              selected={selectedLayer}
              disabled={busy}
              onSelect={selectLayer}
              onEdit={() => openSheet("layer")}
              onChange={changeStack}
            />
            <fieldset disabled={busy} className="setup-rows">
              <button
                className="setting-row"
                onClick={() => openSheet("light")}
                aria-label="Edit light"
              >
                <span className="setting-icon">☼</span>
                <span className="setting-name">Light</span>
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
                onClick={() => openSheet("accuracy")}
                aria-label="Edit calculation settings"
              >
                <span className="setting-icon">≋</span>
                <span className="setting-name">Calculation</span>
                <span className="setting-value">
                  N = {project.solver.harmonics}
                </span>
                <Icon name="arrow" />
              </button>
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
                    onClick={loadReference}
                  >
                    Load reference result
                  </button>
                </div>
              ) : null}
            </div>

            {connection === "offline" && !staticPreview && (
              <div className="connection-banner">
                <span>
                  Solver offline. Editing and JSON export are available.
                </span>
                <button onClick={reconnect} disabled={busy}>
                  Reconnect
                </button>
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
                <h2>Spectrum</h2>
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
              {stale && (
                <div className="stale-note">
                  {staticPreview
                    ? "This stored spectrum no longer matches your inputs."
                    : "Run again to update this spectrum."}
                </div>
              )}
              {resultOrigin === "reference" && result && !stale && (
                <div className="reference-note">
                  {staticPreview
                    ? "Edits don't recalculate this spectrum. "
                    : "Stored meent example. No new calculation was run."}
                  {staticPreview && (
                    <a
                      href="https://github.com/phykn/rcwa#quickstart"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Run locally ↗
                    </a>
                  )}
                </div>
              )}
              {staticPreview &&
                (stale || resultOrigin !== "reference" || !result) && (
                  <p className="preview-note">
                    Live calculation requires the{" "}
                    <a
                      href="https://github.com/phykn/rcwa#quickstart"
                      target="_blank"
                      rel="noreferrer"
                    >
                      local solver ↗
                    </a>
                    .
                  </p>
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
                endEdit();
                actionVersion.current += 1;
                inputsChanged.current = true;
              }
              setFitBusy(next);
            }}
            onApply={(cd_nm) => {
              if (!supportsSyntheticFit(project)) return;
              const only = project.layers[0];
              if (only.geometry !== "rectangle_1d") return;
              endEdit();
              update({ ...project, layers: [{ ...only, cd_nm }] });
            }}
          />
          <details className="notes-panel">
            <summary>
              Result details
              {result && result.warnings.length > 0 && (
                <span className="warning-count">
                  {result.warnings.length} solver{" "}
                  {result.warnings.length === 1 ? "warning" : "warnings"}
                </span>
              )}
              <span className="chevron" aria-hidden="true">
                ⌄
              </span>
            </summary>
            {result && (
              <p className="control-note">
                {resultOrigin === "reference"
                  ? "Source: precomputed meent example."
                  : resultOrigin === "imported"
                    ? "Source: unverified JSON import. Origin claims in the file are not trusted."
                    : resultOrigin === "server"
                      ? "Source: computed and saved by the local server."
                      : "Source: computed by the local solver."}
              </p>
            )}
            {resultProject && (
              <p className="result-inputs">
                Original inputs: pitch {resultProject.period_nm} nm ·{" "}
                {supportsSyntheticFit(resultProject) &&
                resultProject.layers[0].geometry === "rectangle_1d"
                  ? `width ${resultProject.layers[0].cd_nm} nm · height ${resultProject.layers[0].thickness_nm} nm`
                  : stackSummary(resultProject)}{" "}
                · {resultProject.illumination.angle_deg}° · N ={" "}
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
                <b>Plane-wave baseline</b>An infinite periodic 1D stack with
                semi-infinite ambient/substrate. Finite beam, numerical
                aperture, and finite-target effects are omitted.
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
        <div
          className="sheet-body"
          onFocusCapture={(event) => {
            if (
              (event.target as HTMLElement).matches(
                "input:not([type=file]), textarea",
              )
            )
              beginEdit();
          }}
          onBlurCapture={(event) => {
            if (
              (event.target as HTMLElement).matches(
                "input:not([type=file]), textarea",
              )
            )
              endEdit();
          }}
        >
          <div className="sheet-grabber" />
          <div className="sheet-heading">
            <div>
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
            {sheet === "layer" && (
              <>
                <label className="field">
                  <span>Layer name</span>
                  <input
                    aria-label="Layer name"
                    value={layer.name}
                    maxLength={100}
                    onChange={(event) =>
                      updateLayer({ name: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>Layer type</span>
                  <select
                    aria-label="Layer type"
                    value={layer.geometry}
                    onChange={(event) =>
                      changeStack({
                        type: "geometry",
                        geometry: event.target.value as
                          "rectangle_1d" | "homogeneous",
                      })
                    }
                  >
                    <option value="rectangle_1d">Patterned</option>
                    <option value="homogeneous">Uniform</option>
                  </select>
                </label>
                <Field
                  label="Thickness"
                  unit="nm"
                  value={layer.thickness_nm}
                  min={0}
                  max={2000}
                  step={0.1}
                  onChange={(thickness_nm) => updateLayer({ thickness_nm })}
                />
                {layer.geometry === "rectangle_1d" && (
                  <Field
                    label="Width (CD)"
                    unit="nm"
                    value={layer.cd_nm}
                    min={0}
                    max={project.period_nm}
                    step={0.1}
                    onChange={(cd_nm) => updateLayer({ cd_nm })}
                  />
                )}
                <button
                  className="text-button"
                  onClick={() => setSheet("materials")}
                >
                  Edit materials
                </button>
                <LayerActions
                  selected={selectedLayer}
                  count={project.layers.length}
                  disabled={busy}
                  onChange={changeStack}
                />
              </>
            )}

            {sheet && ["width", "height", "pitch"].includes(sheet) && (
              <DimensionEditor
                dimension={sheet as Dimension}
                multilayer={
                  project.layers.length > 1 || layer.geometry === "homogeneous"
                }
                value={dimensionValues[sheet as Dimension]}
                min={
                  sheet === "pitch"
                    ? Math.max(20, maximumPatternedCD(project))
                    : 0
                }
                max={
                  sheet === "pitch"
                    ? 5000
                    : sheet === "height"
                      ? 2000
                      : project.period_nm
                }
                onChange={(value) => changeDimension(sheet as Dimension, value)}
                onEditStart={beginEdit}
                onEditEnd={endEdit}
              />
            )}
            {sheet &&
              ["ridge", "groove", "ambient", "substrate", "materials"].includes(
                sheet,
              ) && (
                <>
                  <p className="sheet-help">
                    n: refractive index · k: extinction coefficient
                  </p>
                  <div
                    className="material-tabs"
                    role="group"
                    aria-label="Choose material"
                  >
                    {(["ridge", "groove", "ambient", "substrate"] as const)
                      .filter(
                        (key) =>
                          key !== "groove" || layer.geometry === "rectangle_1d",
                      )
                      .map((key) => (
                        <button
                          key={key}
                          aria-pressed={sheet === key}
                          onClick={() => setSheet(key)}
                        >
                          {key === "ridge" && layer.geometry === "homogeneous"
                            ? "Layer"
                            : key[0].toUpperCase() + key.slice(1)}
                        </button>
                      ))}
                  </div>
                  {(sheet === "ridge" || sheet === "materials") && (
                    <MaterialEditor
                      label={
                        layer.geometry === "homogeneous" ? "Layer" : "Ridge"
                      }
                      material={layer.material}
                      onChange={(material) => updateLayer({ material })}
                    />
                  )}
                  {layer.geometry === "rectangle_1d" &&
                    (sheet === "groove" || sheet === "materials") && (
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
                  Incidence angle is measured from the surface normal.
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
                  <strong>1D finite-layer stack</strong>
                </div>
                <div className="fixed-setting">
                  <span>Layers</span>
                  <strong>{project.layers.length} · top to bottom</strong>
                </div>
                <p className="sheet-hint">
                  Infinite 1D model; finite-target effects are omitted.
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
      {review && (
        <ReviewPanel
          title={review.title}
          baseProject={review.baseProject}
          candidateProject={review.workspace.project}
          note={review.note}
          warnings={review.warnings}
          blockedReason={
            review.blockedReason ||
            (review.revision !== history.revision ||
            review.actionVersion !== actionVersion.current
              ? "The project changed. Close this preview and request a new proposal."
              : "")
          }
          onApply={applyReview}
          onClose={() => {
            if (reviewRef.current === review) presentReview(null);
          }}
        />
      )}
      {comparison && (
        <ComparisonPanel
          candidates={comparison}
          onUse={reviewCandidate}
          onClose={() => setComparison(null)}
        />
      )}
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
                <div className="saved-choice" key={item.id}>
                  <input
                    type="checkbox"
                    aria-label={`Compare ${item.name}`}
                    checked={selectedCandidates.includes(item.id)}
                    disabled={
                      loadingProject !== null ||
                      comparing ||
                      (selectedCandidates.length >= 3 &&
                        !selectedCandidates.includes(item.id))
                    }
                    onChange={(event) => {
                      savedRequest.current += 1;
                      setSelectedCandidates((previous) =>
                        event.target.checked
                          ? [...previous, item.id]
                          : previous.filter((id) => id !== item.id),
                      );
                    }}
                  />
                  <button
                    className="saved-item"
                    disabled={loadingProject !== null || comparing}
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
                </div>
              ))
            ) : (
              <p className="saved-empty">No saved projects yet.</p>
            )}
            <div className="workflow-actions">
              <button className="text-button" onClick={closeSaved}>
                Close
              </button>
              <button
                className="dialog-close"
                disabled={
                  selectedCandidates.length < 2 ||
                  comparing ||
                  loadingProject !== null
                }
                onClick={compareSelected}
              >
                {comparing
                  ? "Loading comparison…"
                  : `Compare${selectedCandidates.length ? ` (${selectedCandidates.length})` : ""}`}
              </button>
            </div>
            <p className="history-scope">
              Select two or three saved spectra to compare.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
