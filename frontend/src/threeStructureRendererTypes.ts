import type { Project1D } from "./model";
import type {
  StructureDimension,
  StructureSheet,
  StructureValues,
} from "./structureGeometry";
import type { HandlePoints } from "./structureHandleLayout";

/** Renderer boundary contains only application data and plain coordinates. */
export interface StructureRendererState {
  project: Project1D;
  values: StructureValues;
  selectedIndex: number;
  disabled: boolean;
  onSelectLayer?: (index: number) => void;
  onOpen: (sheet: StructureSheet, layerIndex?: number) => void;
}
export interface StructureRendererOptions {
  getState: () => StructureRendererState;
  isDragging: () => boolean;
  isHandleGestureBlocked: () => boolean;
  onLayout: (layout: {
    anchors: HandlePoints;
    physical: HandlePoints;
    available: boolean;
  }) => void;
  onMoved: (moved: boolean) => void;
  onContextLost: () => void;
  onContextRestored: () => void;
}
export interface StructureRenderer {
  setValues: (values: StructureValues, refit?: boolean) => void;
  setControlsEnabled: (enabled: boolean) => void;
  getDragMapping: (
    dimension: StructureDimension,
  ) => { dx: number; dy: number; nmPerPixel: number } | null;
  reset: () => void;
  suppressPicks: () => void;
  dispose: () => void;
}
