import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { defaultProject } from "./model";
import { structureValues } from "./structureGeometry";
import { createThreeStructureRenderer } from "./threeStructureRenderer";
import type {
  StructureRendererOptions,
  StructureRendererState,
} from "./threeStructureRendererTypes";

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  dispose: vi.fn(),
  controlsDispose: vi.fn(),
  intersections: vi.fn(),
  controls: [] as { enabled: boolean }[],
}));
class Canvas extends EventTarget {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  tabIndex = -1;
  attributes: Record<string, string> = {};
  removed = false;
  // Node's EventTarget does not reliably match boolean capture flags during
  // removal. Normalize them so this fake uses the browser's listener semantics.
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    super.addEventListener(
      type,
      listener,
      typeof options === "boolean" ? { capture: options } : options,
    );
  }
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    super.removeEventListener(
      type,
      listener,
      typeof options === "boolean" ? { capture: options } : options,
    );
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 590, height: 436 };
  }
  remove() {
    this.removed = true;
  }
}
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    Raycaster: class {
      setFromCamera() {}
      intersectObjects = mocks.intersections;
    },
    WebGLRenderer: class {
      domElement = new Canvas();
      shadowMap = { enabled: false };
      setPixelRatio() {}
      setClearColor() {}
      setSize() {}
      render = mocks.render;
      dispose = mocks.dispose;
    },
  };
});
vi.mock("three/addons/controls/OrbitControls.js", async () => {
  const { Vector3 } = await import("three");
  return {
    OrbitControls: class extends EventTarget {
      target = new Vector3();
      enabled = true;
      camera: THREE.Camera;
      constructor(camera: THREE.Camera) {
        super();
        this.camera = camera;
        mocks.controls.push(this);
      }
      update() {
        this.camera.lookAt(this.target);
      }
      dispose = mocks.controlsDispose;
    },
  };
});
class Resize {
  static instances: Resize[] = [];
  callback: () => void;
  disconnect = vi.fn();
  constructor(callback: () => void) {
    this.callback = callback;
    Resize.instances.push(this);
  }
  observe() {}
}
function setup() {
  let canvas: Canvas | undefined;
  const host = {
    clientWidth: 590,
    clientHeight: 436,
    getBoundingClientRect: () => ({ width: 590, height: 436 }),
    appendChild: (value: Canvas) => {
      canvas = value;
    },
  } as unknown as HTMLDivElement;
  const project = structuredClone(defaultProject);
  const state: StructureRendererState = {
    project,
    values: structureValues(project),
    selectedIndex: 0,
    disabled: false,
    onOpen: vi.fn(),
    onSelectLayer: vi.fn(),
  };
  const options: StructureRendererOptions = {
    getState: () => state,
    isDragging: () => false,
    isHandleGestureBlocked: () => false,
    onLayout: vi.fn(),
    onMoved: vi.fn(),
    onContextLost: vi.fn(),
    onContextRestored: vi.fn(),
  };
  return { host, state, options, getCanvas: () => canvas! };
}
function key(canvas: Canvas, value: string) {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: value });
  canvas.dispatchEvent(event);
  return event;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.controls.length = 0;
  mocks.intersections.mockReturnValue([
    { object: { userData: { kind: "ridge", layerIndex: 0 } } },
  ]);
  Resize.instances = [];
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("ResizeObserver", Resize);
});
afterEach(() => vi.unstubAllGlobals());

describe("lazy legacy renderer boundary", () => {
  it("retains layer geometry, physical handle mapping, and keyboard zoom/reset", () => {
    const { host, state, options, getCanvas } = setup();
    const renderer = createThreeStructureRenderer(host, options);
    Resize.instances[0].callback();
    const canvas = getCanvas();
    expect(canvas.dataset.selectedLayer).toBe("0");
    expect(canvas.dataset.layerCount).toBe("1");
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.style.touchAction).toBe("pan-y");
    expect(options.onLayout).toHaveBeenCalled();
    for (const dimension of ["width", "height", "pitch"] as const) {
      const mapping = renderer.getDragMapping(dimension)!;
      expect(mapping.nmPerPixel).toBeGreaterThan(0);
      expect(Math.hypot(mapping.dx, mapping.dy)).toBeCloseTo(1);
    }
    const zoom = Number(canvas.dataset.zoom);
    expect(key(canvas, "+").defaultPrevented).toBe(true);
    expect(Number(canvas.dataset.zoom)).toBeGreaterThan(zoom);
    key(canvas, "0");
    expect(Number(canvas.dataset.zoom)).toBeCloseTo(1);
    expect(options.onMoved).toHaveBeenLastCalledWith(false);
    state.project.layers.push({ ...state.project.layers[0], thickness_nm: 70 });
    state.selectedIndex = 1;
    state.values = structureValues(state.project, 1);
    renderer.setValues(state.values);
    expect(canvas.dataset.layerCount).toBe("2");
    expect(canvas.dataset.selectedLayer).toBe("1");
    const mapping = renderer.getDragMapping("height")!;
    const layers = state.project.layers;
    layers[1].thickness_nm += 10;
    state.values = structureValues(state.project, 1);
    renderer.setValues(state.values, false);
    // A single drag stores this mapping; the camera/scale remain frozen while
    // intermediate meshes update, then normal setValues refits on release.
    expect(Number(canvas.dataset.zoom)).toBeCloseTo(1);
    expect(mapping.nmPerPixel).toBeGreaterThan(0);
    renderer.setValues(state.values);
    renderer.dispose();
  });

  it("stops rendering on context loss, uses current inputs on restoration, and detaches all listeners once", () => {
    const { host, state, options, getCanvas } = setup();
    const renderer = createThreeStructureRenderer(host, options);
    const canvas = getCanvas();
    const loss = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(loss);
    expect(loss.defaultPrevented).toBe(true);
    expect(options.onContextLost).toHaveBeenCalledOnce();
    renderer.setControlsEnabled(true);
    expect(mocks.controls[0].enabled).toBe(false);
    const renders = mocks.render.mock.calls.length;
    key(canvas, "+");
    expect(mocks.render).toHaveBeenCalledTimes(renders);
    state.project.layers.push({ ...state.project.layers[0], thickness_nm: 40 });
    state.selectedIndex = 1;
    state.values = structureValues(state.project, 1);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(options.onContextRestored).toHaveBeenCalledOnce();
    expect(canvas.dataset.selectedLayer).toBe("1");
    expect(mocks.controls[0].enabled).toBe(true);
    renderer.dispose();
    renderer.dispose();
    expect(canvas.removed).toBe(true);
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.controlsDispose).toHaveBeenCalledOnce();
    expect(Resize.instances[0].disconnect).toHaveBeenCalledOnce();
    canvas.dispatchEvent(new Event("webglcontextlost"));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(options.onContextLost).toHaveBeenCalledOnce();
    expect(options.onContextRestored).toHaveBeenCalledOnce();
  });

  it("uses latest selection callbacks and respects an edit lock arriving during a pointer gesture", () => {
    const { host, state, options, getCanvas } = setup();
    const renderer = createThreeStructureRenderer(host, options);
    const canvas = getCanvas();
    const pointer = (type: string) => {
      const event = new Event(type);
      Object.assign(event, {
        pointerId: 1,
        button: 0,
        clientX: 120,
        clientY: 110,
      });
      canvas.dispatchEvent(event);
    };
    pointer("pointerdown");
    const latest = vi.fn();
    state.onSelectLayer = latest;
    pointer("pointerup");
    expect(latest).toHaveBeenCalledWith(0);
    pointer("pointerdown");
    state.disabled = true;
    pointer("pointerup");
    expect(latest).toHaveBeenCalledOnce();
    state.disabled = false;
    pointer("pointerdown");
    renderer.suppressPicks();
    pointer("pointerup");
    expect(latest).toHaveBeenCalledOnce();
    renderer.dispose();
    pointer("pointerdown");
    pointer("pointerup");
    expect(latest).toHaveBeenCalledOnce();
  });

  it("keeps fallback active when context restoration cannot draw", () => {
    const { host, options, getCanvas } = setup();
    const renderer = createThreeStructureRenderer(host, options);
    const canvas = getCanvas();
    canvas.dispatchEvent(new Event("webglcontextlost"));
    mocks.render.mockImplementationOnce(() => {
      throw new Error("Still unavailable");
    });
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(options.onContextRestored).not.toHaveBeenCalled();
    expect(options.onContextLost).toHaveBeenCalledTimes(2);
    expect(mocks.controls[0].enabled).toBe(false);
    renderer.dispose();
  });

  it("cleans up a partially initialized renderer when initial WebGL drawing throws", () => {
    const { host, options, getCanvas } = setup();
    mocks.render.mockImplementationOnce(() => {
      throw new Error("WebGL failed");
    });
    expect(() => createThreeStructureRenderer(host, options)).toThrow(
      "WebGL failed",
    );
    expect(getCanvas().removed).toBe(true);
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.controlsDispose).toHaveBeenCalledOnce();
    expect(Resize.instances[0].disconnect).toHaveBeenCalledOnce();
    getCanvas().dispatchEvent(new Event("webglcontextrestored"));
    expect(options.onContextRestored).not.toHaveBeenCalled();
  });
});
