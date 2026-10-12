import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { layerColor } from "./layerColors";
import type { Project1D as Project } from "./model";
import {
  dimensionRange,
  visibleStructureDimensions,
  structureGeometry,
  structureValues,
} from "./structureGeometry";
import type { StructureDimension, StructureSheet } from "./structureGeometry";

import type { HandlePoints as Anchors } from "./structureHandleLayout";
import type { StructureRenderer } from "./threeStructureRendererTypes";

interface DimensionDrag {
  dimension: StructureDimension;
  x: number;
  y: number;
  value: number;
  id: number;
  dx: number;
  dy: number;
  nmPerPixel: number;
  target: HTMLDivElement;
  layerIndex: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const defaultAnchors: Anchors = {
  width: { x: 62, y: 48 },
  height: { x: 48, y: 31 },
  pitch: { x: 71, y: 79 },
};

export function ThreeStructure({
  project,
  disabled = false,
  selectedLayer = 0,
  onSelectLayer,
  onChange,
  onOpen,
  onEditLayer,
  onFallbackChange,
  onEditStart,
  onEditEnd,
}: {
  project: Project;
  disabled?: boolean;
  selectedLayer?: number;
  onSelectLayer?: (index: number) => void;
  onChange: (dimension: StructureDimension, value: number) => void;
  onOpen: (sheet: StructureSheet, layerIndex?: number) => void;
  onEditLayer?: () => void;
  onFallbackChange?: (failed: boolean) => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
}) {
  const values = structureValues(project, selectedLayer);
  const selectedIndex = values.selectedLayer ?? 0;
  const layer = project.layers[selectedIndex];
  const dimensions = visibleStructureDimensions(values);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<StructureRenderer | null>(null);
  // Native Three.js events always consult current props, including an edit lock
  // that can arrive halfway through a pointer gesture.
  const current = useRef({
    values,
    project,
    selectedIndex,
    onSelectLayer,
    disabled,
    onChange,
    onOpen,
    onEditStart,
    onEditEnd,
  });
  current.current = {
    values,
    project,
    selectedIndex,
    onSelectLayer,
    disabled,
    onChange,
    onOpen,
    onEditStart,
    onEditEnd,
  };
  const drag = useRef<DimensionDrag | null>(null);
  const keyboardEditing = useRef(false);
  const pointers = useRef(new Set<number>());
  const blockedHandleGesture = useRef(false);
  const failedRef = useRef(false);
  const [handleLayout, setHandleLayout] = useState({
    anchors: defaultAnchors,
    physical: defaultAnchors,
    available: true,
  });
  const anchors = handleLayout.anchors;
  const [active, setActive] = useState<StructureDimension | null>(null);
  const [focused, setFocused] = useState<StructureDimension | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [moved, setMoved] = useState(false);
  const [showHandles, setShowHandles] = useState(false);

  function endKeyboardEdit() {
    if (keyboardEditing.current) {
      keyboardEditing.current = false;
      current.current.onEditEnd?.();
    }
  }

  function releaseDrag() {
    const previous = drag.current;
    drag.current = null;
    if (previous) current.current.onEditEnd?.();
    setActive(null);
    if (previous?.target.hasPointerCapture(previous.id))
      previous.target.releasePointerCapture(previous.id);
    if (engine.current)
      engine.current.setControlsEnabled(
        !failedRef.current && !blockedHandleGesture.current,
      );
  }

  // OrbitControls removes its document listener through canvas.getRootNode().
  // Dispose before React detaches the host, while that root is still document.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    let alive = true;
    let renderer: StructureRenderer | null = null;
    // The editor and exact controls are already mounted before Three is loaded.
    // An abandoned StrictMode effect must not install a canvas or report failure.
    void import("./threeStructureRenderer")
      .then(({ createThreeStructureRenderer }) => {
        if (!alive) return;
        renderer = createThreeStructureRenderer(element, {
          getState: () => current.current,
          isDragging: () => drag.current !== null,
          isHandleGestureBlocked: () => blockedHandleGesture.current,
          onLayout: setHandleLayout,
          onMoved: setMoved,
          onContextLost: () => {
            if (!alive) return;
            failedRef.current = true;
            releaseDrag();
            endKeyboardEdit();
            setActive(null);
            setReady(false);
            setFailed(true);
          },
          onContextRestored: () => {
            if (!alive) return;
            failedRef.current = false;
            setFailed(false);
            setReady(true);
          },
        });
        engine.current = renderer;
        failedRef.current = false;
        setFailed(false);
        setReady(true);
      })
      .catch(() => {
        if (!alive) return;
        failedRef.current = true;
        setReady(false);
        setFailed(true);
      });
    return () => {
      alive = false;
      // Unmount must close each active transaction exactly once, even while
      // the renderer module is still loading or its context is unavailable.
      const previous = drag.current;
      drag.current = null;
      if (previous) {
        current.current.onEditEnd?.();
        if (previous.target.hasPointerCapture(previous.id))
          previous.target.releasePointerCapture(previous.id);
      }
      endKeyboardEdit();
      renderer?.dispose();
      if (engine.current === renderer) engine.current = null;
    };
  }, []);

  useEffect(() => {
    // Freeze fit while dragging, preserving the handle's screen-to-nm mapping.
    // Refit once after release, while every intermediate mesh stays truthful.
    engine.current?.setValues(current.current.values, drag.current === null);
  }, [project, selectedIndex, active]);

  useEffect(() => {
    if (disabled || (drag.current && drag.current.layerIndex !== selectedIndex))
      releaseDrag();
    endKeyboardEdit();
    setFocused(null);
  }, [disabled, selectedIndex]);

  useEffect(() => {
    const releasePointer = (event: globalThis.PointerEvent) => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size === 0) {
        blockedHandleGesture.current = false;
        if (engine.current && !drag.current)
          engine.current.setControlsEnabled(!failedRef.current);
      }
      if (drag.current?.id === event.pointerId) releaseDrag();
    };
    window.addEventListener("pointerup", releasePointer);
    window.addEventListener("pointercancel", releasePointer);
    return () => {
      window.removeEventListener("pointerup", releasePointer);
      window.removeEventListener("pointercancel", releasePointer);
    };
  }, []);

  function open(sheet: StructureSheet) {
    if (!current.current.disabled)
      current.current.onOpen(
        sheet,
        ["ridge", "groove", "width", "height"].includes(sheet)
          ? current.current.selectedIndex
          : undefined,
      );
  }

  function trackPointer(event: PointerEvent<HTMLDivElement>) {
    pointers.current.add(event.pointerId);
    if (pointers.current.size > 1) {
      engine.current?.suppressPicks();
      if (drag.current) {
        blockedHandleGesture.current = true;
        releaseDrag();
      }
    }
  }

  function start(
    event: PointerEvent<HTMLDivElement>,
    dimension: StructureDimension,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (
      current.current.disabled ||
      failedRef.current ||
      drag.current ||
      event.button !== 0 ||
      pointers.current.size > 1 ||
      blockedHandleGesture.current ||
      !engine.current ||
      !host.current ||
      !visibleStructureDimensions(current.current.values).includes(dimension)
    )
      return;
    engine.current.suppressPicks();
    const mapping = engine.current.getDragMapping(dimension);
    if (!mapping) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    endKeyboardEdit();
    current.current.onEditStart?.();
    engine.current.setControlsEnabled(false);
    drag.current = {
      dimension,
      x: event.clientX,
      y: event.clientY,
      value: current.current.values[dimension],
      id: event.pointerId,
      ...mapping,
      target: event.currentTarget,
      layerIndex: current.current.selectedIndex,
    };
    setActive(dimension);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const gesture = drag.current;
    if (
      !gesture ||
      gesture.id !== event.pointerId ||
      current.current.disabled ||
      pointers.current.size > 1 ||
      blockedHandleGesture.current
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const [min, max] = dimensionRange(
      gesture.dimension,
      current.current.values,
    );
    const delta =
      (event.clientX - gesture.x) * gesture.dx +
      (event.clientY - gesture.y) * gesture.dy;
    const next = clamp(
      Math.round(gesture.value + delta * gesture.nmPerPixel),
      min,
      max,
    );
    if (next !== current.current.values[gesture.dimension])
      current.current.onChange(gesture.dimension, next);
  }

  function keys(
    event: KeyboardEvent<HTMLDivElement>,
    dimension: StructureDimension,
  ) {
    if (
      current.current.disabled ||
      !visibleStructureDimensions(current.current.values).includes(dimension)
    )
      return;
    const [min, max] = dimensionRange(dimension, current.current.values);
    if (
      [
        "ArrowRight",
        "ArrowUp",
        "ArrowLeft",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      const change =
        (["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1) *
        (event.shiftKey ? 10 : 1);
      const value =
        event.key === "Home"
          ? min
          : event.key === "End"
            ? max
            : clamp(current.current.values[dimension] + change, min, max);
      if (!keyboardEditing.current) {
        keyboardEditing.current = true;
        current.current.onEditStart?.();
      }
      current.current.onChange(dimension, value);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      open(dimension);
    }
  }

  useEffect(() => {
    onFallbackChange?.(failed);
  }, [failed, onFallbackChange]);

  const ridgeMode = structureGeometry(values).ridgeMode;
  const uniform = layer.geometry === "homogeneous";
  const stateNote =
    values.height === 0
      ? "Zero thickness: the selected layer has no volume."
      : uniform
        ? "Uniform film: material fills the whole selected layer."
        : values.width === 0
          ? "Zero width: the selected layer contains only groove material."
          : ridgeMode === "continuous"
            ? "Width equals pitch: a continuous ridge-material layer."
            : "Three finite repeats illustrate the infinite 1D stack.";

  return (
    <div className="object-editor" data-disabled={disabled}>
      <div
        className={`three-canvas ${active ? "is-editing" : ""}`}
        data-ready={ready}
        data-fallback={failed}
        data-loading={!ready && !failed}
        onPointerDownCapture={trackPointer}
      >
        <div className="webgl-host" ref={host} hidden={failed} />
        <details
          className="scene-guide"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.open = false;
              event.currentTarget
                .querySelector<HTMLElement>("summary")
                ?.focus();
            }
          }}
        >
          <summary title="View guide">
            View guide <span aria-hidden="true">ⓘ</span>
          </summary>
          <div tabIndex={0} role="region" aria-label="View guide details">
            {ready && !failed && (
              <label className="resize-toggle">
                <input
                  type="checkbox"
                  checked={showHandles}
                  onChange={(event) => setShowHandles(event.target.checked)}
                />{" "}
                Show drag handles
              </label>
            )}
            <p className="view-instructions">
              {!ready || failed
                ? "Tap a dimension or material to edit."
                : "Drag the scene to orbit; pinch or scroll to zoom. Drag a handle or tap a value to edit."}
            </p>
            {ready && !failed && (
              <p className="keyboard-note">
                Focus a handle and use arrow keys for 1 nm steps, or Shift for
                10 nm. Enter opens exact entry.
              </p>
            )}
            <p>
              Three repeats of the infinite 1D stack, ordered top to bottom.
              Width, layer thickness and pitch share one scale; substrate depth
              and groove length are schematic. Air grooves are visually empty;
              other groove materials fill their volumes. Colors identify layer
              numbers, not materials. A dark outline marks the selected layer;
              colors do not simulate lighting or absorption. Default optical
              constants are synthetic.
            </p>
          </div>
        </details>
        {failed ? (
          <div className="webgl-fallback" role="status">
            <strong>3D view is unavailable.</strong>
            <p>Exact dimension entry remains available below.</p>
            <button disabled={disabled} onClick={() => open("ridge")}>
              Edit materials
            </button>
          </div>
        ) : (
          <>
            {!ready && (
              <div className="webgl-fallback" role="status">
                <strong>Loading 3D view…</strong>
                <p>Exact dimension entry remains available below.</p>
              </div>
            )}
            {ready && showHandles && handleLayout.available && (
              <svg
                className="handle-leaders"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {dimensions.map((dimension) => {
                  const source = handleLayout.physical[dimension],
                    target = anchors[dimension];
                  return Math.hypot(source.x - target.x, source.y - target.y) >
                    0.01 ? (
                    <line
                      key={dimension}
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null;
                })}
              </svg>
            )}
            {ready &&
              showHandles &&
              handleLayout.available &&
              dimensions.map((dimension) => (
                <div
                  key={dimension}
                  className={`drag-target ${dimension}-handle ${active === dimension || focused === dimension ? "active" : ""}`}
                  role="slider"
                  aria-label={`Drag ${dimension === "height" ? "thickness" : dimension === "pitch" ? "shared pitch" : dimension}`}
                  aria-valuemin={dimensionRange(dimension, values)[0]}
                  aria-valuemax={dimensionRange(dimension, values)[1]}
                  aria-valuenow={values[dimension]}
                  aria-valuetext={`${values[dimension]} nanometers`}
                  aria-orientation={
                    dimension === "height" ? "vertical" : "horizontal"
                  }
                  aria-disabled={disabled}
                  tabIndex={disabled ? -1 : 0}
                  title={`Drag ${dimension}; tap its value below for exact entry`}
                  style={{
                    left: `${anchors[dimension].x}%`,
                    top: `${anchors[dimension].y}%`,
                    touchAction: "none",
                  }}
                  onFocus={() => setFocused(dimension)}
                  onBlur={() => {
                    setFocused(null);
                    endKeyboardEdit();
                  }}
                  onPointerEnter={() => setFocused(dimension)}
                  onPointerLeave={() => setFocused(null)}
                  onPointerDown={(event) => start(event, dimension)}
                  onPointerMove={move}
                  onPointerUp={(event) => {
                    if (drag.current?.id === event.pointerId) releaseDrag();
                  }}
                  onPointerCancel={(event) => {
                    if (drag.current?.id === event.pointerId) releaseDrag();
                  }}
                  onLostPointerCapture={(event) => {
                    if (drag.current?.id === event.pointerId) releaseDrag();
                  }}
                  onKeyDown={(event) => keys(event, dimension)}
                  onKeyUp={endKeyboardEdit}
                >
                  <span className="handle-dot">
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d={
                          dimension === "height"
                            ? "m3 5 3-3 3 3M3 7l3 3 3-3"
                            : "m5 3-3 3 3 3m2-6 3 3-3 3"
                        }
                      />
                    </svg>
                  </span>
                </div>
              ))}
            <div className="scene-selection" aria-live="polite">
              <i style={{ background: layerColor(selectedIndex) }} />
              Selected: Layer {selectedIndex + 1}{" "}
              {ready && <span>Drag to rotate</span>}
            </div>
            {(active || focused) && !disabled && (
              <div className="handle-name" role="status">
                {project.layers.length > 1 && (active || focused) === "height"
                  ? "thickness"
                  : active || focused}{" "}
                · {values[(active || focused)!]} nm
              </div>
            )}
            {moved && (
              <button
                className="reset-view"
                aria-label="Reset 3D view"
                onClick={() => engine.current?.reset()}
              >
                Reset view
              </button>
            )}
          </>
        )}
      </div>
      <div className="selected-layer-context">
        <span>Edit Layer {selectedIndex + 1}</span>
        <button disabled={disabled} onClick={onEditLayer}>
          Layer settings <span aria-hidden="true">↗</span>
        </button>
      </div>
      <div
        className="dimension-rail"
        aria-label="Structure dimensions"
        style={{
          gridTemplateColumns: `repeat(${dimensions.length}, minmax(0, 1fr))`,
        }}
      >
        {dimensions.map((dimension) => (
          <button
            key={dimension}
            disabled={disabled}
            className={
              active === dimension || focused === dimension ? "selected" : ""
            }
            onClick={() => open(dimension)}
            aria-label={`Set ${dimension === "pitch" ? "shared pitch" : `layer ${dimension === "height" ? "thickness" : "width"}`}, currently ${values[dimension]} nanometers`}
          >
            <span>
              {dimension === "pitch"
                ? "Shared pitch"
                : dimension === "width"
                  ? "Width"
                  : "Thickness"}
            </span>
            <strong>
              {values[dimension]}
              <small>nm</small>
            </strong>
            <small className="dimension-edit-hint">
              Edit <span aria-hidden="true">↗</span>
            </small>
          </button>
        ))}
      </div>
      {(values.height === 0 || (!uniform && ridgeMode !== "patterned")) && (
        <p className="scene-model-note" role="status">
          {stateNote}
        </p>
      )}
    </div>
  );
}
