import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { defaultProject } from "./model";
import type { Project1D as Project } from "./model";
import {
  layoutStructureHandles,
  STRUCTURE_HANDLE_SAFE_AREA,
} from "./structureHandleLayout";
import type { HandlePoints } from "./structureHandleLayout";
import {
  structureGeometry,
  structureHandlePosition,
  structureValues,
} from "./structureGeometry";

/** Reconstruct the scene bounds and reset camera without requiring WebGL.
 * This includes the substrate, dimension guides and actual ArrowHelper bounds.
 */
function resetCamera(
  canvasWidth: number,
  canvasHeight: number,
  project: Project = defaultProject,
  selectedLayer = 0,
) {
  const geometry = structureGeometry(structureValues(project, selectedLayer));
  const { width, top, bottom, pitch, span, depth, substrateDepth } = geometry;
  const group = new THREE.Group();
  const box = (w: number, h: number, d: number, x: number, y: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
    mesh.position.set(x, y, 0);
    group.add(mesh);
  };
  const line = (points: number[][]) =>
    group.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
        ),
      ),
    );
  box(span, substrateDepth, depth + 0.3, 0, -substrateDepth / 2);
  for (const slab of geometry.layers)
    for (const region of slab.regions)
      box(region.width, slab.height, depth, region.x, slab.center);
  const widthZ = depth / 2 + 0.27;
  line([
    [-width / 2, top, widthZ],
    [width / 2, top, widthZ],
  ]);
  for (const x of [-width / 2, width / 2])
    line([
      [x, top - 0.07, widthZ],
      [x, top + 0.07, widthZ],
    ]);
  const heightX = width / 2 + 0.35;
  line([
    [heightX, bottom, depth / 2 + 0.03],
    [heightX, top, depth / 2 + 0.03],
  ]);
  for (const y of [bottom, top])
    line([
      [heightX - 0.06, y, depth / 2 + 0.03],
      [heightX + 0.06, y, depth / 2 + 0.03],
    ]);
  const pitchZ = depth / 2 + 0.47;
  line([
    [0, 0.01, pitchZ],
    [pitch, 0.01, pitchZ],
  ]);
  for (const x of [0, pitch])
    line([
      [x, 0.01, pitchZ - 0.07],
      [x, 0.01, pitchZ + 0.07],
    ]);
  const angle = THREE.MathUtils.degToRad(project.illumination.angle_deg);
  const incoming = new THREE.Vector3(Math.sin(angle), -Math.cos(angle), 0);
  const end = new THREE.Vector3(-0.13, geometry.totalHeight + 0.06, -0.35);
  group.add(
    new THREE.ArrowHelper(
      incoming,
      end.clone().sub(incoming.clone().multiplyScalar(0.91)),
      0.87,
      0xf59e0b,
      0.1,
      0.055,
    ),
  );
  const bounds = new THREE.Box3().setFromObject(group);
  const camera = new THREE.PerspectiveCamera(
    35,
    canvasWidth / canvasHeight,
    0.01,
    200,
  );
  const center = bounds.getCenter(new THREE.Vector3());
  const direction = new THREE.Vector3(6.4, 4.05, 7.6).normalize();
  camera.position.copy(center.clone().add(direction));
  camera.lookAt(center);
  camera.updateMatrixWorld();
  const inverse = camera.quaternion.clone().invert();
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)),
    tanX = tanY * camera.aspect;
  let distance = 0;
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) {
        const corner = new THREE.Vector3(x, y, z)
          .sub(center)
          .applyQuaternion(inverse);
        distance = Math.max(
          distance,
          Math.abs(corner.x) / (tanX * 0.82) + corner.z,
          Math.abs(corner.y) / (tanY * 0.75) + corner.z,
        );
      }
  camera.position.copy(center.clone().add(direction.multiplyScalar(distance)));
  camera.lookAt(center);
  camera.updateMatrixWorld();
  const pixel = (point: [number, number, number]) => {
    const projected = new THREE.Vector3(...point).project(camera);
    return new THREE.Vector2(
      ((projected.x + 1) * canvasWidth) / 2,
      ((1 - projected.y) * canvasHeight) / 2,
    );
  };
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    if (mesh.material)
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material])
        material.dispose();
  });
  return { geometry, pixel };
}

describe("physical dimension handle hit targets", () => {
  it.each([
    { viewport: 360, width: 310, height: 312 / 1.12 - 2 },
    { viewport: 390, width: 340, height: 342 / 1.12 - 2 },
    { viewport: 1440, width: 590, height: 592 / 1.35 - 2 },
  ])(
    "separates width and thickness44px circular targets at $viewport px reset view",
    ({ width, height }) => {
      const { geometry, pixel } = resetCamera(width, height);
      const widthCenter = pixel(structureHandlePosition("width", geometry));
      const heightCenter = pixel(structureHandlePosition("height", geometry));
      // Both CSS hit targets remain44px wide; changing their z-order cannot fix
      // overlap because it merely makes the other physical dimension unpickable.
      expect(widthCenter.distanceTo(heightCenter)).toBeGreaterThanOrEqual(44);
      // The previous front-right thickness anchor reproduced the actual bug:
      // it covered the width target's center and silently changed height instead.
      const previousHeight = pixel([
        geometry.width / 2 + 0.35,
        geometry.top,
        geometry.depth / 2 + 0.03,
      ]);
      if (width < 400)
        expect(widthCenter.distanceTo(previousHeight)).toBeLessThan(22);
    },
  );
  it.each([
    { viewport: 360, width: 310, height: 312 / 1.12 - 2 },
    { viewport: 390, width: 340, height: 342 / 1.12 - 2 },
    { viewport: 1440, width: 590, height: 592 / 1.35 - 2 },
  ])(
    "separates selected lower-layer targets in a mixed stack at $viewport px",
    ({ width, height }) => {
      const project: Project = {
        ...defaultProject,
        schema_version: "1.1",
        layers: [
          { ...defaultProject.layers[0], name: "Top", thickness_nm: 110 },
          {
            name: "Spacer",
            geometry: "homogeneous",
            thickness_nm: 95,
            material: defaultProject.substrate,
          },
          {
            ...defaultProject.layers[0],
            name: "Bottom",
            thickness_nm: 80,
            cd_nm: 230,
          },
        ],
      };
      const { geometry, pixel } = resetCamera(width, height, project, 2);
      const widthCenter = pixel(structureHandlePosition("width", geometry));
      const heightCenter = pixel(structureHandlePosition("height", geometry));
      expect(widthCenter.distanceTo(heightCenter)).toBeGreaterThanOrEqual(44);
      expect(geometry.selectedLayer).toBe(2);
    },
  );

  it.each([
    { viewport: 360, width: 326, height: 328 / 1.12 - 2 },
    { viewport: 390, width: 340, height: 342 / 1.12 - 2 },
    { viewport: 1440, width: 590, height: 592 / 1.35 - 2 },
  ])(
    "keeps all visible targets separated for eight/zero/tall-thin stacks at $viewport px",
    ({ width, height }) => {
      const pattern = defaultProject.layers[0];
      const layers: Project["layers"] = [
        { ...pattern, thickness_nm: 110 },
        {
          name: "Spacer",
          geometry: "homogeneous",
          thickness_nm: 95,
          material: defaultProject.substrate,
        },
        { ...pattern, thickness_nm: 80, cd_nm: 230 },
      ];
      const base: Project = {
        ...defaultProject,
        schema_version: "1.1",
        layers: Array.from({ length: 8 }, (_, i) => ({ ...layers[i % 3] })),
      };
      for (const project of [
        base,
        {
          ...base,
          layers: base.layers.map((layer) => ({ ...layer, thickness_nm: 0 })),
        },
        {
          ...base,
          layers: base.layers.map((layer, index) => ({
            ...layer,
            thickness_nm: index === 0 ? 0.1 : 2000,
          })),
        },
      ]) {
        const { geometry, pixel } = resetCamera(width, height, project, 0);
        const points: HandlePoints = {
          width: pixel(structureHandlePosition("width", geometry)),
          height: pixel(structureHandlePosition("height", geometry)),
          pitch: pixel(structureHandlePosition("pitch", geometry)),
        };
        const positioned = layoutStructureHandles(
          points,
          ["width", "height", "pitch"],
          width,
          height,
          STRUCTURE_HANDLE_SAFE_AREA,
        )!;
        expect(positioned).not.toBeNull();
        for (const [index, point] of Object.values(positioned).entries()) {
          expect(point.x).toBeGreaterThanOrEqual(22);
          expect(point.x).toBeLessThanOrEqual(width - 22);
          expect(point.y).toBeGreaterThanOrEqual(
            STRUCTURE_HANDLE_SAFE_AREA.top + 22,
          );
          expect(point.y).toBeLessThanOrEqual(
            height - STRUCTURE_HANDLE_SAFE_AREA.bottom - 22,
          );
          for (const other of Object.values(positioned).slice(index + 1))
            expect(
              Math.hypot(point.x - other.x, point.y - other.y),
            ).toBeGreaterThanOrEqual(48 - 1e-6);
        }
        // Target layout is a separate overlay; no physical slab/guide is moved.
        expect(geometry).toEqual(
          structureGeometry(structureValues(project, 0)),
        );
      }
    },
  );
  it("anchors the selected lower layer using its cumulative interfaces", () => {
    const project = structuredClone(defaultProject);
    project.layers.push({
      ...structuredClone(project.layers[0]),
      thickness_nm: 90,
    });
    const selected = structureGeometry(structureValues(project, 1));
    expect(structureHandlePosition("height", selected)).toEqual([
      0,
      selected.top,
      -0.35,
    ]);
    expect(structureHandlePosition("width", selected)[1]).toBeCloseTo(
      selected.bottom + selected.height * 0.52,
    );
  });
  it("keeps a homogeneous thickness handle at the film edge with no competing width handle", () => {
    const project = {
      ...defaultProject,
      schema_version: "1.1" as const,
      layers: [
        {
          name: "Film",
          geometry: "homogeneous" as const,
          thickness_nm: 100,
          material: defaultProject.substrate,
        },
      ],
    };
    const geometry = structureGeometry(structureValues(project));
    expect(structureHandlePosition("height", geometry)).toEqual([
      geometry.span / 2 + 0.35,
      geometry.top,
      geometry.depth / 2 + 0.03,
    ]);
  });
});
