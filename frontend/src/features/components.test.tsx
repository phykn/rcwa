import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATES } from "../core/templates";
import { useStore } from "../state/store";
import { NumberField } from "../ui/NumberField";
import { Popover } from "../ui/Popover";
import { Inspector } from "./Inspector";
import { StackPanel } from "./StackPanel";

// jsdom has no canvas; the chart itself is covered by the browser end-to-end tests.
vi.mock("./results/SpectrumChart", () => ({ SpectrumChart: () => null }));

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
    await userEvent.click(screen.getByRole("button", { name: /⌀80 nm holes/ }));
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

describe("light and results", () => {
  it("edits polarization and azimuth, and keeps Fourier orders out of the panel", async () => {
    render(<Inspector />);
    expect(screen.queryByRole("textbox", { name: "Orders X" })).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "p (TM)" }));
    expect(useStore.getState().design.illumination.polarization).toBe("p");
    const azimuth = screen.getByRole("textbox", { name: "Azimuth φ" });
    await userEvent.clear(azimuth);
    await userEvent.type(azimuth, "45");
    expect(useStore.getState().design.illumination.azimuth_deg).toBe(45);
  });

  it("shows the design's polarization and the calculation notes", async () => {
    const { SpectrumView } = await import("./results/SpectrumView");
    const pol = (R: number[]) => ({ R, T: R.map((r) => 1 - r), R_specular: R, T_specular: R.map((r) => 1 - r), A_balance: [0, 0], orders: [[], []] });
    const result = {
      wavelengths_nm: [500, 600],
      spectra: { s: pol([0.1, 0.2]), p: pol([0.3, 0.4]) },
      warnings: ["Convergence not assessed"],
      harmonics: [2, 2] as [number, number],
      inputHashes: ["abc123"],
      elapsedSeconds: 1,
      engine: "browser" as const,
      maxLosslessFluxError: 1e-12,
    };
    useStore.getState().setFull(useStore.getState().design, result);
    useStore.setState({ cursor: 500 });
    const { rerender } = render(<SpectrumView />);
    expect(screen.getByText("Convergence not assessed")).toBeTruthy();
    // Both polarizations: unpolarized light is their mean.
    expect(screen.getByText("Reflected", { selector: "dt" }).nextElementSibling!.textContent).toBe("20.0%");
    const design = useStore.getState().design;
    const pOnly = { ...design, illumination: { ...design.illumination, polarization: "p" as const } };
    useStore.getState().replace(pOnly, result);
    rerender(<SpectrumView />);
    expect(screen.getByText("Reflected", { selector: "dt" }).nextElementSibling!.textContent).toBe("30.0%");
  });
});

describe("one curve set", () => {
  const run = (R: number) => ({
    wavelengths_nm: [500, 600],
    spectra: { s: { R: [R, R], T: [1 - R, 1 - R], R_specular: [R, R], T_specular: [1 - R, 1 - R], A_balance: [0, 0], orders: [[], []] } },
    warnings: [],
    harmonics: [2, 2] as [number, number],
    inputHashes: [],
    elapsedSeconds: 1,
    engine: "browser" as const,
    maxLosslessFluxError: null,
  });
  const reflected = () => screen.getByText("Reflected", { selector: "dt" }).nextElementSibling!.textContent;

  it("shows the preview of the current inputs instead of the older full result", async () => {
    const { SpectrumView } = await import("./results/SpectrumView");
    const before = useStore.getState().design;
    useStore.getState().setFull(before, run(0.1));
    useStore.setState({ cursor: 500 });
    useStore.getState().edit((d) => ({ ...d, period_nm: d.period_nm + 5 }));
    const { rerender } = render(<SpectrumView />);
    // No result for these inputs yet: the newest one stays until the next arrives.
    expect(reflected()).toBe("10.0%");
    useStore.getState().setPreview(useStore.getState().design, run(0.3));
    rerender(<SpectrumView />);
    expect(reflected()).toBe("30.0%");
    useStore.getState().setFull(useStore.getState().design, run(0.25));
    rerender(<SpectrumView />);
    expect(reflected()).toBe("25.0%");
  });
});

describe("Popover", () => {
  it("keeps focus where the user typed when its parent re-renders", async () => {
    function Host({ tick }: { tick: number }) {
      return (
        <Popover label="Pick" onClose={() => {}}>
          <input aria-label="Search" />
          <input aria-label={`n ${tick % 1}`} />
        </Popover>
      );
    }
    const { rerender } = render(<Host tick={0} />);
    const n = screen.getByRole("textbox", { name: "n 0" });
    await userEvent.click(n);
    await userEvent.type(n, "2");
    rerender(<Host tick={1} />);
    // Keyboard only: `type` would click the field and hide a lost focus.
    await userEvent.keyboard(".25");
    expect((n as HTMLInputElement).value).toBe("2.25");
    expect((screen.getByRole("textbox", { name: "Search" }) as HTMLInputElement).value).toBe("");
  });
});
