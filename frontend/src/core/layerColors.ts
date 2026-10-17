/** Schematic colors identify layer positions, not optical materials or selection. */
const LAYER_COLORS = [
  "#0891b2",
  "#ea8a3a",
  "#7c72bd",
  "#4d9975",
  "#cb6d8c",
  "#5b85b8",
  "#9b9357",
  "#a37560",
];
export function layerColor(index: number): string {
  return LAYER_COLORS[index % LAYER_COLORS.length];
}
