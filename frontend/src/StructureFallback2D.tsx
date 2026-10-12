import { useEffect, useId, useMemo, useRef, useState } from "react";
import { layerColor } from "./layerColors";
import { exactDimensionText2D } from "./DimensionEditor2D";
import type {
  StructureGeometryProject2D,
  StructureMaterial2D,
} from "./structureGeometry2d";
import {
  buildStructureProjections2D,
  fitProjection2D,
  isAir2D,
  type ProjectionBounds2D,
  type ProjectionRegion2D,
} from "./structureProjection2d";

const number = exactDimensionText2D;

function Region({
  region,
  circular,
}: {
  region: ProjectionRegion2D;
  circular: boolean;
}) {
  const air = isAir2D(region.material);
  const color = air
    ? "none"
    : (circular ? region.role === "background" : region.role === "material")
      ? layerColor(region.layerIndex)
      : "#dde4ec";
  const attributes = {
    "data-role": region.role,
    "data-air": air,
    "data-material-name": region.material.name,
    fill: color,
  };
  const title = `${circular ? (region.role === "material" ? "Hole fill" : "Host") : region.role === "material" ? "Layer material" : "Background"}: ${region.material.name}${air ? " (air)" : ""}`;
  if (region.shape === "circle")
    return (
      <circle {...attributes} cx={0} cy={0} r={region.radius}>
        <title>{title}</title>
      </circle>
    );
  const { minX, maxX, minY, maxY } = region.bounds;
  if (region.shape === "circle-host") {
    const r = region.radius;
    // A real hole in the host, so transparent air never paints over a solid.
    const path = `M${minX},${minY}H${maxX}V${maxY}H${minX}Z M${-r},0a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`;
    return (
      <path {...attributes} d={path} fillRule="evenodd">
        <title>{title}</title>
      </path>
    );
  }
  return (
    <rect
      {...attributes}
      x={minX}
      y={minY}
      width={maxX - minX}
      height={maxY - minY}
    >
      <title>{title}</title>
    </rect>
  );
}

type FallbackProject = StructureGeometryProject2D & {
  readonly ambient?: StructureMaterial2D;
  readonly substrate?: StructureMaterial2D;
};

function Projection({
  project,
  selected,
  view,
  regions,
  bounds,
  total,
  onSelect,
  disabled,
  layers,
}: {
  project: FallbackProject;
  selected: number;
  view: "xy" | "xz";
  regions: readonly ProjectionRegion2D[];
  bounds: ProjectionBounds2D;
  total: number;
  layers: ReturnType<typeof buildStructureProjections2D>["layers"];
  onSelect: (index: number) => void;
  disabled: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 160, height: 180 });
  const id = useId();
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (width > 0 && height > 0)
        setSize((before) =>
          before.width === width && before.height === height
            ? before
            : { width, height },
        );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit = fitProjection2D(bounds, size.width, size.height);
  const x = (physical: number) => fit.originX + physical * fit.scale;
  const y = (physical: number) => fit.originY - physical * fit.scale;
  const label =
    view === "xy"
      ? "Selected layer top view, X–Y"
      : "Stack center section, X–Z at Y=0";
  const active = project.layers[selected];
  const materialDescription =
    active.geometry === "homogeneous"
      ? `Layer material: ${active.material.name}.`
      : active.geometry === "circular_hole_2d"
        ? `Host: ${active.background.name}. Hole fill: ${active.material.name}.`
        : `Pattern: ${active.material.name}. Background: ${active.background.name}.`;
  return (
    <figure className="s2-projection">
      <figcaption>
        {view === "xy"
          ? `Layer ${selected + 1} · X–Y top`
          : "Stack · X–Z at Y=0"}
      </figcaption>
      <svg
        ref={svg}
        role="img"
        aria-label={label}
        aria-describedby={`${id}-description`}
        data-projection={view}
        data-selected-layer={selected}
        data-period-x={project.period_nm}
        data-period-y={project.period_y_nm}
        data-total-thickness={total}
        viewBox={`0 0 ${size.width} ${size.height}`}
      >
        <desc id={`${id}-description`}>
          {view === "xy"
            ? `One repeat of selected layer ${selected + 1}, ${active.name}. X pitch ${number(project.period_nm)} nm, Y pitch ${number(project.period_y_nm)} nm. Thickness ${number(active.thickness_nm)} nm. ${materialDescription}`
            : `One repeat through ${project.layers.length} layers, ambient above and substrate below. Total thickness ${number(total)} nm. Ambient: ${project.ambient?.name ?? "ambient material"}. Substrate: ${project.substrate?.name ?? "substrate material"}. Tap a distinct layer to select it; use the layer chips for keyboard selection and thin or zero-thickness layers.`}{" "}
          Axes share a physical scale within this projection. White regions are
          air; colors identify layer positions, not optical appearance.
          Boundaries have no added thickness.
        </desc>
        <g
          transform={`translate(${fit.originX} ${fit.originY}) scale(${fit.scale} ${-fit.scale})`}
        >
          {layers
            .filter((layer) => view === "xz" || layer.layerIndex === selected)
            .map((layer) => {
              const index = layer.layerIndex;
              const selectable =
                view === "xz" &&
                layer.thickness * fit.scale >= 8 &&
                (bounds.maxX - bounds.minX) * fit.scale >= 8 &&
                !disabled;
              return (
                <g
                  key={index}
                  data-layer-index={index}
                  data-geometry={layer.geometry}
                  data-thickness-nm={layer.thickness}
                  data-selectable={selectable}
                >
                  {regions
                    .filter((region) => region.layerIndex === index)
                    .map((region, i) => (
                      <Region
                        key={i}
                        region={region}
                        circular={layer.geometry === "circular_hole_2d"}
                      />
                    ))}
                  {view === "xz" && (
                    <>
                      <rect
                        x={bounds.minX}
                        y={layer.bottom}
                        width={bounds.maxX - bounds.minX}
                        height={layer.thickness}
                        fill="none"
                        stroke={index === selected ? "#172f46" : "#9caab9"}
                        strokeWidth={index === selected ? 2 : 0.7}
                        vectorEffect="non-scaling-stroke"
                      />
                      {selectable && (
                        <rect
                          className="s2-section-pick"
                          data-layer-pick={index}
                          x={bounds.minX}
                          y={layer.bottom}
                          width={bounds.maxX - bounds.minX}
                          height={layer.thickness}
                          fill="transparent"
                          onClick={(event) => {
                            const box =
                              event.currentTarget.getBoundingClientRect();
                            // Do not choose one of two shared interfaces by
                            // painter order. Chips remain the exact route.
                            if (
                              event.clientX > box.left + 2 &&
                              event.clientX < box.right - 2 &&
                              event.clientY > box.top + 2 &&
                              event.clientY < box.bottom - 2
                            )
                              onSelect(index);
                          }}
                        >
                          <title>{`Select Layer ${index + 1}: ${project.layers[index].name}`}</title>
                        </rect>
                      )}
                    </>
                  )}
                </g>
              );
            })}
          {view === "xy" && (
            <rect
              x={bounds.minX}
              y={bounds.minY}
              width={bounds.maxX - bounds.minX}
              height={bounds.maxY - bounds.minY}
              fill="none"
              stroke="#334155"
              strokeWidth={1}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>
        {view === "xz" ? (
          <>
            {[total, 0].map((z, i) => (
              <line
                key={i}
                data-boundary={i === 0 ? "ambient" : "substrate"}
                x1={x(bounds.minX)}
                x2={x(bounds.maxX)}
                y1={y(z)}
                y2={y(z)}
                stroke="#334155"
              />
            ))}
            <text x={size.width / 2} y={y(total) - 8} textAnchor="middle">
              Ambient
            </text>
            <text x={size.width / 2} y={y(0) + 15} textAnchor="middle">
              Substrate
            </text>
          </>
        ) : active.thickness_nm === 0 ? (
          <text x={size.width / 2} y={size.height / 2 + 4} textAnchor="middle">
            Zero thickness
          </text>
        ) : null}
        <text className="s2-projection-axis" x={4} y={12}>
          {view === "xy" ? "Y ↑" : "Z ↑"}
        </text>
        <text
          className="s2-projection-axis"
          x={size.width - 4}
          y={size.height - 4}
          textAnchor="end"
        >
          X →
        </text>
      </svg>
      <p>
        {view === "xy"
          ? `${number(project.period_nm)} × ${number(project.period_y_nm)} nm`
          : `${number(total)} nm total`}
      </p>
    </figure>
  );
}

export function StructureFallback2D({
  project,
  selected,
  onSelect,
  disabled,
}: {
  project: FallbackProject;
  selected: number;
  onSelect: (index: number) => void;
  disabled: boolean;
}) {
  const projection = useMemo(
    () => buildStructureProjections2D(project, selected),
    [project, selected],
  );
  return (
    <div
      className="s2-fallback"
      role="group"
      aria-label="Structure projections"
    >
      <p className="s2-fallback-notice" role="status">
        2D view · 3D unavailable.
      </p>
      <div className="s2-projections">
        <Projection
          project={project}
          selected={selected}
          view="xy"
          regions={projection.top}
          bounds={projection.topBounds}
          total={projection.totalThickness}
          layers={projection.layers}
          onSelect={onSelect}
          disabled={disabled}
        />
        <Projection
          project={project}
          selected={selected}
          view="xz"
          regions={projection.section}
          bounds={projection.sectionBounds}
          total={projection.totalThickness}
          layers={projection.layers}
          onSelect={onSelect}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
