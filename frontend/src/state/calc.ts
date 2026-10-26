import { previewDesign } from "../engine/chunks";
import type { EngineHub } from "../engine";
import { EngineError, type Design } from "../engine/types";
import { designError } from "../core/design";
import { useStore } from "./store";

const PREVIEW_DELAY = 120;
const FULL_DELAY = 650;

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

function describe(error: unknown) {
  if (error instanceof EngineError) return { code: error.code, message: error.message };
  return { code: "engine_error", message: error instanceof Error ? error.message : String(error) };
}

/**
 * Watches the design: a coarse preview follows every edit, and a full-accuracy
 * solve follows once editing pauses. Superseded work is aborted, never applied.
 */
export function connectCalculation(hub: EngineHub) {
  let previewTimer = 0;
  let fullTimer = 0;
  let previewAbort: AbortController | null = null;
  let fullAbort: AbortController | null = null;
  let fullKey = "";

  async function runPreview(design: Design, key: string) {
    previewAbort?.abort();
    const abort = (previewAbort = new AbortController());
    const store = useStore.getState();
    if (store.status.phase !== "solving") store.setStatus({ phase: "preview", error: null });
    try {
      // Previews stay local: the server admits one 2D job, which the full solve needs.
      const result = await hub.browserEngine.solve(previewDesign(design), { signal: abort.signal, priority: "preview" });
      if (abort.signal.aborted || useStore.getState().key !== key) return;
      useStore.getState().setPreview(design, result);
      if (useStore.getState().status.phase === "preview") useStore.getState().setStatus({ phase: "idle" });
    } catch (error) {
      if (isAbort(error) || abort.signal.aborted) return;
      useStore.getState().setStatus({ phase: "error", error: describe(error) });
    }
  }

  async function runFull(design: Design, key: string) {
    fullAbort?.abort();
    const abort = (fullAbort = new AbortController());
    fullKey = key;
    const total = design.illumination.wavelengths_nm.length;
    useStore.getState().setStatus({ phase: "solving", done: 0, total, error: null });
    try {
      const result = await hub.engine.solve(design, {
        signal: abort.signal,
        priority: "interactive",
        onProgress: (done) => !abort.signal.aborted && useStore.getState().setStatus({ done }),
      });
      if (abort.signal.aborted) return;
      useStore.getState().setFull(design, result);
      useStore.getState().setStatus({ phase: "idle", error: null });
    } catch (error) {
      if (isAbort(error) || abort.signal.aborted) return;
      useStore.getState().setStatus({ phase: "error", error: describe(error) });
    } finally {
      if (fullAbort === abort) fullKey = "";
    }
  }

  function schedule(immediate = false) {
    const { design, key, full, gesture } = useStore.getState();
    clearTimeout(previewTimer);
    clearTimeout(fullTimer);
    previewAbort?.abort();
    if (fullKey && fullKey !== key) {
      fullAbort?.abort();
      fullKey = "";
    }
    const problem = designError(design);
    if (problem) {
      useStore.getState().setStatus({ phase: "error", error: { code: "invalid_design", message: problem } });
      return;
    }
    if (full?.key === key) {
      useStore.getState().setStatus({ phase: "idle", error: null });
      return;
    }
    if (fullKey === key) return;
    previewTimer = window.setTimeout(() => void runPreview(design, key), immediate ? 0 : PREVIEW_DELAY);
    if (immediate || !gesture)
      fullTimer = window.setTimeout(() => void runFull(design, key), immediate ? 0 : FULL_DELAY);
    else useStore.getState().setStatus({ phase: "idle", error: null });
  }

  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.key !== previous.key || state.gesture !== previous.gesture) schedule();
  });
  schedule();

  return {
    solveNow: () => schedule(true),
    cancel: () => {
      fullAbort?.abort();
      fullKey = "";
      useStore.getState().setStatus({ phase: "idle" });
    },
    dispose: () => {
      unsubscribe();
      previewAbort?.abort();
      fullAbort?.abort();
    },
  };
}

export type Calculation = ReturnType<typeof connectCalculation>;
