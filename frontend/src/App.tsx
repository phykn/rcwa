import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { LocalDesignHandoff } from "./LocalDesignHandoff";
import { reviewImportedDesign } from "./importReview";
import {
  browserDraftStorage,
  inputDraftKey,
  readInputDraft,
  writeInputDraft,
  INPUT_DRAFT_DELAY_MS,
} from "./inputDraft";
import type { DraftRead, DraftWrite } from "./inputDraft";
import {
  api,
  apiDescription,
  ApiError,
  ApiContractError,
  solverSupportError,
} from "./api";
import { hashProject2D, normalizeProject2D } from "./project2d";
import rectangular2DInput from "./fixtures/default-project-2d.json";
import circular2DInput from "./fixtures/default-project-circular.json";
import rectangular2DManifest from "./fixtures/reference-2d-manifest.json";
import circular2DManifest from "./fixtures/reference-circular-manifest.json";
import { ThreeStructure2D, DimensionCards2D } from "./ThreeStructure2D";
import { DimensionEditor2D, dimensionFields2D } from "./DimensionEditor2D";
import {
  defaultProject,
  downloadProject,
  isForwardResult,
  linspace,
  parseProjectFileAsync,
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
  Layer,
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
  createRunRecordAsync,
  projectInputsEqual,
  sameNormalizedProject,
  exactSemanticEqual,
  semanticEqual,
  parseChangeProposal,
} from "./workflow";
import type { Workspace, RunRecord } from "./workflow";
const validIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const validInputHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
class ForwardContractError extends Error {}
function sameInputs(a: Project | null, b: Project) {
  return a !== null && sameNormalizedProject(a, b);
}
type ReviewState = {
  // Input-only imports are reviewed against this exact editor frame, including
  // selection and the displayed result. They are not base-bound AI proposals.
  importedBase?: Workspace;
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
  maxExclusive = false,
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
  maxExclusive?: boolean;
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
    (max !== undefined && (maxExclusive ? number >= max : number > max)) ||
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
            (max === undefined || (maxExclusive ? v < max : v <= max)) &&
            (step !== 1 || Number.isInteger(v))
          )
            onChange(v);
        }}
      />
      {invalid ? (
        <small className="input-error">
          Use {min ?? "a number"}–{maxExclusive ? "below " : ""}
          {max ?? "∞"}
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
  onDone,
}: {
  dimension: Dimension;
  value: number;
  max: number;
  min: number;
  onChange: (value: number) => void;
  onEditStart: () => void;
  onEditEnd: () => void;
  onDone: () => void;
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
              ? "Thickness"
              : "Shared pitch"
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
        aria-label={`${dimension === "height" ? "thickness" : dimension === "pitch" ? "shared pitch" : dimension} range`}
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
      <button className="dialog-close dimension-done" onClick={onDone}>
        Done
      </button>
    </>
  );
}
function MaterialEditor({
  label,
  material,
  onChange,
  getImportGuard,
  lossless = false,
}: {
  label: string;
  material: Material;
  onChange: (m: Material) => void;
  getImportGuard: () => () => boolean;
  lossless?: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const importSequence = useRef(0);
  useEffect(
    () => () => {
      importSequence.current += 1;
    },
    [],
  );
  async function importMaterial(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    const input = event.target;
    const sequence = ++importSequence.current;
    const workspaceUnchanged = getImportGuard();
    const staleMessage =
      "Inputs changed while reading. Import the table again.";
    setError("");
    try {
      if (selected.size > 1024 * 1024)
        throw new Error("Material JSON must be smaller than 1 MB.");
      const text = await selected.text();
      if (sequence !== importSequence.current) return;
      if (!workspaceUnchanged()) {
        setError(staleMessage);
        return;
      }
      const next = JSON.parse(text) as Material;
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
      if (sequence === importSequence.current)
        setError(
          workspaceUnchanged()
            ? e instanceof Error
              ? e.message
              : "Invalid material JSON."
            : staleMessage,
        );
    } finally {
      if (sequence === importSequence.current) input.value = "";
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
const example =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("example")
    : null;
const rectangularExample = example === "rectangle" || example === "rectangular";
const default2DProject = normalizeProject2D(
  rectangularExample ? rectangular2DInput : circular2DInput,
);
const reference2DManifest = rectangularExample
  ? rectangular2DManifest
  : circular2DManifest;
// An explicit legacy example URL keeps the original fixture accessible unchanged.
const legacyExample =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("example") === "1d";
const initialProject = legacyExample ? defaultProject : default2DProject;
const draftKey = inputDraftKey(example);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "An unexpected error occurred.";

export default function App() {
  const [recoveredDraft] = useState(() =>
    readInputDraft(browserDraftStorage(), draftKey),
  );
  const [draftStatus, setDraftStatus] = useState<
    DraftRead["status"] | DraftWrite | "pending"
  >(recoveredDraft.status);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const inspector = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const actionVersion = useRef(0);
  const pendingImportVersion = useRef<number | null>(null);
  function cancelImportRead() {
    if (pendingImportVersion.current === null) return;
    const current = pendingImportVersion.current === actionVersion.current;
    pendingImportVersion.current = null;
    if (current) actionVersion.current += 1;
  }
  const savedRequest = useRef(0);
  const connectionRequest = useRef(0);
  const startingRef = useRef(false);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [loadingProject, setLoadingProject] = useState<string | null>(null);
  function openSheet(next: Sheet, layerIndex?: number) {
    cancelImportRead();
    dismissImportedReview();
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
      project: structuredClone(recoveredDraft.project || initialProject),
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
  function dismissImportedReview() {
    if (reviewRef.current?.importedBase) presentReview(null);
  }
  function openHandoff() {
    cancelImportRead();
    dismissImportedReview();
    setHandoffOpen(true);
  }
  const [comparison, setComparison] = useState<SavedProject[] | null>(null);
  const comparisonRequest = useRef(0);
  function closeComparison() {
    comparisonRequest.current += 1;
    setComparison(null);
  }
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
  const [capabilities, setCapabilities] = useState<unknown>(undefined);
  const [connection, setConnection] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(
    recoveredDraft.project
      ? "Recovered the last saved valid inputs from this tab. Later unsaved edits may be missing. No result or undo history was restored."
      : "",
  );
  const [polarization, setPolarization] = useState<"s" | "p">("s");
  const [saved, setSaved] = useState<SavedSummary[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const inputFile = useRef<HTMLInputElement>(null);
  const inputsChanged = useRef(recoveredDraft.project !== null);
  const persistedProject = useRef<Project | null>(project);
  const activeJob = useRef<string | null>(null);
  const jobStart = useRef(0);
  const forwardBusy =
    starting || job?.status === "queued" || job?.status === "running";
  const busy = forwardBusy || fitBusy;
  const errors = validateProject(project);
  const supportError =
    capabilities === undefined
      ? null
      : solverSupportError(capabilities, project);
  const is2D = project.schema_version === "1.2";
  const stale = result !== null && !sameInputs(resultProject, project);
  const editedStaticDesign =
    staticPreview &&
    (!sameInputs(initialProject, project) ||
      (!!recoveredDraft.project && !displayedRun));
  const draftWarning =
    draftStatus === "unavailable"
      ? "Tab recovery is unavailable. Export inputs before reloading; an older draft may remain."
      : draftStatus === "too-large"
        ? "These inputs exceed the tab recovery limit. Export inputs before reloading; an older draft may remain."
        : draftStatus === "invalid"
          ? recoveredDraft.status === "invalid" && !inputsChanged.current
            ? "Saved tab inputs could not be restored. The example is open; import an exported JSON to recover your design."
            : "These inputs cannot be saved for tab recovery. Fix input errors or export valid inputs before reloading."
          : "";
  const selectedLayer = validLayerIndex(project, history.present.selectedLayer);
  const layer = project.layers[selectedLayer];
  const waves = project.illumination.wavelengths_nm;
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const selectedSpectrum = result?.spectra[polarization];

  useEffect(() => {
    let alive = true;
    const version = actionVersion.current;
    const revision = historyRef.current.revision;
    const capabilityRequest = ++connectionRequest.current;
    if (!recoveredDraft.project)
      readReference()
        .then((data) => {
          if (
            !alive ||
            inputsChanged.current ||
            version !== actionVersion.current ||
            revision !== historyRef.current.revision
          )
            return;
          const current = historyRef.current;
          const editing = !!current.editTransaction;
          dispatch({
            type: "reset",
            workspace: {
              ...workspaceFromFile(data, "reference"),
              selectedLayer: current.present.selectedLayer,
            },
          });
          // A reference arriving during a focused, unchanged field does not
          // retarget the editor or split its subsequent single edit transaction.
          if (editing) beginEdit();
        })
        .catch((failure) => {
          if (
            alive &&
            version === actionVersion.current &&
            !inputsChanged.current
          )
            setError(
              `${errorText(failure)} Inputs remain editable; no result was installed.`,
            );
        });
    if (staticPreview) setConnection("offline");
    else
      api
        .capabilities()
        .then((data) => {
          if (!alive || capabilityRequest !== connectionRequest.current) return;
          setCapabilities(data);
          setConnection("online");
        })
        .catch(() => {
          if (alive && capabilityRequest === connectionRequest.current)
            setConnection("offline");
        });
    return () => {
      alive = false;
      connectionRequest.current += 1;
    };
  }, []);
  useEffect(() => {
    if (!inputsChanged.current) return;
    if (project === persistedProject.current) {
      setDraftStatus("saved");
      return;
    }
    setDraftStatus("pending");
    const timer = window.setTimeout(() => {
      const status = writeInputDraft(browserDraftStorage(), draftKey, project);
      persistedProject.current = status === "saved" ? project : null;
      setDraftStatus(status);
    }, INPUT_DRAFT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [project]);
  useEffect(() => {
    function flushDraft() {
      const current = historyRef.current.present.project;
      if (!inputsChanged.current || current === persistedProject.current)
        return;
      const status = writeInputDraft(browserDraftStorage(), draftKey, current);
      persistedProject.current = status === "saved" ? current : null;
      setDraftStatus(status);
    }
    function onHidden() {
      if (document.visibilityState === "hidden") flushDraft();
    }
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      document.removeEventListener("visibilitychange", onHidden);
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
        if (!(await acceptForward(next, id))) return;
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
        if (
          e instanceof ForwardContractError ||
          e instanceof ApiContractError
        ) {
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
    if (projectInputsEqual(next, historyRef.current.present.project)) {
      if (
        selection !== undefined &&
        selection !== historyRef.current.present.selectedLayer
      ) {
        dismissImportedReview();
        dispatch({ type: "select-layer", index: selection });
      }
      return;
    }
    dismissImportedReview();
    actionVersion.current += 1;
    inputsChanged.current = true;
    dispatch({
      type: "replace-project",
      project: next,
      selectedLayer: selection,
    });
    setNotice("");
  }
  function install(workspace: Workspace, preservePolarization = false) {
    dismissImportedReview();
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
    if (!preservePolarization)
      setPolarization(workspace.displayedRun?.result.spectra.s ? "s" : "p");
    setJob(null);
  }
  function restoreHistory(direction: "undo" | "redo") {
    if (busy || startingRef.current) return;
    dismissImportedReview();
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
  async function workspaceFromSnapshot(
    data: SavedProject,
    expectedId: string,
  ): Promise<Workspace> {
    if (!validIdentifier(expectedId) || data.id !== expectedId)
      throw new Error("The server returned a different saved project.");
    if ("result_project" in data)
      throw new Error(
        "A server snapshot cannot supply alternate result inputs.",
      );
    const inputErrors = validateProject(data.project);
    if (inputErrors.length) throw new Error(inputErrors.join("\n"));
    const trusted = data.provenance?.source === "server_computed";
    if (
      trusted &&
      (!data.result ||
        data.result.result_type !== "forward" ||
        !validIdentifier(data.provenance?.job_id) ||
        !validInputHash(data.provenance?.input_hash))
    )
      throw new Error("The saved run is missing its server identity.");
    const run = data.result
      ? await createRunRecordAsync({
          inputProject: data.project,
          result: data.result,
          origin: trusted ? "server" : "imported",
          snapshotId: data.id,
          ...(trusted
            ? {
                sourceJobId: data.provenance!.job_id!,
                inputHash: data.provenance!.input_hash!,
              }
            : {}),
        })
      : null;
    if (trusted && data.project.schema_version === "1.2") {
      const provenance = data.provenance!;
      const metadata = run?.result.metadata;
      if (
        run?.result.schema_version !== "1.2" ||
        provenance.project_schema_version !== "1.2" ||
        provenance.result_schema_version !== "1.2" ||
        provenance.input_hash !== metadata?.input_hash ||
        provenance.engine !== metadata?.engine ||
        provenance.engine_version !== metadata?.version ||
        provenance.adapter_version !== metadata?.adapter_version
      )
        throw new Error(
          "The server snapshot provenance does not match its exact 2D input and result.",
        );
    }
    return { project: data.project, displayedRun: run };
  }
  async function acceptForward(next: Job, id?: string) {
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
      if (
        !isForwardResult(next.result) ||
        next.result.result_type !== "forward"
      )
        throw new ForwardContractError("The forward result is invalid.");
      let run: RunRecord;
      try {
        run = await createRunRecordAsync({
          inputProject: context.project,
          result: next.result,
          origin: "computed",
          sourceJobId: next.id,
          inputHash: context.hash,
        });
      } catch (failure) {
        throw new ForwardContractError(errorText(failure));
      }
      if (
        context !== jobContext.current ||
        context.version !== actionVersion.current ||
        context.revision !== historyRef.current.revision ||
        (id && activeJob.current !== id)
      )
        return false;
      if (
        context.project.schema_version === "1.2" &&
        run.result.metadata.input_hash !== context.hash
      )
        throw new ForwardContractError(
          "The 2D result does not match the validated job input hash.",
        );
      dispatch({ type: "set-displayed-run", run });
      setPolarization(next.result.spectra.s ? "s" : "p");
    }
    return true;
  }
  function selectLayer(index: number) {
    cancelImportRead();
    dismissImportedReview();
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
  function materialImportGuard() {
    const version = actionVersion.current;
    const revision = historyRef.current.revision;
    const workspace = historyRef.current.present;
    return () =>
      version === actionVersion.current &&
      revision === historyRef.current.revision &&
      workspace === historyRef.current.present;
  }
  function updateLayer(
    values: Partial<RectangleLayer> & {
      cd_x_nm?: number;
      cd_y_nm?: number;
      diameter_nm?: number;
    },
  ) {
    const current = historyRef.current.present;
    const currentProject = current.project;
    const index = validLayerIndex(currentProject, current.selectedLayer);
    if (
      currentProject.layers[index].geometry === "homogeneous" &&
      ("cd_nm" in values ||
        "cd_x_nm" in values ||
        "cd_y_nm" in values ||
        "diameter_nm" in values ||
        "background" in values)
    )
      return;
    const next = structuredClone(currentProject);
    Object.assign(next.layers[index], values);
    update(next);
  }
  function updateLight(
    values: Partial<Project["illumination"]> & { azimuth_deg?: number },
  ) {
    const next = structuredClone(historyRef.current.present.project);
    Object.assign(next.illumination, values);
    update(next);
  }
  function updateWavelengths(start: number, end: number, count: number) {
    if (!Number.isInteger(count) || count < 1 || count > (is2D ? 31 : 81))
      return;
    updateLight({
      wavelengths_nm: count === 1 ? [start] : linspace(start, end, count),
    });
  }
  async function run() {
    if (
      staticPreview ||
      busy ||
      startingRef.current ||
      errors.length ||
      supportError ||
      connection !== "online" ||
      !capabilities
    )
      return;
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
      if (
        submitted.schema_version === "1.2" &&
        (await hashProject2D(validation.project)) !== validation.input_hash
      )
        throw new ForwardContractError(
          "The server validation hash does not match these exact 2D inputs.",
        );
      if (
        version !== actionVersion.current ||
        revision !== historyRef.current.revision
      )
        return;
      jobContext.current = {
        project: validation.project,
        hash: validation.input_hash,
        version,
        revision,
      };
      const next = await api.start(validation.project);
      if (!(await acceptForward(next))) return;
      setConnection("online");
      activeJob.current = ["queued", "running"].includes(next.status)
        ? next.id
        : null;
      setJob(next);
      if (next.status === "succeeded")
        setNotice("Calculation complete. Results are ready.");
      else if (next.status === "failed")
        setError(next.error || "Calculation failed.");
    } catch (e) {
      if (version === actionVersion.current) {
        setError(errorText(e));
        setConnection(
          e instanceof ApiError ||
            e instanceof ForwardContractError ||
            e instanceof ApiContractError
            ? "online"
            : "offline",
        );
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
      if (activeJob.current !== id || !(await acceptForward(next, id))) return;
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
        const savedWorkspace = await workspaceFromSnapshot(data, data.id);
        if (
          data.provenance?.source !== "server_computed" ||
          data.provenance.job_id !== run.sourceJobId ||
          data.provenance.input_hash !== run.inputHash ||
          !sameInputs(data.project, run.inputProject) ||
          !(run.result.schema_version === "1.2"
            ? exactSemanticEqual(data.result, run.result)
            : semanticEqual(data.result, run.result))
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
        await workspaceFromSnapshot(saved, saved.id);
        if (
          saved.provenance?.source !== "unverified_import" ||
          !sameInputs(saved.project, frame.project) ||
          !(run?.result.schema_version === "1.2"
            ? exactSemanticEqual(
                saved.result,
                currentResult ? run.result : null,
              )
            : semanticEqual(saved.result, currentResult ? run.result : null))
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
    cancelImportRead();
    dismissImportedReview();
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
      const workspace = await workspaceFromSnapshot(data, id);
      if (
        request !== savedRequest.current ||
        version !== actionVersion.current ||
        revision !== historyRef.current.revision
      )
        return;
      install(workspace);
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
    // Clear synchronously so the same file can be selected again. An older
    // read must never clear the file input belonging to a newer selection.
    event.target.value = "";
    endEdit();
    presentReview(null);
    const version = ++actionVersion.current,
      revision = historyRef.current.revision,
      baseWorkspace = historyRef.current.present;
    pendingImportVersion.current = version;
    const current = () =>
      pendingImportVersion.current === version &&
      version === actionVersion.current &&
      revision === historyRef.current.revision &&
      baseWorkspace === historyRef.current.present;
    inputsChanged.current = true;
    try {
      if (file.size > 20 * 1024 * 1024)
        throw new Error("Project JSON must be smaller than 20 MB.");
      const text = await file.text();
      if (!current()) return;
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
      const data = await parseProjectFileAsync(text);
      if (!current()) return;
      const imported = reviewImportedDesign(data, baseWorkspace);
      if (imported) {
        setError("");
        if (imported.unchanged) {
          setNotice(
            "Imported inputs match the current design. Nothing changed.",
          );
          return;
        }
        setNotice("");
        presentReview({
          title: "Review imported design",
          importedBase: baseWorkspace,
          baseProject: baseWorkspace.project,
          workspace: imported.workspace,
          revision,
          actionVersion: version,
          note: "Review the imported inputs before applying. Your displayed spectrum stays with its original inputs. This does not calculate, save to the server or validate physical accuracy.",
          warnings: [],
          blockedReason: "",
        });
        return;
      }
      install(workspaceFromFile(data, "imported"));
      setNotice("JSON loaded. Review the inputs and saved results.");
      setError("");
    } catch (e) {
      if (current())
        setError(
          `${errorText(e)} If the inputs are valid, remove the result and result_project fields from the JSON file and import it again to recover inputs only.`,
        );
    } finally {
      if (pendingImportVersion.current === version)
        pendingImportVersion.current = null;
    }
  }
  async function readReference() {
    const response = await fetch(
      new URL(
        legacyExample
          ? "./reference-example.json"
          : rectangularExample
            ? "./reference-2d.json"
            : "./reference-circular.json",
        document.baseURI,
      ),
    );
    if (!response.ok)
      throw new Error("The bundled reference could not be loaded.");
    const text = await response.text();
    if (!legacyExample) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(text),
      );
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (hash !== reference2DManifest.bundle_sha256)
        throw new Error("The stored 2D reference failed its integrity check.");
    }
    const parsed = await parseProjectFileAsync(text);
    if (!legacyExample && !sameInputs(parsed.project, default2DProject))
      throw new Error(
        "The stored 2D reference does not contain the approved example inputs.",
      );
    return parsed;
  }
  async function loadReference() {
    dismissImportedReview();
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
    const request = ++connectionRequest.current;
    try {
      const data = await api.capabilities();
      if (request !== connectionRequest.current) return;
      setCapabilities(data);
      setConnection("online");
      const unsupported = solverSupportError(
        data,
        historyRef.current.present.project,
      );
      setNotice(
        unsupported
          ? ""
          : "Solver connected. Your current inputs have been preserved.",
      );
      setError("");
    } catch (e) {
      if (request !== connectionRequest.current) return;
      setCapabilities(undefined);
      setError(errorText(e));
      setConnection("offline");
    }
  }
  async function resetExample() {
    await loadReference();
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
          const workspace = await workspaceFromSnapshot(data, id);
          if (!workspace.displayedRun)
            throw new Error(
              `${data.name} has no saved spectrum. Run and save it before comparison.`,
            );
          return { ...data, result: workspace.displayedRun.result };
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
  async function reviewCandidate(candidate: SavedProject) {
    endEdit();
    const version = actionVersion.current,
      revision = historyRef.current.revision,
      request = ++comparisonRequest.current;
    let workspace: Workspace;
    try {
      workspace = await workspaceFromSnapshot(candidate, candidate.id);
    } catch (failure) {
      if (
        version === actionVersion.current &&
        revision === historyRef.current.revision &&
        request === comparisonRequest.current
      )
        setError(errorText(failure));
      return;
    }
    if (
      version !== actionVersion.current ||
      revision !== historyRef.current.revision ||
      request !== comparisonRequest.current
    )
      return;
    presentReview({
      title: "Review saved candidate",
      baseProject: historyRef.current.present.project,
      workspace,
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
      (pending.importedBase &&
        pending.importedBase !== historyRef.current.present) ||
      (!pending.importedBase &&
        !sameInputs(pending.baseProject, historyRef.current.present.project))
    ) {
      presentReview({
        ...pending,
        blockedReason:
          "The project changed while this preview was open. Close it and review the changes again.",
      });
      return;
    }
    // Consume this review before any state update can schedule another click.
    // A repeated Apply or a queued action after Cancel is therefore a no-op.
    presentReview(null);
    closeComparison();
    install(pending.workspace, !!pending.importedBase);
    setError("");
    setNotice("Changes applied. Undo is available in the Project menu.");
  }
  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (event.key === "Escape") cancelImportRead();
      const target = event.target as HTMLElement | null;
      if (
        busy ||
        review ||
        comparison ||
        showSaved ||
        handoffOpen ||
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
  function changeDimension2D(
    kind: "width" | "pitch",
    axis: "x" | "y",
    value: number,
  ) {
    if (busy || !Number.isFinite(value)) return;
    const next = structuredClone(historyRef.current.present.project);
    if (next.schema_version !== "1.2") return;
    const field = dimensionFields2D(
      next,
      validLayerIndex(next, historyRef.current.present.selectedLayer),
      kind,
    ).find((item) => item.axis === axis);
    if (!field || value < field.min || value > field.max) return;
    if (kind === "pitch") {
      if (axis === "x") next.period_nm = value;
      else next.period_y_nm = value;
    } else {
      const target =
        next.layers[
          validLayerIndex(next, historyRef.current.present.selectedLayer)
        ];
      if (target.geometry === "circular_hole_2d" && axis === "x")
        target.diameter_nm = value;
      else if (target.geometry === "rectangle_2d") {
        if (axis === "x") target.cd_x_nm = value;
        else target.cd_y_nm = value;
      } else if (target.geometry === "rectangle_1d" && axis === "x")
        target.cd_nm = value;
      else return;
    }
    update(next);
  }
  const dimensionValues = {
    width: layer.geometry === "rectangle_1d" ? layer.cd_nm : 0,
    height: layer.thickness_nm,
    pitch: project.period_nm,
  };
  const titles: Record<Sheet, string> = {
    width:
      is2D || project.layers.length > 1
        ? `Layer ${selectedLayer + 1} · ${layer.geometry === "circular_hole_2d" ? "Diameter" : "Width"}`
        : "Ridge width",
    height:
      is2D || project.layers.length > 1
        ? `Layer ${selectedLayer + 1} · Thickness`
        : "Layer thickness",
    pitch: is2D ? "Shared pitch" : "Pattern pitch",
    ridge:
      is2D || project.layers.length > 1
        ? `Layer ${selectedLayer + 1} · ${layer.geometry === "circular_hole_2d" ? "Hole material" : "Material"}`
        : layer.geometry === "homogeneous"
          ? "Layer material"
          : "Ridge material",
    groove:
      is2D || project.layers.length > 1
        ? `Layer ${selectedLayer + 1} · ${layer.geometry === "circular_hole_2d" ? "Host material" : is2D ? "Background" : "Groove"}`
        : "Groove material",
    ambient: "Ambient material",
    substrate: "Substrate material",
    materials:
      is2D || project.layers.length > 1
        ? `Layer ${selectedLayer + 1} · Materials`
        : "Optical materials",
    light: "Incident light",
    accuracy: "Calculation settings",
    layer: `Layer ${selectedLayer + 1}`,
  };
  const namedLayerSheet =
    sheet !== null &&
    ["width", "height", "ridge", "groove", "materials", "layer"].includes(
      sheet,
    ) &&
    (is2D || project.layers.length > 1 || sheet === "layer");
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
                Undo history clears on reload. Valid inputs recover in this tab
                only; export JSON to keep a copy.
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
                ? supportError
                  ? "Solver unsupported"
                  : "Solver connected"
                : connection === "checking"
                  ? "Connecting…"
                  : "Solver offline"}
          </span>
        </div>
      </header>
      <main id="main">
        <div className="page-heading">
          <div>
            <h1>Build your structure</h1>
            <label
              className={`project-name-label${is2D ? " project-name-2d" : ""}`}
            >
              Project
              <input
                aria-label="Project name"
                id="project-name"
                value={project.name}
                title={project.name}
                maxLength={is2D ? 200 : 100}
                disabled={busy}
                onFocus={beginEdit}
                onBlur={endEdit}
                onChange={(e) => update({ ...project, name: e.target.value })}
              />
            </label>
          </div>
        </div>
        <div className="workspace">
          <section
            className="design"
            id="build"
            aria-label="Interactive grating editor"
          >
            <LayerStack
              project={project}
              selected={selectedLayer}
              disabled={busy}
              onSelect={selectLayer}
              onChange={changeStack}
            />
            {project.schema_version === "1.2" ? (
              <>
                <ThreeStructure2D
                  project={project}
                  selectedLayer={selectedLayer}
                  onSelectLayer={selectLayer}
                  disabled={busy}
                />
                <div className="s2-context">
                  <h2>Edit Layer {selectedLayer + 1}</h2>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => openSheet("layer")}
                  >
                    Layer settings ↗
                  </button>
                </div>
                <DimensionCards2D
                  project={project}
                  selectedLayer={selectedLayer}
                  disabled={busy}
                  onEdit={(kind) =>
                    openSheet(kind === "thickness" ? "height" : kind)
                  }
                />
              </>
            ) : (
              <ThreeStructure
                project={project}
                selectedLayer={selectedLayer}
                onSelectLayer={selectLayer}
                disabled={busy}
                onChange={changeDimension}
                onOpen={openSheet}
                onEditLayer={() => openSheet("layer")}
                onEditStart={beginEdit}
                onEditEnd={endEdit}
              />
            )}
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
                    {project.schema_version === "1.2" && (
                      <>azimuth {project.illumination.azimuth_deg}° · </>
                    )}
                    {project.illumination.polarization === "both"
                      ? "s & p"
                      : project.illumination.polarization}
                  </span>
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
                <>
                  {editedStaticDesign ? (
                    <button
                      className="preview-result-button"
                      onClick={openHandoff}
                    >
                      Use this design locally <Icon name="arrow" />
                    </button>
                  ) : (
                    <a className="preview-result-button" href="#spectrum">
                      {result && resultOrigin === "reference"
                        ? "View example spectrum"
                        : "View spectrum"}{" "}
                      <span aria-hidden="true">↓</span>
                    </a>
                  )}
                  <p className="static-edit-note">
                    Preview only. Edits won't calculate a new spectrum.
                  </p>
                </>
              ) : (
                <button
                  className="run-button"
                  onClick={run}
                  disabled={
                    staticPreview ||
                    busy ||
                    !!errors.length ||
                    !!supportError ||
                    connection !== "online"
                  }
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
              {draftWarning && (
                <div className="draft-warning" role="status">
                  <p>{draftWarning}</p>
                  {!errors.length && (
                    <button
                      onClick={() => downloadProject(project, null, null)}
                    >
                      Export inputs
                    </button>
                  )}
                </div>
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

            {supportError && !staticPreview && (
              <div className="connection-banner" role="status">
                <span>{supportError}</span>
                <button onClick={reconnect} disabled={busy}>
                  Reconnect
                </button>
              </div>
            )}
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
            <details className="advanced-settings">
              <summary>
                Advanced settings <span aria-hidden="true">⌄</span>
              </summary>
              <fieldset disabled={busy}>
                <button
                  className="setting-row"
                  onClick={() => openSheet("accuracy")}
                  aria-label="Edit calculation settings"
                >
                  <span className="setting-icon">≋</span>
                  <span className="setting-name">Calculation</span>
                  <span className="setting-value">
                    {project.schema_version === "1.2"
                      ? `X ${project.solver.harmonics_x} · Y ${project.solver.harmonics_y}`
                      : `N = ${project.solver.harmonics}`}
                  </span>
                  <Icon name="arrow" />
                </button>
              </fieldset>
            </details>
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
                    : forwardBusy
                      ? "Showing the previous spectrum while your calculation runs."
                      : "Run again to update this spectrum."}
                </div>
              )}
              {resultOrigin === "reference" && result && !stale && (
                <div className="reference-note">
                  {staticPreview
                    ? "Edits don't recalculate this spectrum. "
                    : forwardBusy
                      ? "Showing the stored example while your calculation runs."
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
                Original inputs: pitch X {resultProject.period_nm} nm
                {resultProject.schema_version === "1.2"
                  ? ` · pitch Y ${resultProject.period_y_nm} nm`
                  : ""}{" "}
                ·{" "}
                {supportsSyntheticFit(resultProject) &&
                resultProject.layers[0].geometry === "rectangle_1d"
                  ? `width ${resultProject.layers[0].cd_nm} nm · height ${resultProject.layers[0].thickness_nm} nm`
                  : stackSummary(resultProject)}{" "}
                · {resultProject.illumination.angle_deg}° ·{" "}
                {resultProject.schema_version === "1.2"
                  ? `azimuth ${resultProject.illumination.azimuth_deg}° · Hx ${resultProject.solver.harmonics_x}, Hy ${resultProject.solver.harmonics_y}`
                  : `N = ${resultProject.solver.harmonics}`}
                . {resultProject.illumination.wavelengths_nm.length} wavelength
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
              order{result?.schema_version === "1.2" ? " (m, n) = (0, 0)" : ""}.
            </div>
            <div className="notes-grid">
              <p>
                <b>Plane-wave baseline</b>An infinite periodic{" "}
                {resultProject?.schema_version === "1.2" ||
                (!resultProject && is2D)
                  ? "2D"
                  : "1D"}{" "}
                stack with semi-infinite ambient/substrate. Finite beam,
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
      </main>
      <dialog
        ref={inspector}
        className={`inspector${is2D ? " structure2d-inspector" : ""}${is2D && (sheet === "width" || sheet === "pitch") ? " structure2d-dialog" : ""}`}
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
          className={`sheet-body ${is2D && (sheet === "width" || sheet === "pitch") ? "structure2d-sheet" : ""}`}
          onFocusCapture={(event) => {
            if (
              !(is2D && (sheet === "width" || sheet === "pitch")) &&
              (event.target as HTMLElement).matches(
                "input:not([type=file]), textarea",
              )
            )
              beginEdit();
          }}
          onBlurCapture={(event) => {
            if (
              !(is2D && (sheet === "width" || sheet === "pitch")) &&
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
              <h2 id="inspector-title">
                {sheet ? titles[sheet] : "Settings"}
                {namedLayerSheet && (
                  <span className="sr-only"> · {layer.name}</span>
                )}
              </h2>
              {namedLayerSheet && (
                <p
                  className="sheet-layer-name"
                  aria-hidden="true"
                  title={layer.name}
                >
                  {layer.name}
                </p>
              )}
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
                    maxLength={is2D ? 200 : 100}
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
                        geometry: event.target.value as Layer["geometry"],
                      })
                    }
                  >
                    {is2D && (
                      <>
                        <option value="circular_hole_2d">
                          Circular hole · X and Y
                        </option>
                        <option value="rectangle_2d">
                          Rectangle · X and Y
                        </option>
                      </>
                    )}
                    <option value="rectangle_1d">
                      {is2D ? "Ridge · repeats in X" : "Patterned"}
                    </option>
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
                {layer.geometry === "circular_hole_2d" &&
                  project.schema_version === "1.2" && (
                    <Field
                      label="Diameter"
                      unit="nm"
                      value={layer.diameter_nm}
                      min={0}
                      max={Math.min(project.period_nm, project.period_y_nm)}
                      step={0.1}
                      onChange={(diameter_nm) => updateLayer({ diameter_nm })}
                    />
                  )}
                {layer.geometry === "rectangle_2d" && (
                  <div className="field-grid">
                    <Field
                      label="Width X"
                      unit="nm"
                      value={layer.cd_x_nm}
                      min={0}
                      max={project.period_nm}
                      step={0.1}
                      onChange={(cd_x_nm) => updateLayer({ cd_x_nm })}
                    />
                    <Field
                      label="Width Y"
                      unit="nm"
                      value={layer.cd_y_nm}
                      min={0}
                      max={
                        project.schema_version === "1.2"
                          ? project.period_y_nm
                          : 0
                      }
                      step={0.1}
                      onChange={(cd_y_nm) => updateLayer({ cd_y_nm })}
                    />
                  </div>
                )}
                {is2D && layer.geometry === "rectangle_1d" && (
                  <p className="sheet-hint">This ridge is uniform along Y.</p>
                )}
                <button
                  className="text-button"
                  onClick={() => setSheet("ridge")}
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

            {project.schema_version === "1.2" &&
            (sheet === "width" || sheet === "pitch") ? (
              <DimensionEditor2D
                project={project}
                selectedLayer={selectedLayer}
                kind={sheet}
                disabled={busy}
                onChange={(axis, value) =>
                  changeDimension2D(sheet, axis, value)
                }
                onBeginEdit={beginEdit}
                onEndEdit={endEdit}
                onDone={() => setSheet(null)}
              />
            ) : (
              sheet &&
              ["width", "height", "pitch"].includes(sheet) && (
                <DimensionEditor
                  dimension={sheet as Dimension}
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
                  onChange={(value) =>
                    changeDimension(sheet as Dimension, value)
                  }
                  onEditStart={beginEdit}
                  onEditEnd={endEdit}
                  onDone={() => setSheet(null)}
                />
              )
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
                          key !== "groove" || layer.geometry !== "homogeneous",
                      )
                      .map((key) => (
                        <button
                          key={key}
                          aria-pressed={sheet === key}
                          onClick={() => setSheet(key)}
                        >
                          {key === "ridge" && layer.geometry === "homogeneous"
                            ? "Layer"
                            : layer.geometry === "circular_hole_2d" &&
                                key === "ridge"
                              ? "Hole material"
                              : layer.geometry === "circular_hole_2d" &&
                                  key === "groove"
                                ? "Host material"
                                : is2D && key === "ridge"
                                  ? "Pattern"
                                  : is2D && key === "groove"
                                    ? "Background"
                                    : key[0].toUpperCase() + key.slice(1)}
                        </button>
                      ))}
                  </div>
                  {(sheet === "ridge" || sheet === "materials") && (
                    <MaterialEditor
                      getImportGuard={materialImportGuard}
                      label={
                        layer.geometry === "homogeneous"
                          ? "Layer"
                          : layer.geometry === "circular_hole_2d"
                            ? "Hole"
                            : is2D
                              ? "Pattern"
                              : "Ridge"
                      }
                      material={layer.material}
                      onChange={(material) => updateLayer({ material })}
                    />
                  )}
                  {layer.geometry !== "homogeneous" &&
                    (sheet === "groove" || sheet === "materials") && (
                      <MaterialEditor
                        getImportGuard={materialImportGuard}
                        label={
                          layer.geometry === "circular_hole_2d"
                            ? "Host"
                            : is2D
                              ? "Background"
                              : "Groove"
                        }
                        material={layer.background}
                        onChange={(background) => updateLayer({ background })}
                      />
                    )}
                  {(sheet === "ambient" || sheet === "materials") && (
                    <MaterialEditor
                      getImportGuard={materialImportGuard}
                      label="Ambient"
                      material={project.ambient}
                      lossless
                      onChange={(ambient) =>
                        update({
                          ...historyRef.current.present.project,
                          ambient,
                        })
                      }
                    />
                  )}
                  {(sheet === "substrate" || sheet === "materials") && (
                    <MaterialEditor
                      getImportGuard={materialImportGuard}
                      label="Substrate"
                      material={project.substrate}
                      onChange={(substrate) =>
                        update({
                          ...historyRef.current.present.project,
                          substrate,
                        })
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
                    max={is2D ? 31 : 81}
                    onChange={(v) =>
                      v === 1
                        ? updateLight({ wavelengths_nm: [waves[0]] })
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
                    onChange={(angle_deg) => updateLight({ angle_deg })}
                  />
                  {project.schema_version === "1.2" && (
                    <Field
                      label="Azimuth · φ"
                      unit="°"
                      value={project.illumination.azimuth_deg}
                      min={0}
                      max={360}
                      maxExclusive
                      step={0.1}
                      onChange={(azimuth_deg) => updateLight({ azimuth_deg })}
                    />
                  )}
                </div>
                <label className="field">
                  <span>Polarization</span>
                  <select
                    value={project.illumination.polarization}
                    onChange={(e) =>
                      updateLight({
                        polarization: e.target
                          .value as Project["illumination"]["polarization"],
                      })
                    }
                  >
                    <option value="both">Separate s and p curves</option>
                    <option value="s">
                      {is2D
                        ? "s · E perpendicular to incidence plane"
                        : "s / TE · E ∥ grooves"}
                    </option>
                    <option value="p">
                      {is2D
                        ? "p · E parallel to incidence plane"
                        : "p / TM · H ∥ grooves"}
                    </option>
                  </select>
                </label>
                <p className="sheet-hint">
                  {is2D
                    ? "Azimuth rotates the incidence plane from X toward Y. "
                    : "The incidence plane is x–z; grooves run along y. "}
                  Use Import JSON for an exact, nonuniform wavelength list.
                </p>
              </>
            )}
            {sheet === "accuracy" && (
              <>
                <p className="sheet-help">
                  Increase Fourier order N and compare results to assess
                  convergence. A higher order alone does not guarantee accuracy.
                </p>
                {project.schema_version === "1.2" ? (
                  <div className="field-grid">
                    {(["x", "y"] as const).map((axis) => (
                      <Field
                        key={axis}
                        label={`Harmonic order ${axis.toUpperCase()}`}
                        value={
                          axis === "x"
                            ? project.solver.harmonics_x
                            : project.solver.harmonics_y
                        }
                        min={1}
                        max={5}
                        onChange={(value) => {
                          if (!Number.isInteger(value)) return;
                          const next = structuredClone(project);
                          if (axis === "x") next.solver.harmonics_x = value;
                          else next.solver.harmonics_y = value;
                          update(next);
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <Field
                    label="Harmonic order N"
                    value={project.solver.harmonics}
                    min={1}
                    max={20}
                    onChange={(harmonics) => {
                      if (Number.isInteger(harmonics))
                        update({ ...project, solver: { harmonics } });
                    }}
                    help={`Retained orders: −${project.solver.harmonics} … +${project.solver.harmonics} (${2 * project.solver.harmonics + 1} total)`}
                  />
                )}
                <div className="fixed-setting">
                  <span>Geometry</span>
                  <strong>
                    {is2D
                      ? "2D periodic finite-layer stack"
                      : "1D finite-layer stack"}
                  </strong>
                </div>
                <div className="fixed-setting">
                  <span>Layers</span>
                  <strong>{project.layers.length} · top to bottom</strong>
                </div>
                <p className="sheet-hint">
                  Infinite {is2D ? "2D" : "1D"} model; finite-target effects are
                  omitted.
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
      {handoffOpen && (
        <LocalDesignHandoff
          project={project}
          onClose={() => setHandoffOpen(false)}
        />
      )}
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
            review.actionVersion !== actionVersion.current ||
            (review.importedBase && review.importedBase !== history.present)
              ? "The project changed. Close this preview and review the changes again."
              : "")
          }
          onApply={applyReview}
          onClose={() => {
            if (reviewRef.current !== review) return;
            comparisonRequest.current += 1;
            if (review.importedBase) actionVersion.current += 1;
            presentReview(null);
          }}
        />
      )}
      {comparison && (
        <ComparisonPanel
          candidates={comparison}
          onUse={reviewCandidate}
          onClose={closeComparison}
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
