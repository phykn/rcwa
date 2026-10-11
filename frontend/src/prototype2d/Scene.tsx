import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildPrototypeGeometry } from "./geometry";
import type { PrototypeGeometryProject } from "./geometry";
import { layerColor } from "../layerColors";

export function PrototypeScene({
  project,
  selected,
  cutaway,
  onSelect,
}: {
  project: PrototypeGeometryProject & {
    illumination: { angle_deg: number; azimuth_deg: number };
  };
  selected: number;
  cutaway: boolean;
  onSelect: (layer: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef({ project, selected, cutaway, onSelect });
  current.current = { project, selected, cutaway, onSelect };
  const update = useRef<(() => void) | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0xf2f5fa, 1);
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      "aria-label",
      "3D structure. Drag to rotate, pinch to zoom. Tap a layer to select it.",
    );
    element.append(canvas);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 200);
    camera.position.set(6.6, 5.8, -7.7);
    const controls = new OrbitControls(camera, canvas);
    canvas.style.touchAction = "pan-y";
    controls.enablePan = false;
    controls.minDistance = 4;
    controls.maxDistance = 24;
    controls.maxPolarAngle = Math.PI * 0.92;
    const group = new THREE.Group();
    scene.add(group);
    const raycaster = new THREE.Raycaster();
    const point = new THREE.Vector2();
    const picks: THREE.Mesh[] = [];
    const axisLabels = (["X", "Y"] as const).map((name) => {
      const label = document.createElement("span");
      label.textContent = name;
      label.className = "p2-projected-axis";
      label.setAttribute("aria-hidden", "true");
      element.append(label);
      return { label, point: new THREE.Vector3() };
    });
    const render = () => {
      renderer.render(scene, camera);
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
    const rebuild = () => {
      dispose();
      const {
        project: p,
        selected: active,
        cutaway: clipped,
      } = current.current;
      const geometry = buildPrototypeGeometry(p, { cutaway: clipped });
      const total = p.layers.reduce(
        (sum, layer) => sum + layer.thickness_nm,
        0,
      );
      // A single common scale preserves all physical aspect ratios.
      const scale =
        4.8 / Math.max(3 * p.period_nm, 3 * p.period_y_nm, total, 1);
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
      const theta = THREE.MathUtils.degToRad(p.illumination.angle_deg);
      const phi = THREE.MathUtils.degToRad(p.illumination.azimuth_deg);
      const direction = new THREE.Vector3(
        Math.sin(theta) * Math.cos(phi),
        -Math.cos(theta),
        -Math.sin(theta) * Math.sin(phi),
      );
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
      axisLabels[0].point.copy(axesOrigin).add(new THREE.Vector3(0.62, 0, 0));
      axisLabels[1].point.copy(axesOrigin).add(new THREE.Vector3(0, 0, -0.62));
      canvas.dataset.coordinateConvention =
        "physical(x,y,z) maps to scene(x,z,-y)";
      canvas.dataset.ready = "true";
      canvas.dataset.selectedLayer = String(active);
      canvas.dataset.regionCount = String(geometry.regions.length);
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
      const { width, height } = element.getBoundingClientRect();
      renderer.setSize(width, height);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    controls.addEventListener("change", render);
    let gesture: { x: number; y: number; id: number; moved: boolean } | null =
      null;
    const down = (event: PointerEvent) => {
      if (gesture) gesture.moved = true;
      else
        gesture = {
          x: event.clientX,
          y: event.clientY,
          id: event.pointerId,
          moved: false,
        };
    };
    const move = (event: PointerEvent) => {
      if (
        gesture &&
        Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 3
      )
        gesture.moved = true;
    };
    const up = (event: PointerEvent) => {
      if (gesture && !gesture.moved && gesture.id === event.pointerId) {
        const rect = canvas.getBoundingClientRect();
        point.set(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          (-(event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(point, camera);
        const hit = raycaster.intersectObjects(picks)[0];
        if (hit) current.current.onSelect(hit.object.userData.layerIndex);
      }
      gesture = null;
    };
    const key = (event: KeyboardEvent) => {
      if (
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-"].includes(
          event.key,
        )
      )
        return;
      event.preventDefault();
      const spherical = new THREE.Spherical().setFromVector3(camera.position);
      if (event.key === "ArrowLeft") spherical.theta -= 0.12;
      if (event.key === "ArrowRight") spherical.theta += 0.12;
      if (event.key === "ArrowUp")
        spherical.phi = Math.max(0.1, spherical.phi - 0.12);
      if (event.key === "ArrowDown")
        spherical.phi = Math.min(Math.PI - 0.1, spherical.phi + 0.12);
      if (event.key === "+") spherical.radius *= 0.9;
      if (event.key === "-") spherical.radius *= 1.1;
      camera.position.setFromSpherical(spherical);
      controls.update();
      render();
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("keydown", key);
    rebuild();
    resize();
    return () => {
      update.current = null;
      observer.disconnect();
      controls.dispose();
      dispose();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("keydown", key);
      renderer.dispose();
      canvas.remove();
      axisLabels.forEach(({ label }) => label.remove());
    };
  }, []);
  useEffect(() => {
    update.current?.();
  }, [project, selected, cutaway]);
  return failed ? (
    <div className="p2-fallback" role="status">
      <strong>3D view is unavailable.</strong>
      <p>All dimensions remain editable below.</p>
    </div>
  ) : (
    <div className="p2-webgl" ref={host} />
  );
}
