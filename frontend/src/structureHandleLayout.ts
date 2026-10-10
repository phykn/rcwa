import type { StructureDimension } from "./structureGeometry";

export interface HandlePoint {
  x: number;
  y: number;
}
export type HandlePoints = Record<StructureDimension, HandlePoint>;
export const HANDLE_DIAMETER = 44;
export const HANDLE_SPACING = 48;
const EPSILON = 1e-7;
const distance = (a: HandlePoint, b: HandlePoint) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Keep real projected anchors separate from their screen-space hit targets.
 * At most three targets are placed, in the supplied stable dimension order.
 * The nearest feasible point is on a circle/viewport boundary or intersection;
 * no iterative repulsion, geometry scaling or view-dependent drag units.
 * A scene too small to fit the targets returns null; exact entry stays usable.
 */
export function layoutStructureHandles(
  anchors: HandlePoints,
  dimensions: readonly StructureDimension[],
  width: number,
  height: number,
): HandlePoints | null {
  const inset = HANDLE_DIAMETER / 2;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < HANDLE_DIAMETER ||
    height < HANDLE_DIAMETER
  )
    return null;
  const left = inset,
    right = width - inset,
    top = inset,
    bottom = height - inset;
  const positions: HandlePoints = { ...anchors };
  const placed: HandlePoint[] = [];
  for (const dimension of dimensions) {
    const source = anchors[dimension];
    if (!Number.isFinite(source.x) || !Number.isFinite(source.y)) return null;
    const candidates: HandlePoint[] = [];
    const add = (x: number, y: number) => candidates.push({ x, y });
    add(
      Math.min(right, Math.max(left, source.x)),
      Math.min(bottom, Math.max(top, source.y)),
    );
    for (const point of placed) {
      const dx = source.x - point.x,
        dy = source.y - point.y,
        length = Math.hypot(dx, dy);
      if (length > EPSILON)
        add(
          point.x + (dx * HANDLE_SPACING) / length,
          point.y + (dy * HANDLE_SPACING) / length,
        );
      // Stable tie-breaking for coincident projections: up, right, down, left.
      for (const [x, y] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ])
        add(point.x + x * HANDLE_SPACING, point.y + y * HANDLE_SPACING);
      for (const x of [left, right]) {
        const squared = HANDLE_SPACING ** 2 - (x - point.x) ** 2;
        if (squared >= 0) {
          const delta = Math.sqrt(squared);
          add(x, point.y - delta);
          add(x, point.y + delta);
        }
      }
      for (const y of [top, bottom]) {
        const squared = HANDLE_SPACING ** 2 - (y - point.y) ** 2;
        if (squared >= 0) {
          const delta = Math.sqrt(squared);
          add(point.x - delta, y);
          add(point.x + delta, y);
        }
      }
    }
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i],
          b = placed[j],
          length = distance(a, b);
        if (length <= EPSILON || length > 2 * HANDLE_SPACING) continue;
        const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const offset = Math.sqrt(HANDLE_SPACING ** 2 - length ** 2 / 4);
        const dx = (-(b.y - a.y) * offset) / length,
          dy = ((b.x - a.x) * offset) / length;
        add(middle.x + dx, middle.y + dy);
        add(middle.x - dx, middle.y - dy);
      }
    for (const x of [left, right]) for (const y of [top, bottom]) add(x, y);
    let best: HandlePoint | undefined,
      bestDistance = Infinity;
    for (const candidate of candidates) {
      if (
        candidate.x < left - EPSILON ||
        candidate.x > right + EPSILON ||
        candidate.y < top - EPSILON ||
        candidate.y > bottom + EPSILON ||
        placed.some(
          (point) => distance(candidate, point) < HANDLE_SPACING - EPSILON,
        )
      )
        continue;
      const nextDistance = distance(candidate, source);
      if (nextDistance < bestDistance - EPSILON) {
        best = candidate;
        bestDistance = nextDistance;
      }
    }
    if (!best) return null;
    // Remove only numerical boundary drift; original valid anchors stay exact.
    const target = {
      x: Math.min(right, Math.max(left, best.x)),
      y: Math.min(bottom, Math.max(top, best.y)),
    };
    positions[dimension] = target;
    placed.push(target);
  }
  return positions;
}
