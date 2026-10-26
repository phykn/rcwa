import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  buildStructureGeometry2D,
  illuminationDirection2D,
  physicalToScene2D,
  structureScale2D,
} from "../core/geometry/structureGeometry2d";
import { meshRegionGeometry2D } from "../core/geometry/meshRegionGeometry2d";
import { layerColor } from "../core/layerColors";
import type { StructureMaterial2D } from "../core/geometry/structureGeometry2d";
import type { Design } from "../engine/types";
import { useStore } from "../state/store";

const isAir = (m: StructureMaterial2D) => m.kind === "constant" && m.n === 1 && m.k === 0;

interface Scene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  group: THREE.Group;
  render: () => void;
}

function disposeGroup(group: THREE.Group) {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
  group.clear();
}

const VIEW_DIRECTION = new THREE.Vector3(0.62, 0.5, 0.74).normalize();

/** Back the camera off until the whole scene, light arrow included, fits both ways. */
function frame(s: Scene) {
  const sphere = new THREE.Box3().setFromObject(s.group).getBoundingSphere(new THREE.Sphere());
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return;
  const half = THREE.MathUtils.degToRad(s.camera.fov) / 2;
  const narrowest = Math.min(half, Math.atan(Math.tan(half) * s.camera.aspect));
  s.controls.target.copy(sphere.center);
  s.camera.position.copy(sphere.center).addScaledVector(VIEW_DIRECTION, sphere.radius / Math.sin(narrowest));
  s.controls.update();
}

function build(group: THREE.Group, design: Design, selected: number) {
  disposeGroup(group);
  // A cutaway shows the patterns inside every layer.
  const geometry = buildStructureGeometry2D(design, { cutaway: true });
  const height = geometry.bounds.max.z;
  const scale = structureScale2D(design);
  const tone = (layerIndex: number, role: string) => {
    const color = new THREE.Color(layerColor(layerIndex));
    return role === "background" ? color.lerp(new THREE.Color("#ffffff"), 0.45) : color;
  };
  const surface = (layerIndex: number, role: string) =>
    new THREE.MeshStandardMaterial({
      color: tone(layerIndex, role),
      roughness: 0.55,
      metalness: 0.05,
      transparent: selected >= 0 && layerIndex !== selected,
      opacity: selected >= 0 && layerIndex !== selected ? 0.55 : 1,
    });
  for (const region of geometry.regions) {
    if (isAir(region.material)) continue;
    const box = new THREE.BoxGeometry(region.size.x * scale, region.size.z * scale, region.size.y * scale);
    const mesh = new THREE.Mesh(box, surface(region.layerIndex, region.role));
    const c = physicalToScene2D(region.center, scale, height);
    mesh.position.set(c.x, c.y, c.z);
    mesh.userData.layer = region.layerIndex;
    group.add(mesh);
  }
  for (const region of geometry.meshRegions) {
    if (isAir(region.material)) continue;
    const mesh = new THREE.Mesh(meshRegionGeometry2D(region, scale, height), surface(region.layerIndex, region.role));
    mesh.userData.layer = region.layerIndex;
    group.add(mesh);
  }
  const b = geometry.bounds;
  const width = (b.max.x - b.min.x) * scale;
  const depth = (b.max.y - b.min.y) * scale;
  const slab = Math.max(0.25, width * 0.08);
  const substrate = new THREE.Mesh(
    new THREE.BoxGeometry(width, slab, depth),
    new THREE.MeshStandardMaterial({ color: "#9aa7b6", roughness: 0.9, transparent: true, opacity: 0.6 }),
  );
  substrate.position.set(0, (-height / 2) * scale - slab / 2, 0);
  substrate.userData.layer = -2;
  group.add(substrate);
  const d = illuminationDirection2D(design.illumination.angle_deg, design.illumination.azimuth_deg);
  const dir = new THREE.Vector3(d.x, d.z, -d.y).normalize();
  const top = (height / 2) * scale;
  const length = Math.max(width, depth) * 0.55;
  const origin = new THREE.Vector3(0, top, 0).addScaledVector(dir, -length);
  group.add(new THREE.ArrowHelper(dir, origin, length * 0.92, "#e0a100", length * 0.14, length * 0.07));
  return Math.max(width, depth, height * scale);
}

export function Viewport3D() {
  const design = useStore((s) => s.design);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const framed = useRef(0);
  const [failed, setFailed] = useState(false);
  const selected = selection.kind === "layer" ? selection.index : -1;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      queueMicrotask(() => setFailed(true));
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = renderer.domElement;
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-roledescription", "3D structure view");
    canvas.setAttribute("aria-label", "3D structure. Drag to rotate, scroll to zoom. Click a layer to select it.");
    canvas.tabIndex = 0;
    element.append(canvas);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#ffffff", "#8a94a3", 2.2));
    const sun = new THREE.DirectionalLight("#ffffff", 1.6);
    sun.position.set(4, 8, 5);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 200);
    camera.position.set(5.5, 4.2, 6.5);
    const controls = new OrbitControls(camera, canvas);
    controls.enablePan = false;
    controls.minDistance = 2;
    controls.maxDistance = 30;
    const group = new THREE.Group();
    scene.add(group);
    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (sceneRef.current) frame(sceneRef.current);
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const rect = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1),
        camera,
      );
      const hit = ray.intersectObjects(group.children, false).find((h) => typeof h.object.userData.layer === "number");
      const layer = hit?.object.userData.layer as number | undefined;
      if (layer === -2) select({ kind: "substrate" });
      else if (layer !== undefined && layer >= 0) select({ kind: "layer", index: layer });
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    const onLost = () => setFailed(true);
    canvas.addEventListener("webglcontextlost", onLost);
    sceneRef.current = { renderer, scene, camera, controls, group, render };
    resize();
    return () => {
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("webglcontextlost", onLost);
      controls.dispose();
      disposeGroup(group);
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      sceneRef.current = null;
    };
  }, [select]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    let extent: number;
    try {
      extent = build(s.group, design, selected);
    } catch {
      // Invalid intermediate dimensions keep the previous picture; the form shows why.
      return;
    }
    // Refit only when the structure's size changes a lot, so orbiting survives edits.
    if (!framed.current || Math.abs(extent / framed.current - 1) > 0.35) {
      framed.current = extent;
      frame(s);
    }
    s.render();
  }, [design, selected]);

  return (
    <div className="viewport">
      {failed ? (
        <div className="viewport-fallback" role="note">
          3D view is unavailable in this browser. Layers and dimensions remain editable in the stack and inspector.
        </div>
      ) : (
        <div ref={host} className="viewport-canvas" />
      )}
    </div>
  );
}
