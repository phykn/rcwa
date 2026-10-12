import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { layerColor } from "./layerColors";
import type { Material } from "./model";
import {
  structureMaterialAppearance,
  visibleStructureDimensions,
  structureGeometry,
  structureHandlePosition,
  StructurePickGesture,
} from "./structureGeometry";
import type { StructureDimension, StructureValues } from "./structureGeometry";
import {
  layoutStructureHandles,
  STRUCTURE_HANDLE_SAFE_AREA,
} from "./structureHandleLayout";
import type {
  HandlePoint as Point,
  HandlePoints as Anchors,
} from "./structureHandleLayout";
import type {
  StructureRenderer,
  StructureRendererOptions,
} from "./threeStructureRendererTypes";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
function handlePoint(
  dimension: StructureDimension,
  geometry: ReturnType<typeof structureGeometry>,
) {
  return new THREE.Vector3(...structureHandlePosition(dimension, geometry));
}

/** Loaded only after the synchronous editor shell has mounted. */
export function createThreeStructureRenderer(
  element: HTMLDivElement,
  options: StructureRendererOptions,
): StructureRenderer {
  const cleanup: (() => void)[] = [];
  let failed = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const release of cleanup.reverse()) release();
  };
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  cleanup.push(() => renderer.dispose());
  try {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0xfafafa, 0);
    renderer.shadowMap.enabled = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const canvas = renderer.domElement;
    type CanvasEventMap = HTMLElementEventMap & {
      webglcontextlost: Event;
      webglcontextrestored: Event;
    };
    function listen<K extends keyof CanvasEventMap>(
      type: K,
      listener: (event: CanvasEventMap[K]) => void,
      capture = false,
    ) {
      canvas.addEventListener(type, listener as EventListener, capture);
      cleanup.push(() =>
        canvas.removeEventListener(type, listener as EventListener, capture),
      );
    }
    canvas.setAttribute(
      "aria-label",
      "Interactive 3D layer stack. Drag to orbit, pinch or scroll to zoom. Keyboard arrows orbit, plus and minus zoom, and 0 resets. Click a layer to select it. Dimension controls follow the selected layer; Layer settings opens its materials.",
    );
    canvas.setAttribute("role", "img");
    canvas.tabIndex = 0;
    element.appendChild(canvas);
    cleanup.push(() => canvas.remove());

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200);
    const initialDirection = new THREE.Vector3(6.4, 4.05, 7.6).normalize();
    camera.position.copy(initialDirection.clone().multiplyScalar(11));
    const controls = new OrbitControls(camera, canvas);
    cleanup.push(() => controls.dispose());
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
    cleanup.push(() =>
      sharedMaterials.forEach((material) => material.dispose()),
    );
    cleanup.push(disposeGroup);
    const raycaster = new THREE.Raycaster();
    const pickGesture = new StructurePickGesture();
    let geometry = structureGeometry(options.getState().values);
    let fitDistance = 11;
    let fitting = false;

    function projectPoint(point: THREE.Vector3): Point {
      const position = point.clone().project(camera);
      return { x: (position.x + 1) * 50, y: (1 - position.y) * 50 };
    }

    function redraw() {
      if (failed) return;
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
      const viewportWidth = element.clientWidth,
        viewportHeight = element.clientHeight;
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
        visibleStructureDimensions(options.getState().values),
        viewportWidth,
        viewportHeight,
        STRUCTURE_HANDLE_SAFE_AREA,
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
      options.onLayout({ anchors, physical, available: positioned !== null });
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
        layerIndex === options.getState().selectedIndex
          ? new THREE.LineBasicMaterial({
              color: 0x164e63,
              opacity: 0.9,
              transparent: true,
            })
          : materials.edge,
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
      function opticalMaterial(
        material: Material,
        layerIndex?: number,
        groove = false,
      ) {
        const appearance = structureMaterialAppearance(material);
        if (layerIndex !== undefined) {
          appearance.color = groove ? "#dbe4eb" : layerColor(layerIndex);
        }
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
      const project = options.getState().project;
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
            opticalMaterial(material, slab.index, region.kind === "groove"),
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
        options.onMoved(true);
      }
      redraw();
    };
    controls.addEventListener("change", onControlChange);
    cleanup.push(() => controls.removeEventListener("change", onControlChange));
    const onPointerDown = (event: globalThis.PointerEvent) => {
      pickGesture.down(
        event.pointerId,
        event.clientX,
        event.clientY,
        event.button === 0,
      );
      if (
        options.isDragging() ||
        options.isHandleGestureBlocked() ||
        options.getState().disabled
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
      if (!canPick || options.getState().disabled || failed) return;
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
          options.getState().onSelectLayer?.(layerIndex);
        else options.getState().onOpen(kind, layerIndex);
      }
    };
    const onPointerCancel = (event: globalThis.PointerEvent) =>
      pickGesture.cancel(event.pointerId);
    // Capture listeners classify the gesture before OrbitControls consumes it.
    listen("pointerdown", onPointerDown, true);
    listen("pointermove", onPointerMove, true);
    listen("pointerup", onPointerUp, true);
    listen("pointercancel", onPointerCancel, true);
    listen("lostpointercapture", onPointerCancel);

    const reset = () => {
      if (failed) return;
      fitView(true);
      options.onMoved(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        failed ||
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
      options.onMoved(true);
      redraw();
    };
    listen("keydown", onKeyDown);

    const onContextLost = (event: Event) => {
      event.preventDefault();
      failed = true;
      controls.enabled = false;
      pickGesture.suppress();
      options.onContextLost();
    };
    const onContextRestored = () => {
      failed = false;
      controls.enabled = !options.isHandleGestureBlocked();
      try {
        setValues(options.getState().values);
        options.onContextRestored();
      } catch {
        failed = true;
        controls.enabled = false;
        options.onContextLost();
      }
    };
    listen("webglcontextlost", onContextLost);
    listen("webglcontextrestored", onContextRestored);

    const resize = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      camera.aspect = element.clientWidth / element.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(element.clientWidth, element.clientHeight);
      fitView();
    });
    cleanup.push(() => resize.disconnect());
    resize.observe(element);
    failed = false;
    setValues(options.getState().values);
    return {
      setValues,
      setControlsEnabled: (enabled) => {
        controls.enabled = enabled && !failed;
      },
      getDragMapping: (dimension) => {
        const startPoint = handlePoint(dimension, geometry);
        const delta =
          dimension === "height"
            ? new THREE.Vector3(0, 0.1, 0)
            : new THREE.Vector3(0.1, 0, 0);
        const from = projectPoint(startPoint);
        const to = projectPoint(startPoint.clone().add(delta));
        const rect = element.getBoundingClientRect();
        const screenX = ((to.x - from.x) * rect.width) / 100;
        const screenY = ((to.y - from.y) * rect.height) / 100;
        const length = Math.hypot(screenX, screenY);
        if (length < 0.001) return null;
        return {
          dx: screenX / length,
          dy: screenY / length,
          nmPerPixel:
            (0.1 / (geometry.scale * length)) * (dimension === "width" ? 2 : 1),
        };
      },
      reset,
      suppressPicks: () => pickGesture.suppress(),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
