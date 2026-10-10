import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Project } from "./model";
import {
  dimensionRange,
  materialSummary,
  structureDimensions,
  structureGeometry,
  StructurePickGesture,
  structureValues,
} from "./structureGeometry";
import type {
  StructureDimension,
  StructureSheet,
  StructureValues,
} from "./structureGeometry";

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
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const defaultAnchors: Anchors = {
  width: { x: 62, y: 48 },
  height: { x: 48, y: 31 },
  pitch: { x: 71, y: 79 },
};

function handlePoint(dimension: StructureDimension, geometry: SceneGeometry) {
  if (dimension === "height")
    return new THREE.Vector3(0, geometry.height, -0.08);
  if (dimension === "width")
    return new THREE.Vector3(
      geometry.width / 2,
      geometry.height * 0.52,
      geometry.depth / 2,
    );
  return new THREE.Vector3(geometry.pitch, 0, geometry.depth / 2 + 0.47);
}

export function ThreeStructure({
  project,
  disabled = false,
  onChange,
  onOpen,
}: {
  project: Project;
  disabled?: boolean;
  onChange: (dimension: StructureDimension, value: number) => void;
  onOpen: (sheet: StructureSheet) => void;
}) {
  const values = structureValues(project);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  // Native Three.js events always consult current props, including an edit lock
  // that can arrive halfway through a pointer gesture.
  const current = useRef({ values, disabled, onChange, onOpen });
  current.current = { values, disabled, onChange, onOpen };
  const drag = useRef<DimensionDrag | null>(null);
  const pointers = useRef(new Set<number>());
  const blockedHandleGesture = useRef(false);
  const failedRef = useRef(false);
  const [anchors, setAnchors] = useState<Anchors>(defaultAnchors);
  const [active, setActive] = useState<StructureDimension | null>(null);
  const [focused, setFocused] = useState<StructureDimension | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [moved, setMoved] = useState(false);

  function releaseDrag() {
    const previous = drag.current;
    drag.current = null;
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
    renderer.setClearColor(0xf1f5ed, 0);
    renderer.shadowMap.enabled = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const canvas = renderer.domElement;
    canvas.setAttribute(
      "aria-label",
      "Interactive 3D grating. Drag to orbit, pinch or scroll to zoom. Keyboard arrows orbit, plus and minus zoom, and 0 resets. Dimension controls follow the view.",
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
    scene.add(new THREE.AmbientLight(0xf8fff0, 0.65));
    scene.add(new THREE.HemisphereLight(0xfffcf2, 0x65794f, 0.6));
    const keyLight = new THREE.DirectionalLight(0xfffcf0, 3.8);
    keyLight.position.set(-3.5, 7, 3);
    scene.add(keyLight);
    const fill = new THREE.DirectionalLight(0xd6e9c5, 0.7);
    fill.position.set(5, 2, -4);
    scene.add(fill);

    const group = new THREE.Group();
    scene.add(group);
    const materials = {
      active: new THREE.MeshStandardMaterial({
        color: 0x2d6552,
        roughness: 0.42,
        metalness: 0.025,
      }),
      context: new THREE.MeshStandardMaterial({
        color: 0xb2c5a8,
        roughness: 0.65,
      }),
      base: new THREE.MeshStandardMaterial({ color: 0xccd9bc, roughness: 0.8 }),
      edge: new THREE.LineBasicMaterial({
        color: 0x36553b,
        transparent: true,
        opacity: 0.19,
      }),
      dimension: new THREE.LineBasicMaterial({
        color: 0x6f8e57,
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
      setAnchors({
        width: projectPoint(handlePoint("width", geometry)),
        height: projectPoint(handlePoint("height", geometry)),
        pitch: projectPoint(handlePoint("pitch", geometry)),
      });
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
      kind: "ridge" | "substrate",
    ) {
      if (width <= 0 || height <= 0 || depth <= 0) return;
      const box = new THREE.BoxGeometry(width, height, depth);
      const mesh = new THREE.Mesh(box, material);
      mesh.position.set(x, y, 0);
      mesh.userData.kind = kind;
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
      const nextGeometry = structureGeometry(next);
      // During a handle gesture, retain the original common physical scale as
      // well as the camera fit. Otherwise editing pitch would leave the pitch
      // handle stationary while the other dimensions silently rescale.
      geometry = refit
        ? nextGeometry
        : {
            ...nextGeometry,
            scale: geometry.scale,
            width: next.width * geometry.scale,
            height: next.height * geometry.scale,
            pitch: next.pitch * geometry.scale,
            span: next.pitch * 3 * geometry.scale,
          };
      const { width, height, pitch, depth, span, substrateDepth, ridgeMode } =
        geometry;
      addBox(
        span,
        substrateDepth,
        depth + 0.3,
        0,
        -substrateDepth / 2,
        materials.base,
        "substrate",
      );
      if (ridgeMode === "continuous") {
        // A single box has no artificial gaps or seams at CD = period.
        addBox(span, height, depth, 0, height / 2, materials.active, "ridge");
      } else if (ridgeMode === "patterned") {
        for (const repeat of [-1, 0, 1])
          addBox(
            width,
            height,
            depth,
            repeat * pitch,
            height / 2,
            repeat === 0 ? materials.active : materials.context,
            "ridge",
          );
      }
      canvas.dataset.ridgeMode = ridgeMode;
      canvas.dataset.ridgeMeshes = String(
        ridgeMode === "none" ? 0 : ridgeMode === "continuous" ? 1 : 3,
      );
      const widthZ = depth / 2 + 0.27;
      line([
        new THREE.Vector3(-width / 2, height, widthZ),
        new THREE.Vector3(width / 2, height, widthZ),
      ]);
      for (const x of [-width / 2, width / 2])
        line([
          new THREE.Vector3(x, height - 0.07, widthZ),
          new THREE.Vector3(x, height + 0.07, widthZ),
        ]);
      const heightX = width / 2 + 0.35;
      line([
        new THREE.Vector3(heightX, 0, depth / 2 + 0.03),
        new THREE.Vector3(heightX, height, depth / 2 + 0.03),
      ]);
      for (const y of [0, height])
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
      const end = new THREE.Vector3(-0.13, height + 0.06, -0.35);
      const origin = end.clone().sub(direction.clone().multiplyScalar(0.91));
      group.add(
        new THREE.ArrowHelper(direction, origin, 0.87, 0xbba052, 0.1, 0.055),
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
          ["ridge", "substrate"].includes(item.object.userData.kind),
        );
      if (hit) current.current.onOpen(hit.object.userData.kind);
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
      drag.current = null;
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
  }, [values.width, values.height, values.pitch, values.angle, active]);

  useEffect(() => {
    if (disabled) releaseDrag();
  }, [disabled]);

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
    if (!current.current.disabled) current.current.onOpen(sheet);
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
      event.button !== 0 ||
      pointers.current.size > 1 ||
      blockedHandleGesture.current ||
      !engine.current ||
      !host.current
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
    if (current.current.disabled) return;
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
      current.current.onChange(dimension, value);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      open(dimension);
    }
  }

  const ridgeMode = structureGeometry(values).ridgeMode;
  const stateNote =
    values.height === 0
      ? "Zero height: no patterned layer."
      : values.width === 0
        ? "Zero width: no ridge; the layer contains groove material."
        : ridgeMode === "continuous"
          ? "Width equals pitch: a continuous ridge-material layer."
          : "Three finite repeats illustrate the infinite 1D model.";

  return (
    <div className="object-editor" data-disabled={disabled}>
      <div
        className={`three-canvas ${active ? "is-editing" : ""}`}
        data-ready={ready}
        data-fallback={failed}
        onPointerDownCapture={trackPointer}
      >
        <div className="webgl-host" ref={host} hidden={failed} />
        <div className="scene-caption">
          <span>3D view</span>
          <small>3 repeats · infinite 1D model</small>
        </div>
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
            {structureDimensions.map((dimension) => (
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
                onBlur={() => setFocused(null)}
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
              aria-label={`Edit ridge material: ${project.layers[0].material.name}, ${materialSummary(project.layers[0].material)}`}
              onClick={() => open("ridge")}
            >
              <i />
              <span>Ridge</span>
              <small>{materialSummary(project.layers[0].material)}</small>
            </button>
            <button
              className="scene-substrate"
              disabled={disabled}
              aria-label={`Edit substrate material: ${project.substrate.name}, ${materialSummary(project.substrate)}`}
              onClick={() => open("substrate")}
            >
              Substrate <span>{materialSummary(project.substrate)}</span>
            </button>
            <div className="camera-hint">
              <span className="touch-cue">Drag to orbit · pinch to zoom</span>
              <span className="pointer-cue">
                Drag to orbit · scroll to zoom
              </span>
            </div>
            {(active || focused) && !disabled && (
              <div className="handle-name" role="status">
                {active || focused} · {values[(active || focused)!]} nm
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
      <div className="dimension-rail" aria-label="Structure dimensions">
        {structureDimensions.map((dimension) => (
          <button
            key={dimension}
            disabled={disabled}
            className={
              active === dimension || focused === dimension ? "selected" : ""
            }
            onClick={() => open(dimension)}
            aria-label={`Set ${dimension === "pitch" ? "pattern pitch" : `ridge ${dimension}`}, currently ${values[dimension]} nanometers`}
          >
            <span>
              {dimension === "pitch"
                ? "Pitch"
                : dimension === "width"
                  ? "Width"
                  : "Height"}
            </span>
            <strong>
              {values[dimension]}
              <small>nm</small>
            </strong>
          </button>
        ))}
      </div>
      <p className="scene-model-note">
        {stateNote} Width, height and pitch share one scale; substrate depth and
        groove length are schematic. Colors identify regions, not optical
        constants.
      </p>
    </div>
  );
}
