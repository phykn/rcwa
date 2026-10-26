import { create } from "zustand";
import { autoOrders, designKey } from "../core/design";
import type { Design, SpectrumResult } from "../engine/types";

export type Selection = { kind: "layer"; index: number } | { kind: "ambient" } | { kind: "substrate" };

export interface Run {
  key: string;
  design: Design;
  result: SpectrumResult;
  at: number;
}

export interface CalcStatus {
  phase: "idle" | "preview" | "solving" | "stopped" | "error";
  done: number;
  total: number;
  error: { code: string; message: string } | null;
}

interface State {
  design: Design;
  /** designKey(design), kept in step so readers never re-serialize. */
  key: string;
  gestureRecorded: boolean;
  past: Design[];
  future: Design[];
  gesture: boolean;
  selection: Selection;
  full: Run | null;
  preview: Run | null;
  cursor: number;
  status: CalcStatus;
  notice: { text: string; tone: "info" | "error" } | null;
  edit: (change: (design: Design) => Design) => void;
  beginGesture: () => void;
  endGesture: () => void;
  replace: (design: Design, result?: SpectrumResult | null) => void;
  undo: () => void;
  redo: () => void;
  select: (selection: Selection) => void;
  setFull: (design: Design, result: SpectrumResult) => void;
  setPreview: (design: Design, result: SpectrumResult) => void;
  setStatus: (status: Partial<CalcStatus>) => void;
  setCursor: (wavelength: number) => void;
  notify: (text: string, tone?: "info" | "error") => void;
}

const HISTORY = 100;
function clampSelection(selection: Selection, design: Design): Selection {
  if (selection.kind !== "layer") return selection;
  return { kind: "layer", index: Math.min(selection.index, design.layers.length - 1) };
}

export const useStore = create<State>((set, get) => ({
  design: null as unknown as Design,
  key: "",
  gestureRecorded: false,
  past: [],
  future: [],
  gesture: false,
  selection: { kind: "layer", index: 0 },
  full: null,
  preview: null,
  cursor: 0,
  status: { phase: "idle", done: 0, total: 0, error: null },
  notice: null,

  edit: (change) => {
    const { design, past, gesture, gestureRecorded, key } = get();
    const next = autoOrders(change(design), design);
    const nextKey = designKey(next);
    if (nextKey === key) return;
    set({
      design: next,
      key: nextKey,
      // A drag or held key is one undo step: record only its starting design.
      past: gesture && gestureRecorded ? past : [...past, design].slice(-HISTORY),
      future: [],
      gestureRecorded: gesture,
      selection: clampSelection(get().selection, next),
    });
  },
  beginGesture: () => set({ gesture: true, gestureRecorded: false }),
  endGesture: () => set({ gesture: false, gestureRecorded: false }),
  replace: (design, result) => {
    const { past, design: previous } = get();
    const key = designKey(design);
    set({
      design,
      key,
      past: previous ? [...past, previous].slice(-HISTORY) : past,
      future: [],
      selection: clampSelection(get().selection, design),
      ...(result ? { full: { key, design, result, at: Date.now() }, preview: null } : {}),
    });
  },
  undo: () => {
    const { past, future, design } = get();
    if (!past.length) return;
    const previous = past[past.length - 1];
    set({
      design: previous,
      key: designKey(previous),
      past: past.slice(0, -1),
      future: [design, ...future],
      selection: clampSelection(get().selection, previous),
    });
  },
  redo: () => {
    const { past, future, design } = get();
    if (!future.length) return;
    const [next, ...rest] = future;
    set({
      design: next,
      key: designKey(next),
      past: [...past, design],
      future: rest,
      selection: clampSelection(get().selection, next),
    });
  },
  select: (selection) => set({ selection }),
  setFull: (design, result) => set({ full: { key: designKey(design), design, result, at: Date.now() } }),
  setPreview: (design, result) => set({ preview: { key: designKey(design), design, result, at: Date.now() } }),
  setStatus: (status) => set({ status: { ...get().status, ...status } }),
  setCursor: (wavelength) => set({ cursor: wavelength }),
  notify: (text, tone = "info") => set({ notice: { text, tone } }),
}));
