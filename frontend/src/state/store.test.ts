import { beforeEach, describe, expect, it } from "vitest";
import { TEMPLATES } from "../core/templates";
import { useStore } from "./store";

const design = TEMPLATES[0].design;
const thickness = () => useStore.getState().design.layers[0].thickness_nm;
const setThickness = (t: number) =>
  useStore.getState().edit((d) => ({ ...d, layers: d.layers.map((l, i) => (i ? l : { ...l, thickness_nm: t })) }));

beforeEach(() => {
  useStore.setState({ past: [], future: [], full: null, ghost: null, gesture: false, gestureRecorded: false });
  useStore.getState().replace(design);
  useStore.setState({ past: [] });
});

describe("history", () => {
  it("undoes and redoes edits and ignores no-op edits", () => {
    setThickness(100);
    setThickness(100);
    setThickness(110);
    expect(useStore.getState().past).toHaveLength(2);
    useStore.getState().undo();
    expect(thickness()).toBe(100);
    useStore.getState().undo();
    expect(thickness()).toBe(design.layers[0].thickness_nm);
    useStore.getState().redo();
    expect(thickness()).toBe(100);
    setThickness(130);
    expect(useStore.getState().future).toHaveLength(0);
  });

  it("records a whole drag as one undo step", () => {
    useStore.getState().beginGesture();
    for (const t of [91, 92, 93, 94]) setThickness(t);
    useStore.getState().endGesture();
    expect(useStore.getState().past).toHaveLength(1);
    useStore.getState().undo();
    expect(thickness()).toBe(design.layers[0].thickness_nm);
  });

  it("keeps the selection inside the stack", () => {
    useStore.getState().select({ kind: "layer", index: 2 });
    useStore.getState().edit((d) => ({ ...d, layers: d.layers.slice(0, 1) }));
    expect(useStore.getState().selection).toEqual({ kind: "layer", index: 0 });
  });
});

describe("runs", () => {
  it("binds results to inputs and keeps the previous result as a ghost", () => {
    const result = { wavelengths_nm: [450] } as never;
    useStore.getState().setFull(useStore.getState().design, result);
    expect(useStore.getState().full!.key).toBe(useStore.getState().key);
    setThickness(150);
    expect(useStore.getState().full!.key).not.toBe(useStore.getState().key);
    useStore.getState().setFull(useStore.getState().design, result);
    expect(useStore.getState().ghost).not.toBeNull();
  });
});
