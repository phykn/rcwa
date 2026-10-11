import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  buildStructureGeometry2D,
  structureScale2D,
  illuminationDirection2D,
  physicalToScene2D,
} from "./structureGeometry2d";
import type { StructureGeometryProject2D } from "./structureGeometry2d";
import { StructurePickGesture } from "./structureGeometry";
import { formatDimension2D, exactDimensionText2D } from "./DimensionEditor2D";
import "./structure2d.css";
import { layerColor } from "./layerColors";

function StructureCanvas2D({
  project,
  selected,
  cutaway,
  onSelect,
  disabled,
}: {
  project: StructureViewProject2D;
  selected: number;
  cutaway: boolean;
  onSelect: (layer: number) => void;
  disabled: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef({ project, selected, cutaway, onSelect, disabled });
  current.current = { project, selected, cutaway, onSelect, disabled };
  const update = useRef<(() => void) | null>(null);
  const [failed, setFailed] = useState(false);
  const failedRef = useRef(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    failedRef.current = false;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      failedRef.current = true;
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0xf2f5fa, 1);
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "3D structure. Drag to rotate, pinch to zoom. Vertical swipes scroll the page. Tap a layer to select it. Keyboard arrows rotate, plus and minus zoom, and 0 resets. Width, Thickness, and Shared pitch controls follow below.",
    );
    element.append(canvas);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 200);
    camera.position.set(6.6, 5.8, -7.7);
    const controls = new OrbitControls(camera, canvas);
    canvas.style.touchAction = "pan-y";
    controls.enablePan = false;
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_ROTATE,
    };
    controls.minDistance = 4;
    controls.maxDistance = 24;
    controls.maxPolarAngle = Math.PI * 0.92;
    const group = new THREE.Group();
    scene.add(group);
    const raycaster = new THREE.Raycaster();
    const gesture = new StructurePickGesture();
    const point = new THREE.Vector2();
    const picks: THREE.Mesh[] = [];
    const axisLabels = (["X", "Y", "Z"] as const).map((name) => {
      const label = document.createElement("span");
      label.textContent = name;
      label.className = "s2-projected-axis";
      label.setAttribute("aria-hidden", "true");
      element.append(label);
      return { label, point: new THREE.Vector3() };
    });
    let bounds = new THREE.Box3();
    let boundsKey = "";
    const render = () => {
      if (failedRef.current) return;
      renderer.render(scene, camera);
      canvas.dataset.cameraState = JSON.stringify({
        position: camera.position.toArray(),
        target: controls.target.toArray(),
      });
      if (!bounds.isEmpty()) {
        const pixels: { x: number; y: number }[] = [];
        for (const x of [bounds.min.x, bounds.max.x])
          for (const y of [bounds.min.y, bounds.max.y])
            for (const z of [bounds.min.z, bounds.max.z]) {
              const p = new THREE.Vector3(x, y, z).project(camera);
              pixels.push({
                x: ((p.x + 1) * element.clientWidth) / 2,
                y: ((1 - p.y) * element.clientHeight) / 2,
              });
            }
        canvas.dataset.projectedBounds = JSON.stringify({
          left: Math.min(...pixels.map((p) => p.x)),
          right: Math.max(...pixels.map((p) => p.x)),
          top: Math.min(...pixels.map((p) => p.y)),
          bottom: Math.max(...pixels.map((p) => p.y)),
        });
      }
      for (const { label, point } of axisLabels) {
        const projected = point.clone().project(camera);
        label.style.left = `${((projected.x + 1) * element.clientWidth) / 2}px`;
        label.style.top = `${((1 - projected.y) * element.clientHeight) / 2}px`;
        label.hidden = projected.z < -1 || projected.z > 1;
      }
    };
    const dispose = () => {
      group.traverse((node) => {
        if (node instanceof THREE.Mesh || node instanceof THREE.Line) {
          node.geometry.dispose();
          (Array.isArray(node.material)
            ? node.material
            : [node.material]
          ).forEach((m) => m.dispose());
        }
      });
      group.clear();
      picks.length = 0;
    };
    function fit() {
      if (
        !element ||
        bounds.isEmpty() ||
        !element.clientWidth ||
        !element.clientHeight
      )
        return;
      const center = bounds.getCenter(new THREE.Vector3());
      const direction = camera.position
        .clone()
        .sub(controls.target)
        .normalize();
      const corners: THREE.Vector3[] = [];
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z])
            corners.push(new THREE.Vector3(x, y, z));
      const left = -1 + 36 / element.clientWidth;
      const right = 1 - 36 / element.clientWidth;
      const top = 1 - 100 / element.clientHeight;
      const bottom = -1 + 64 / element.clientHeight;
      function fits(distance: number) {
        camera.position.copy(center).addScaledVector(direction, distance);
        camera.lookAt(center);
        camera.updateMatrixWorld();
        return corners.every((corner) => {
          const p = corner.clone().project(camera);
          return (
            p.x >= left &&
            p.x <= right &&
            p.y >= bottom &&
            p.y <= top &&
            p.z >= -1 &&
            p.z <= 1
          );
        });
      }
      let low = 0.1,
        high = 60;
      for (let i = 0; i < 30; i++) {
        const middle = (low + high) / 2;
        if (fits(middle)) high = middle;
        else low = middle;
      }
      controls.maxDistance = Math.max(24, high * 2);
      fits(high * 1.015);
      controls.target.copy(center);
      controls.update();
    }
    const rebuild = () => {
      if (failedRef.current) return;
      dispose();
      const {
        project: p,
        selected: active,
        cutaway: clipped,
      } = current.current;
      const geometry = buildStructureGeometry2D(p, { cutaway: clipped });
      const total = p.layers.reduce(
        (sum, layer) => sum + layer.thickness_nm,
        0,
      );
      // A single common scale preserves all physical aspect ratios.
      const scale = structureScale2D(p);
      function box(
        size: { x: number; y: number; z: number },
        center: { x: number; y: number; z: number },
        color: string,
        index?: number,
        background = false,
      ) {
        if (!size.x || !size.y || !size.z) return;
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(size.x * scale, size.z * scale, size.y * scale),
          new THREE.MeshBasicMaterial({ color }),
        );
        mesh.position.set(
          center.x * scale,
          (center.z - total / 2) * scale,
          -center.y * scale,
        );
        mesh.userData.layerIndex = index;
        mesh.userData.role = background ? "background" : "material";
        group.add(mesh);
        if (index !== undefined) picks.push(mesh);
        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({
            color:
              index === active ? "#173b50" : background ? "#9caab9" : "#728296",
            transparent: true,
            opacity: index === active ? 0.94 : 0.48,
          }),
        );
        outline.position.copy(mesh.position);
        group.add(outline);
      }
      box(
        { x: p.period_nm * 3 + 10, y: p.period_y_nm * 3 + 10, z: 12 },
        { x: 0, y: 0, z: -6 },
        "#c2cad8",
      );
      for (const region of geometry.regions) {
        // Only actual air is empty. Low-index inclusions remain solid material.
        const air =
          region.material.kind === "constant" &&
          region.material.n === 1 &&
          region.material.k === 0;
        if (air) continue;
        box(
          region.size,
          region.center,
          region.role === "background"
            ? "#dde4ec"
            : layerColor(region.layerIndex),
          region.layerIndex,
          region.role === "background",
        );
      }
      const selectedLayer = p.layers[active];
      const selectedSlab = geometry.layers[active];
      if (
        clipped &&
        selectedLayer &&
        selectedLayer.geometry !== "homogeneous" &&
        selectedLayer.thickness_nm > 0
      ) {
        const mid = (selectedSlab.top + selectedSlab.bottom) / 2;
        const selectedX =
          selectedLayer.geometry === "rectangle_2d"
            ? selectedLayer.cd_x_nm
            : selectedLayer.cd_nm;
        const selectedY =
          selectedLayer.geometry === "rectangle_2d" ? selectedLayer.cd_y_nm : 0;
        const drawRuler = (axis: "x" | "y", width: number, repeat: number) => {
          if (width <= 0) return;
          const physical = (v: number, dz = 0) =>
            new THREE.Vector3(
              (axis === "x" ? v : 0.6) * scale,
              (mid + dz - total / 2) * scale,
              -(axis === "y" ? v : 0.6) * scale,
            );
          const lo = repeat - width / 2,
            hi = repeat + width / 2;
          const tick = Math.min(5, selectedLayer.thickness_nm / 8);
          const points = [
            physical(lo),
            physical(hi),
            physical(lo, -tick),
            physical(lo, tick),
            physical(hi, -tick),
            physical(hi, tick),
          ];
          group.add(
            new THREE.LineSegments(
              new THREE.BufferGeometry().setFromPoints(points),
              new THREE.LineBasicMaterial({ color: 0x172f46 }),
            ),
          );
        };
        drawRuler("x", selectedX, p.period_nm);
        if (selectedLayer.geometry === "rectangle_2d")
          drawRuler("y", selectedY, p.period_y_nm);
      }
      const incident = illuminationDirection2D(
        p.illumination.angle_deg,
        p.illumination.azimuth_deg,
      );
      const mapped = physicalToScene2D(incident);
      const direction = new THREE.Vector3(mapped.x, mapped.y, mapped.z);
      const end = new THREE.Vector3(
        -p.period_nm * 0.7 * scale,
        (total * scale) / 2 + 0.1,
        p.period_y_nm * 0.7 * scale,
      );
      const arrow = new THREE.ArrowHelper(
        direction,
        end.clone().sub(direction.clone().multiplyScalar(0.75)),
        0.75,
        0xd97706,
        0.12,
        0.07,
      );
      group.add(arrow);
      const axesOrigin = new THREE.Vector3(
        p.period_nm * 1.5 * scale,
        (-total * scale) / 2 - 0.02,
        -p.period_y_nm * 1.5 * scale,
      );
      group.add(
        new THREE.ArrowHelper(
          new THREE.Vector3(1, 0, 0),
          axesOrigin,
          0.5,
          0x334155,
          0.06,
          0.04,
        ),
      );
      group.add(
        new THREE.ArrowHelper(
          new THREE.Vector3(0, 0, -1),
          axesOrigin,
          0.5,
          0x334155,
          0.06,
          0.04,
        ),
      );
      group.add(
        new THREE.ArrowHelper(
          new THREE.Vector3(0, 1, 0),
          axesOrigin,
          0.5,
          0x334155,
          0.06,
          0.04,
        ),
      );
      // One actual repeat cell, on the uncut top surface; this is a ruler,
      // not an additional physical slab or a change to the solver domain.
      const cellPoints = [
        [-1.5 * p.period_nm, -0.5 * p.period_y_nm],
        [-0.5 * p.period_nm, -0.5 * p.period_y_nm],
        [-0.5 * p.period_nm, 0.5 * p.period_y_nm],
        [-1.5 * p.period_nm, 0.5 * p.period_y_nm],
        [-1.5 * p.period_nm, -0.5 * p.period_y_nm],
      ].map(
        ([x, y]) =>
          new THREE.Vector3(x * scale, (total * scale) / 2 + 0.012, -y * scale),
      );
      const cell = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(cellPoints),
        new THREE.LineDashedMaterial({
          color: 0x4f46e5,
          dashSize: 0.045,
          gapSize: 0.035,
        }),
      );
      cell.computeLineDistances();
      group.add(cell);
      axisLabels[0].point.copy(axesOrigin).add(new THREE.Vector3(0.62, 0, 0));
      axisLabels[1].point.copy(axesOrigin).add(new THREE.Vector3(0, 0, -0.62));
      axisLabels[2].point.copy(axesOrigin).add(new THREE.Vector3(0, 0.62, 0));
      bounds = new THREE.Box3().setFromObject(group);
      axisLabels.forEach(({ point }) => bounds.expandByPoint(point));
      const nextBoundsKey = JSON.stringify([
        bounds.min.toArray(),
        bounds.max.toArray(),
      ]);
      if (nextBoundsKey !== boundsKey) {
        boundsKey = nextBoundsKey;
        fit();
      }
      canvas.dataset.coordinateConvention =
        "physical(x,y,z) maps to scene(x,z,-y)";
      canvas.dataset.ready = "true";
      canvas.dataset.selectedLayer = String(active);
      canvas.dataset.regionCount = String(geometry.regions.length);
      canvas.dataset.renderedRegionCount = String(picks.length);
      canvas.dataset.renderedMeshes = JSON.stringify(
        picks.map((mesh) => ({
          layerIndex: mesh.userData.layerIndex,
          role: mesh.userData.role,
          position: mesh.position.toArray(),
          size:
            mesh.geometry instanceof THREE.BoxGeometry
              ? [
                  mesh.geometry.parameters.width,
                  mesh.geometry.parameters.height,
                  mesh.geometry.parameters.depth,
                ]
              : null,
        })),
      );
      canvas.dataset.physicalScale = String(scale);
      canvas.dataset.physicalBounds = JSON.stringify(geometry.bounds);
      canvas.dataset.layerInterfaces = JSON.stringify(geometry.layerInterfaces);
      canvas.dataset.incidentDirection = JSON.stringify(incident);
      canvas.dataset.cutaway = String(clipped);
      canvas.dataset.geometry = JSON.stringify(
        geometry.regions.map(({ center, size, layerIndex, role }) => ({
          center,
          size,
          layerIndex,
          role,
        })),
      );
      render();
    };
    update.current = rebuild;
    const resize = () => {
      if (failedRef.current) return;
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      fit();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const changed = () => {
      gesture.cameraChanged();
      render();
    };
    controls.addEventListener("change", changed);
    const down = (event: PointerEvent) => {
      gesture.down(
        event.pointerId,
        event.clientX,
        event.clientY,
        event.button === 0,
      );
      if (current.current.disabled || failedRef.current) gesture.suppress();
    };
    const move = (event: PointerEvent) =>
      gesture.move(event.pointerId, event.clientX, event.clientY);
    const cancel = (event: PointerEvent) => gesture.cancel(event.pointerId);
    const up = (event: PointerEvent) => {
      const canPick = gesture.up(event.pointerId, event.clientX, event.clientY);
      if (!canPick || current.current.disabled || failedRef.current) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      point.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(point, camera);
      const hit = raycaster.intersectObjects(picks)[0];
      if (hit) current.current.onSelect(hit.object.userData.layerIndex);
    };
    const key = (event: KeyboardEvent) => {
      if (
        failedRef.current ||
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "+",
          "=",
          "-",
          "0",
        ].includes(event.key)
      )
        return;
      event.preventDefault();
      if (event.key === "0") {
        camera.position
          .copy(controls.target)
          .add(new THREE.Vector3(6.6, 5.8, -7.7));
        fit();
        render();
        return;
      }
      const spherical = new THREE.Spherical().setFromVector3(
        camera.position.clone().sub(controls.target),
      );
      if (event.key === "ArrowLeft") spherical.theta -= 0.12;
      if (event.key === "ArrowRight") spherical.theta += 0.12;
      if (event.key === "ArrowUp")
        spherical.phi = Math.max(0.1, spherical.phi - 0.12);
      if (event.key === "ArrowDown")
        spherical.phi = Math.min(Math.PI - 0.1, spherical.phi + 0.12);
      if (event.key === "+" || event.key === "=") spherical.radius *= 0.9;
      if (event.key === "-") spherical.radius *= 1.1;
      spherical.radius = Math.max(
        controls.minDistance,
        Math.min(controls.maxDistance, spherical.radius),
      );
      spherical.phi = Math.max(
        0.1,
        Math.min(controls.maxPolarAngle, spherical.phi),
      );
      camera.position
        .copy(controls.target)
        .add(new THREE.Vector3().setFromSpherical(spherical));
      controls.update();
      render();
    };
    // Capture classifies a stationary tap before OrbitControls changes state.
    // Native pan-y preserves vertical scrolling; cancellation cannot pick a layer.
    canvas.addEventListener("pointerdown", down, true);
    canvas.addEventListener("pointermove", move, true);
    canvas.addEventListener("pointerup", up, true);
    canvas.addEventListener("pointercancel", cancel, true);
    canvas.addEventListener("lostpointercapture", cancel);
    canvas.addEventListener("keydown", key);
    const contextLost = (event: Event) => {
      event.preventDefault();
      failedRef.current = true;
      controls.enabled = false;
      gesture.suppress();
      canvas.dataset.ready = "false";
      canvas.tabIndex = -1;
      canvas.setAttribute("aria-hidden", "true");
      axisLabels.forEach(({ label }) => {
        label.hidden = true;
      });
      setFailed(true);
    };
    const contextRestored = () => {
      failedRef.current = false;
      controls.enabled = true;
      canvas.tabIndex = 0;
      canvas.removeAttribute("aria-hidden");
      setFailed(false);
      rebuild();
      resize();
    };
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
    rebuild();
    resize();
    return () => {
      update.current = null;
      observer.disconnect();
      controls.removeEventListener("change", changed);
      controls.dispose();
      dispose();
      canvas.removeEventListener("pointerdown", down, true);
      canvas.removeEventListener("pointermove", move, true);
      canvas.removeEventListener("pointerup", up, true);
      canvas.removeEventListener("pointercancel", cancel, true);
      canvas.removeEventListener("lostpointercapture", cancel);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      canvas.removeEventListener("keydown", key);
      renderer.dispose();
      canvas.remove();
      axisLabels.forEach(({ label }) => label.remove());
    };
  }, []);
  useEffect(() => {
    update.current?.();
  }, [project, selected, cutaway]);
  return (
    <>
      <div className="s2-webgl" ref={host} data-fallback={failed} />
      {failed && (
        <div className="s2-fallback" role="status">
          <strong>3D view is unavailable.</strong>
          <p>
            Choose a layer above. Width, Thickness, and Shared pitch remain
            editable below.
          </p>
        </div>
      )}
    </>
  );
}

export interface StructureViewProject2D extends StructureGeometryProject2D {
  readonly illumination: {
    readonly angle_deg: number;
    readonly azimuth_deg: number;
  };
}
export interface ThreeStructure2DProps {
  project: StructureViewProject2D;
  selectedLayer: number;
  onSelectLayer: (layerIndex: number) => void;
  disabled?: boolean;
}

/** Accepted physical 3×3 scene; view choices never change project inputs. */
export function ThreeStructure2D({
  project,
  selectedLayer,
  onSelectLayer,
  disabled = false,
}: ThreeStructure2DProps) {
  const [cutaway, setCutaway] = useState(true);
  return (
    <div className="s2-scene" aria-label="Structure view">
      <StructureCanvas2D
        project={project}
        selected={selectedLayer}
        cutaway={cutaway}
        onSelect={onSelectLayer}
        disabled={disabled}
      />
      <div className="s2-view-control">
        <label>
          <span>View</span>
          <select
            aria-label="Structure view"
            value={cutaway ? "cutaway" : "full"}
            onChange={(event) => setCutaway(event.target.value === "cutaway")}
          >
            <option value="full">Full stack</option>
            <option value="cutaway">Cutaway</option>
          </select>
        </label>
        {cutaway && <span className="s2-cut-note">Corner hidden</span>}
      </div>
      <details
        className="s2-guide"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}
      >
        <summary aria-label="View guide">ⓘ</summary>
        <div tabIndex={0} role="region" aria-label="View guide details">
          <p>
            A corner is hidden in Cutaway to show inner layers; your structure
            is unchanged.
          </p>
          <p>
            X and Y stay fixed to the structure. Width is one pattern's size;
            pitch is its repeat spacing. The dashed outline marks one repeat
            cell.
          </p>
          <p>
            Colors identify layers from top to bottom; pale gray is background
            material. The gray base is the substrate, shown at a schematic
            depth.
          </p>
        </div>
      </details>
      <div className="s2-selection" aria-live="polite">
        <span
          style={{ background: layerColor(selectedLayer) }}
          aria-hidden="true"
        />
        Selected: Layer {selectedLayer + 1}
      </div>
    </div>
  );
}

export type DimensionCardKind2D = "width" | "thickness" | "pitch";
export interface DimensionCards2DProps {
  project: StructureGeometryProject2D;
  selectedLayer: number;
  onEdit: (kind: DimensionCardKind2D) => void;
  disabled?: boolean;
}
function DimensionValue2D({
  axis,
  value,
}: {
  axis?: "X" | "Y";
  value: number;
}) {
  const display = formatDimension2D(value);
  return (
    <strong
      className="s2-value"
      data-size={
        display.length > 7 ? "long" : display.length > 5 ? "compact" : "normal"
      }
      title={`${exactDimensionText2D(value)} nm (exact value)`}
    >
      {axis && <small>{axis}</small>} <span>{display}</span>
      <small>nm</small>
    </strong>
  );
}

/** Place immediately below the parent's Edit Layer N / Layer settings row. */
export function DimensionCards2D({
  project,
  selectedLayer,
  onEdit,
  disabled = false,
}: DimensionCards2DProps) {
  const layer = project.layers[selectedLayer];
  if (!layer) return null;
  const widthX =
    layer.geometry === "rectangle_2d"
      ? layer.cd_x_nm
      : layer.geometry === "rectangle_1d"
        ? layer.cd_nm
        : 0;
  const widthY = layer.geometry === "rectangle_2d" ? layer.cd_y_nm : null;
  const widthLabel = `Edit Layer ${selectedLayer + 1} width: X ${exactDimensionText2D(widthX)} nanometers${widthY !== null ? `, Y ${exactDimensionText2D(widthY)} nanometers` : ""}`;
  return (
    <>
      <div
        className="s2-dimensions"
        data-uniform={layer.geometry === "homogeneous"}
        aria-label={`Edit Layer ${selectedLayer + 1} dimensions`}
      >
        {layer.geometry !== "homogeneous" && (
          <button
            type="button"
            disabled={disabled}
            aria-label={widthLabel}
            onClick={() => onEdit("width")}
          >
            <span>Width</span>
            <DimensionValue2D axis="X" value={widthX} />
            {widthY !== null && <DimensionValue2D axis="Y" value={widthY} />}
            <em>Edit ↗</em>
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          aria-label={`Edit Layer ${selectedLayer + 1} thickness: ${exactDimensionText2D(layer.thickness_nm)} nanometers`}
          onClick={() => onEdit("thickness")}
        >
          <span>Thickness</span>
          <DimensionValue2D value={layer.thickness_nm} />
          <em>Edit ↗</em>
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Edit shared pitch: X ${exactDimensionText2D(project.period_nm)} nanometers, Y ${exactDimensionText2D(project.period_y_nm)} nanometers`}
          onClick={() => onEdit("pitch")}
        >
          <span>Shared pitch</span>
          <DimensionValue2D axis="X" value={project.period_nm} />
          <DimensionValue2D axis="Y" value={project.period_y_nm} />
          <em>Edit ↗</em>
        </button>
      </div>
      {layer.thickness_nm === 0 && (
        <p className="s2-model-note" role="status">
          Layer {selectedLayer + 1} has zero thickness and no visible volume.
        </p>
      )}
      {layer.thickness_nm > 0 &&
        layer.geometry !== "homogeneous" &&
        (widthX === 0 || widthY === 0) && (
          <p className="s2-model-note" role="status">
            Layer {selectedLayer + 1} has zero pattern width; its background
            fills the layer.
          </p>
        )}
    </>
  );
}
