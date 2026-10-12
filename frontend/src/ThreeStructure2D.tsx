import { useCallback, useEffect, useRef, useState } from "react";
import type { StructureGeometryProject2D } from "./structureGeometry2d";
import { formatDimension2D, exactDimensionText2D } from "./DimensionEditor2D";
import "./structure2d.css";
import { layerColor } from "./layerColors";
import { StructureFallback2D } from "./StructureFallback2D";
import type { StructureCanvas2D } from "./StructureCanvas2D";

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
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [Canvas, setCanvas] = useState<typeof StructureCanvas2D | null>(null);
  const resetView = useRef<(() => void) | null>(null);
  // Only the renderer loads asynchronously. Controls, selection, SVG and the
  // project stay owned by this shell, so late readiness cannot replace edits.
  useEffect(() => {
    let active = true;
    void import("./StructureCanvas2D").then(
      ({ StructureCanvas2D: Renderer }) => {
        if (active) setCanvas(() => Renderer);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const onFallbackChange = useCallback((unavailable: boolean) => {
    setFailed(unavailable);
    setReady(!unavailable);
  }, []);
  const showFallback = !ready || failed;
  return (
    <div
      className="s2-scene"
      aria-label="Structure view"
      data-fallback={showFallback}
      data-renderer-state={failed ? "unavailable" : ready ? "ready" : "loading"}
    >
      {Canvas && (
        <Canvas
          project={project}
          selected={selectedLayer}
          cutaway={cutaway}
          onSelect={onSelectLayer}
          disabled={disabled}
          resetView={resetView}
          failed={failed}
          onFallbackChange={onFallbackChange}
        />
      )}
      {showFallback && (
        <StructureFallback2D
          project={project}
          selected={selectedLayer}
          onSelect={onSelectLayer}
          disabled={disabled}
          loading={!failed}
        />
      )}
      {!failed && (
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
          {cutaway && ready && (
            <span className="s2-cut-note">Corner hidden</span>
          )}
        </div>
      )}
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
          {showFallback ? (
            <>
              <p>
                One repeat cell: the selected layer from above (X–Y), and the
                stack through its center (X–Z at Y=0). Each projection has equal
                physical axis scales and is fitted separately.
              </p>
              <p>
                Colors identify layers. Circular hosts use the layer color;
                non-air hole fills and rectangular backgrounds use pale gray.
                White is air. Ambient and substrate are boundary lines with no
                added thickness.
              </p>
              <p>
                Tap a distinct section to select a layer. Use the layer chips
                for thin or zero-thickness layers and keyboard selection. Exact
                dimensions and materials remain editable below.
              </p>
            </>
          ) : (
            <>
              <button
                className="text-button"
                onClick={(event) => {
                  resetView.current?.();
                  const guide = event.currentTarget.closest("details");
                  if (guide) guide.open = false;
                  const canvas = event.currentTarget
                    .closest(".s2-scene")
                    ?.querySelector("canvas");
                  if (canvas?.dataset.ready === "true") canvas.focus();
                  else guide?.querySelector("summary")?.focus();
                }}
              >
                Reset view
              </button>
              <p>
                A corner is hidden in Cutaway to show inner layers; your
                structure is unchanged.
              </p>
              <p>
                X and Y stay fixed to the structure. Diameter is the circular
                hole size; width describes rectangular patterns. Pitch is repeat
                spacing. The dashed outline marks one repeat cell.
              </p>
              <p>
                Colors identify layers from top to bottom. Circular layers show
                their host with round openings; non-air hole fills remain
                visible. Pale gray is rectangular background material. The gray
                base is the substrate, shown at a schematic depth.
              </p>
            </>
          )}
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
  const circular = layer.geometry === "circular_hole_2d";
  const widthX =
    layer.geometry === "circular_hole_2d"
      ? layer.diameter_nm
      : layer.geometry === "rectangle_2d"
        ? layer.cd_x_nm
        : layer.geometry === "rectangle_1d"
          ? layer.cd_nm
          : 0;
  const widthY = layer.geometry === "rectangle_2d" ? layer.cd_y_nm : null;
  const widthLabel = circular
    ? `Edit Layer ${selectedLayer + 1} diameter: ${exactDimensionText2D(widthX)} nanometers`
    : `Edit Layer ${selectedLayer + 1} width: X ${exactDimensionText2D(widthX)} nanometers${widthY !== null ? `, Y ${exactDimensionText2D(widthY)} nanometers` : ""}`;
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
            <span>{circular ? "Diameter" : "Width"}</span>
            <DimensionValue2D
              axis={circular ? undefined : "X"}
              value={widthX}
            />
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
            {circular
              ? `Layer ${selectedLayer + 1} has zero hole diameter; its host fills the layer.`
              : `Layer ${selectedLayer + 1} has zero pattern width; its background fills the layer.`}
          </p>
        )}
    </>
  );
}
