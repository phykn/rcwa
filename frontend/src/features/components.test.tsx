import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { TEMPLATES } from "../core/templates";
import { useStore } from "../state/store";
import { NumberField } from "../ui/NumberField";
import { Inspector } from "./Inspector";
import { StackPanel } from "./StackPanel";

beforeEach(() => {
  useStore.setState({ past: [], future: [], full: null, gesture: false, gestureRecorded: false });
  useStore.getState().replace(TEMPLATES[0].design);
  useStore.setState({ past: [], selection: { kind: "layer", index: 0 } });
});

describe("NumberField", () => {
  it("commits valid typing, explains invalid typing and restores on blur", async () => {
    const values: number[] = [];
    render(<NumberField label="Thickness" unit="nm" value={90} min={0} max={200} onChange={(v) => values.push(v)} />);
    const input = screen.getByRole("textbox", { name: "Thickness" });
    await userEvent.clear(input);
    await userEvent.type(input, "120");
    expect(values.at(-1)).toBe(120);
    await userEvent.clear(input);
    await userEvent.type(input, "500");
    expect(screen.getByText("Use 0–200 nm")).toBeTruthy();
    // Valid prefixes ("5", "50") update live; the out-of-range value never does.
    expect(values.at(-1)).toBe(50);
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("90");
  });

  it("steps with arrow keys and records a slider drag as one gesture", () => {
    const values: number[] = [];
    render(<NumberField label="Pitch" unit="nm" value={150} min={20} max={5000} onChange={(v) => values.push(v)} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Pitch" }), { key: "ArrowUp", shiftKey: true });
    expect(values).toEqual([160]);
    const slider = screen.getByRole("slider", { name: "Pitch slider" });
    fireEvent.pointerDown(slider);
    expect(useStore.getState().gesture).toBe(true);
    fireEvent.pointerUp(slider);
    expect(useStore.getState().gesture).toBe(false);
  });
});

describe("editing through the panels", () => {
  it("changes the selected layer's dimension and shape", async () => {
    render(<Inspector />);
    const diameter = screen.getByRole("textbox", { name: "Hole diameter" });
    await userEvent.clear(diameter);
    await userEvent.type(diameter, "70");
    expect(useStore.getState().design.layers[0]).toMatchObject({ diameter_nm: 70 });
    await userEvent.click(screen.getByRole("radio", { name: "Film" }));
    expect(useStore.getState().design.layers[0].geometry).toBe("homogeneous");
    expect(screen.queryByRole("textbox", { name: "Hole diameter" })).toBeNull();
  });

  it("selects, reorders, duplicates and deletes layers from the stack", async () => {
    render(<StackPanel />);
    const names = () => useStore.getState().design.layers.map((l) => l.thickness_nm);
    const start = names();
    await userEvent.click(screen.getByRole("button", { name: /Holes ⌀80/ }));
    expect(useStore.getState().selection).toEqual({ kind: "layer", index: 1 });
    const actions = screen.getByRole("toolbar", { name: "Layer 2 actions" });
    await userEvent.click(within(actions).getByRole("button", { name: "Move up" }));
    expect(names()).toEqual([start[1], start[0], start[2]]);
    await userEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "Duplicate" }));
    expect(useStore.getState().design.layers).toHaveLength(4);
    await userEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "Delete" }));
    expect(useStore.getState().design.layers).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: /Substrate/ }));
    expect(useStore.getState().selection).toEqual({ kind: "substrate" });
  });

  it("adds a layer of the chosen shape below the selection", async () => {
    render(<StackPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await userEvent.click(screen.getByRole("button", { name: "Rectangular blocks (2D)" }));
    const layers = useStore.getState().design.layers;
    expect(layers).toHaveLength(4);
    expect(layers[1].geometry).toBe("rectangle_2d");
    expect(useStore.getState().selection).toEqual({ kind: "layer", index: 1 });
  });
});
