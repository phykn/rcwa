import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Material, Project } from "./model";
import {
  dimensionRange,
  materialSummary,
  structureMaterialAppearance,
  visibleStructureDimensions,
  structureGeometry,
  structureHandlePosition,
  StructurePickGesture,
  structureValues,
} from "./structureGeometry";
import type {
  StructureDimension,
  StructureSheet,
  StructureValues,
} from "./structureGeometry";

import { layoutStructureHandles } from "./structureHandleLayout";

type Point = { x: number; y: number };
type Anchors = Record<StructureDimension, Point>;
type SceneGeometry = ReturnType<typeof structureGeometry>;
interface Engine {
  setValues: (values: StructureValues, refit?: boolean) => void;
  controls: OrbitControls;
  project: (point: THREE.Vector3) => Point;
  geometry: () => SceneGeometry;
  reset: () => void;
  suppressPicks: () => void;
}
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

function handlePoint(dimension: StructureDimension, geometry: SceneGeometry) {
  return new THREE.Vector3(...structureHandlePosition(dimension, geometry));
}

export function ThreeStructure({
  project,
  disabled = false,
  selectedLayer = 0,
  onSelectLayer,
  onChange,
  onOpen,
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
  onFallbackChange?: (failed: boolean) => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
}) {
  const values = structureValues(project, selectedLayer);
  const selectedIndex = values.selectedLayer ?? 0;
  const layer = project.layers[selectedIndex];
  const dimensions = visibleStructureDimensions(values);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
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
      engine.current.controls.enabled =
        !failedRef.current && !blockedHandleGesture.current;
  }

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      failedRef.current = true;
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0xfafafa, 0);
    renderer.shadowMap.enabled = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const canvas = renderer.domElement;
    canvas.setAttribute(
      "aria-label",
      "Interactive 3D layer stack. Drag to orbit, pinch or scroll to zoom. Keyboard arrows orbit, plus and minus zoom, and 0 resets. Click a layer to select and edit its material. Dimension controls follow the selected layer.",
    );
    canvas.setAttribute("role", "img");
    canvas.tabIndex = 0;
    element.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200);
    const initialDirection = new THREE.Vector3(6.4, 4.05, 7.6).normalize();
    camera.position.copy(initialDirection.clone().multiplyScalar(11));
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.enablePan = false;
    controls.minPolarAngle = 0.35;
    controls.maxPolarAngle = 1.2;
    controls.minAzimuthAngle = -0.9;
    controls.maxAzimuthAngle = 1.05;
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 0.6;
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_ROTATE,
    };
    controls.update();
    // Vertical swipes keep page scrolling. Horizontal orbit and a two-touch
    // pinch stay in the viewport; pointer cancellation never opens a material.
    canvas.style.touchAction = "pan-y";
    const group = new THREE.Group();
    scene.add(group);
    const materials = {
      edge: new THREE.LineBasicMaterial({
        color: 0x71717a,
        transparent: true,
        opacity: 0.19,
      }),
      dimension: new THREE.LineBasicMaterial({
        color: 0x6366f1,
        transparent: true,
        opacity: 0.62,
      }),
    };
    const sharedMaterials = new Set<THREE.Material>(Object.values(materials));
    const raycaster = new THREE.Raycaster();
    const pickGesture = new StructurePickGesture();
    let geometry = structureGeometry(current.current.values);
    let fitDistance = 11;
    let fitting = false;

    function projectPoint(point: THREE.Vector3): Point {
      const position = point.clone().project(camera);
      return { x: (position.x + 1) * 50, y: (1 - position.y) * 50 };
    }

    function redraw() {
      if (failedRef.current) return;
      camera.updateMatrixWorld();
      renderer.render(scene, camera);
      canvas.dataset.zoom = String(
        fitDistance / camera.position.distanceTo(controls.target),
      );
      const physical = {
        width: projectPoint(handlePoint("width", geometry)),
        height: projectPoint(handlePoint("height", geometry)),
        pitch: projectPoint(handlePoint("pitch", geometry)),
      };
      const viewportWidth = element!.clientWidth,
        viewportHeight = element!.clientHeight;
      const pixels = Object.fromEntries(
        Object.entries(physical).map(([key, point]) => [
          key,
          {
            x: (point.x * viewportWidth) / 100,
            y: (point.y * viewportHeight) / 100,
          },
        ]),
      ) as Anchors;
      const positioned = layoutStructureHandles(
        pixels,
        visibleStructureDimensions(current.current.values),
        viewportWidth,
        viewportHeight,
      );
      const anchors = positioned
        ? (Object.fromEntries(
            Object.entries(positioned).map(([key, point]) => [
              key,
              {
                x: (point.x * 100) / viewportWidth,
                y: (point.y * 100) / viewportHeight,
              },
            ]),
          ) as Anchors)
        : physical;
      setHandleLayout({ anchors, physical, available: positioned !== null });
    }

    function fitView(reset = false) {
      // Fit the actual bounds (including dimension lines and incident arrow).
      // No dimension is independently stretched, capped or given a fake minimum.
      const bounds = new THREE.Box3().setFromObject(group);
      const center = bounds.getCenter(new THREE.Vector3());
      const direction = reset
        ? initialDirection.clone()
        : camera.position.clone().sub(controls.target).normalize();
      const zoom = reset
        ? 1
        : fitDistance / camera.position.distanceTo(controls.target);
      camera.position.copy(center.clone().add(direction));
      camera.lookAt(center);
      camera.updateMatrixWorld();
      const inverseRotation = camera.quaternion.clone().invert();
      const tanVertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const tanHorizontal = tanVertical * camera.aspect;
      let nextDistance = 0;
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) {
            const corner = new THREE.Vector3(x, y, z)
              .sub(center)
              .applyQuaternion(inverseRotation);
            nextDistance = Math.max(
              nextDistance,
              Math.abs(corner.x) / (tanHorizontal * 0.82) + corner.z,
              Math.abs(corner.y) / (tanVertical * 0.75) + corner.z,
            );
          }
      fitDistance = nextDistance;
      controls.minDistance = fitDistance / 1.65;
      controls.maxDistance = fitDistance / 0.65;
      controls.target.copy(center);
      camera.position.copy(
        center.add(
          direction.multiplyScalar(fitDistance / clamp(zoom, 0.65, 1.65)),
        ),
      );
      fitting = true;
      controls.update();
      fitting = false;
      redraw();
    }

    function disposeGroup() {
      const geometries = new Set<THREE.BufferGeometry>();
      const ownedMaterials = new Set<THREE.Material>();
      for (const child of [...group.children]) {
        group.remove(child);
        child.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.geometry) geometries.add(mesh.geometry);
          if (mesh.material)
            for (const material of Array.isArray(mesh.material)
              ? mesh.material
              : [mesh.material])
              if (!sharedMaterials.has(material)) ownedMaterials.add(material);
        });
      }
      geometries.forEach((item) => item.dispose());
      ownedMaterials.forEach((item) => item.dispose());
    }

    function addBox(
      width: number,
      height: number,
      depth: number,
      x: number,
      y: number,
      material: THREE.Material,
      kind: "ridge" | "groove" | "substrate",
      layerIndex?: number,
    ) {
      if (width <= 0 || height <= 0 || depth <= 0) return;
      const box = new THREE.BoxGeometry(width, height, depth);
      const mesh = new THREE.Mesh(box, material);
      mesh.position.set(x, y, 0);
      mesh.userData.kind = kind;
      mesh.userData.layerIndex = layerIndex;
      group.add(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(box),
        materials.edge,
      );
      edges.position.copy(mesh.position);
      group.add(edges);
    }

    function line(points: THREE.Vector3[]) {
      group.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          materials.dimension,
        ),
      );
    }

    function setValues(next: StructureValues, refit = true) {
      disposeGroup();
      // Freeze scale and fit together during a handle gesture so every layer
      // remains physical while the screen-to-nanometer mapping stays stable.
      geometry = structureGeometry(next, refit ? undefined : geometry.scale);
      const { width, top, bottom, pitch, depth, span, substrateDepth } =
        geometry;
      const materialCache = new Map<string, THREE.MeshBasicMaterial>();
      function opticalMaterial(material: Material) {
        const appearance = structureMaterialAppearance(material);
        const key = `${appearance.color}:${appearance.opacity}`;
        let result = materialCache.get(key);
        if (!result) {
          result = new THREE.MeshBasicMaterial({
            color: appearance.color,
            transparent: appearance.opacity < 1,
            opacity: appearance.opacity,
            depthWrite: appearance.opacity === 1,
            toneMapped: false,
          });
          materialCache.set(key, result);
        }
        return result;
      }
      const project = current.current.project;
      addBox(
        span,
        substrateDepth,
        depth + 0.3,
        0,
        -substrateDepth / 2,
        opticalMaterial(project.substrate),
        "substrate",
      );
      for (const slab of geometry.layers) {
        const source = project.layers[slab.index];
        for (const region of slab.regions) {
          const material =
            region.kind === "groove" && source.geometry === "rectangle_1d"
              ? source.background
              : source.material;
          // Empty air grooves neither tint the ridges nor intercept picks
          // aimed at a visible surface behind them. Their complete physical
          // regions remain in geometry; the Groove inspector still edits air.
          if (
            region.kind === "groove" &&
            material.kind === "constant" &&
            material.n === 1 &&
            material.k === 0
          )
            continue;
          addBox(
            region.width,
            slab.height,
            depth,
            region.x,
            slab.center,
            opticalMaterial(material),
            region.kind,
            slab.index,
          );
        }
      }
      const selected = geometry.layers[geometry.selectedLayer];
      canvas.dataset.ridgeMode = geometry.ridgeMode;
      canvas.dataset.ridgeMeshes = String(
        selected?.regions.filter((region) => region.kind === "ridge").length ??
          0,
      );
      canvas.dataset.layerCount = String(geometry.layers.length);
      canvas.dataset.selectedLayer = String(geometry.selectedLayer);
      canvas.dataset.layerInterfaces = JSON.stringify(
        geometry.layers.map(({ top, bottom }) => ({ top, bottom })),
      );
      if (selected?.geometry === "rectangle_1d") {
        const widthZ = depth / 2 + 0.27;
        line([
          new THREE.Vector3(-width / 2, top, widthZ),
          new THREE.Vector3(width / 2, top, widthZ),
        ]);
        for (const x of [-width / 2, width / 2])
          line([
            new THREE.Vector3(x, top - 0.07, widthZ),
            new THREE.Vector3(x, top + 0.07, widthZ),
          ]);
      }
      const heightX =
        (selected?.geometry === "homogeneous" ? span : width) / 2 + 0.35;
      line([
        new THREE.Vector3(heightX, bottom, depth / 2 + 0.03),
        new THREE.Vector3(heightX, top, depth / 2 + 0.03),
      ]);
      for (const y of [bottom, top])
        line([
          new THREE.Vector3(heightX - 0.06, y, depth / 2 + 0.03),
          new THREE.Vector3(heightX + 0.06, y, depth / 2 + 0.03),
        ]);
      const pitchZ = depth / 2 + 0.47;
      line([
        new THREE.Vector3(0, 0.01, pitchZ),
        new THREE.Vector3(pitch, 0.01, pitchZ),
      ]);
      for (const x of [0, pitch])
        line([
          new THREE.Vector3(x, 0.01, pitchZ - 0.07),
          new THREE.Vector3(x, 0.01, pitchZ + 0.07),
        ]);
      const radians = THREE.MathUtils.degToRad(next.angle);
      const direction = new THREE.Vector3(
        Math.sin(radians),
        -Math.cos(radians),
        0,
      );
      const end = new THREE.Vector3(-0.13, geometry.totalHeight + 0.06, -0.35);
      const origin = end.clone().sub(direction.clone().multiplyScalar(0.91));
      group.add(
        new THREE.ArrowHelper(direction, origin, 0.87, 0xf59e0b, 0.1, 0.055),
      );
      if (refit) fitView();
      else redraw();
    }

    const onControlChange = () => {
      if (!fitting) {
        pickGesture.cameraChanged();
        setMoved(true);
      }
      redraw();
    };
    controls.addEventListener("change", onControlChange);
    const onPointerDown = (event: globalThis.PointerEvent) => {
      pickGesture.down(
        event.pointerId,
        event.clientX,
        event.clientY,
        event.button === 0,
      );
      if (
        drag.current ||
        blockedHandleGesture.current ||
        current.current.disabled
      )
        pickGesture.suppress();
    };
    const onPointerMove = (event: globalThis.PointerEvent) =>
      pickGesture.move(event.pointerId, event.clientX, event.clientY);
    const onPointerUp = (event: globalThis.PointerEvent) => {
      const canPick = pickGesture.up(
        event.pointerId,
        event.clientX,
        event.clientY,
      );
      if (!canPick || current.current.disabled || failedRef.current) return;
      const rect = canvas.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      const hit = raycaster
        .intersectObjects(group.children, true)
        .find((item) =>
          ["ridge", "groove", "substrate"].includes(item.object.userData.kind),
        );
      if (hit) {
        const { kind, layerIndex } = hit.object.userData;
        if (typeof layerIndex === "number")
          current.current.onSelectLayer?.(layerIndex);
        current.current.onOpen(kind, layerIndex);
      }
    };
    const onPointerCancel = (event: globalThis.PointerEvent) =>
      pickGesture.cancel(event.pointerId);
    // Capture listeners classify the gesture before OrbitControls consumes it.
    canvas.addEventListener("pointerdown", onPointerDown, true);
    canvas.addEventListener("pointermove", onPointerMove, true);
    canvas.addEventListener("pointerup", onPointerUp, true);
    canvas.addEventListener("pointercancel", onPointerCancel, true);
    canvas.addEventListener("lostpointercapture", onPointerCancel);

    const reset = () => {
      if (failedRef.current) return;
      fitView(true);
      setMoved(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
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
        reset();
        return;
      }
      const offset = camera.position.clone().sub(controls.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      if (["+", "=", "-"].includes(event.key)) {
        spherical.radius = clamp(
          spherical.radius * (event.key === "-" ? 1.1 : 1 / 1.1),
          controls.minDistance,
          controls.maxDistance,
        );
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        spherical.theta = clamp(
          spherical.theta + (event.key === "ArrowLeft" ? -0.1 : 0.1),
          controls.minAzimuthAngle,
          controls.maxAzimuthAngle,
        );
      } else {
        spherical.phi = clamp(
          spherical.phi + (event.key === "ArrowUp" ? -0.1 : 0.1),
          controls.minPolarAngle,
          controls.maxPolarAngle,
        );
      }
      camera.position.copy(
        controls.target
          .clone()
          .add(new THREE.Vector3().setFromSpherical(spherical)),
      );
      controls.update();
      setMoved(true);
      redraw();
    };
    canvas.addEventListener("keydown", onKeyDown);

    const onContextLost = (event: Event) => {
      event.preventDefault();
      failedRef.current = true;
      controls.enabled = false;
      pickGesture.suppress();
      releaseDrag();
      endKeyboardEdit();
      setActive(null);
      setReady(false);
      setFailed(true);
    };
    const onContextRestored = () => {
      failedRef.current = false;
      controls.enabled = !blockedHandleGesture.current;
      setFailed(false);
      setReady(true);
      setValues(current.current.values);
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    const resize = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      camera.aspect = element.clientWidth / element.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(element.clientWidth, element.clientHeight);
      fitView();
    });
    resize.observe(element);
    engine.current = {
      setValues,
      controls,
      project: projectPoint,
      geometry: () => geometry,
      reset,
      suppressPicks: () => pickGesture.suppress(),
    };
    failedRef.current = false;
    setValues(current.current.values);
    setReady(true);
    return () => {
      // Unmount and context loss must close an in-flight edit exactly once.
      if (drag.current) {
        drag.current = null;
        current.current.onEditEnd?.();
      }
      endKeyboardEdit();
      resize.disconnect();
      controls.removeEventListener("change", onControlChange);
      controls.dispose();
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("pointermove", onPointerMove, true);
      canvas.removeEventListener("pointerup", onPointerUp, true);
      canvas.removeEventListener("pointercancel", onPointerCancel, true);
      canvas.removeEventListener("lostpointercapture", onPointerCancel);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      disposeGroup();
      sharedMaterials.forEach((material) => material.dispose());
      renderer.dispose();
      canvas.remove();
      engine.current = null;
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
          engine.current.controls.enabled = !failedRef.current;
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
    const geometry = engine.current.geometry();
    const startPoint = handlePoint(dimension, geometry);
    const delta =
      dimension === "height"
        ? new THREE.Vector3(0, 0.1, 0)
        : new THREE.Vector3(0.1, 0, 0);
    const from = engine.current.project(startPoint);
    const to = engine.current.project(startPoint.clone().add(delta));
    const rect = host.current.getBoundingClientRect();
    const screenX = ((to.x - from.x) * rect.width) / 100;
    const screenY = ((to.y - from.y) * rect.height) / 100;
    const length = Math.hypot(screenX, screenY);
    if (length < 0.001) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    endKeyboardEdit();
    current.current.onEditStart?.();
    engine.current.controls.enabled = false;
    drag.current = {
      dimension,
      x: event.clientX,
      y: event.clientY,
      value: current.current.values[dimension],
      id: event.pointerId,
      dx: screenX / length,
      dy: screenY / length,
      nmPerPixel:
        (0.1 / (geometry.scale * length)) * (dimension === "width" ? 2 : 1),
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
            <p className="view-instructions">
              {failed
                ? "Tap a dimension or material to edit."
                : "Drag the scene to orbit; pinch or scroll to zoom. Drag a handle or tap a value to edit."}
            </p>
            {!failed && (
              <p className="keyboard-note">
                Focus a handle and use arrow keys for 1 nm steps, or Shift for
                10 nm. Enter opens exact entry.
              </p>
            )}
            <p>
              Three repeats of the infinite 1D stack, ordered top to bottom.
              Width, layer thickness and pitch share one scale; substrate depth
              and groove length are schematic. Air grooves are visually empty;
              other groove materials fill their volumes. Colors identify
              materials and do not simulate lighting or absorption. Default
              optical constants are synthetic.
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
            {handleLayout.available && (
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
            {handleLayout.available &&
              dimensions.map((dimension) => (
                <div
                  key={dimension}
                  className={`drag-target ${dimension}-handle ${active === dimension || focused === dimension ? "active" : ""}`}
                  role="slider"
                  aria-label={`Drag ${dimension}`}
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
            <button
              className="scene-material"
              disabled={disabled}
              aria-label={`Edit ${uniform ? "layer" : "ridge"} material: ${layer.material.name}, ${materialSummary(layer.material)}`}
              onClick={() => open("ridge")}
            >
              <i
                style={{
                  background: structureMaterialAppearance(layer.material).color,
                }}
              />
              <span>
                {uniform ? "Film" : "Ridge"}
                {project.layers.length > 1
                  ? ` · Layer ${selectedIndex + 1}`
                  : ""}
              </span>
              <small>{materialSummary(layer.material)}</small>
            </button>
            <button
              className="scene-substrate"
              disabled={disabled}
              aria-label={`Edit substrate material: ${project.substrate.name}, ${materialSummary(project.substrate)}`}
              onClick={() => open("substrate")}
            >
              Substrate <span>{materialSummary(project.substrate)}</span>
            </button>
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
            aria-label={`Set ${dimension === "pitch" ? "pattern pitch" : `${uniform ? "layer" : "ridge"} ${dimension}`}, currently ${values[dimension]} nanometers`}
          >
            <span>
              {dimension === "pitch"
                ? "Pitch"
                : dimension === "width"
                  ? "Width"
                  : project.layers.length > 1 || uniform
                    ? "Thickness"
                    : "Height"}
            </span>
            <strong>
              {values[dimension]}
              <small>nm</small>
            </strong>
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
