import type { Layer2D } from "../core/project2d";
import type { Material } from "../core/model";
import { convertLayer, describeRange, patternKind, wavelengthRange } from "../core/design";
import type { Design } from "../engine/types";
import { useStore } from "../state/store";
import { MaterialField } from "../ui/MaterialField";
import { NumberField } from "../ui/NumberField";
import { Segmented } from "../ui/Segmented";

export const SHAPES: {
  value: Layer2D["geometry"];
  label: string;
  title: string;
}[] = [
  { value: "homogeneous", label: "Film", title: "Uniform film" },
  {
    value: "rectangle_1d",
    label: "Lines",
    title: "Lines along y (1D grating)",
  },
  { value: "rectangle_2d", label: "Blocks", title: "Rectangular blocks (2D)" },
  { value: "circular_hole_2d", label: "Holes", title: "Circular holes (2D)" },
];

const thicknessTop = (value: number) =>
  Math.min(2000, Math.max(400, Math.ceil((value * 2) / 100) * 100));

function span(design: Design): [number, number] {
  const ws = design.illumination.wavelengths_nm;
  return [ws[0], ws[ws.length - 1]];
}

function LayerEditor({ design, index }: { design: Design; index: number }) {
  const edit = useStore((s) => s.edit);
  const layer = design.layers[index];
  const update = (patch: Partial<Layer2D>) =>
    edit((d) => ({
      ...d,
      layers: d.layers.map((l, i) =>
        i === index ? ({ ...l, ...patch } as Layer2D) : l,
      ),
    }));
  const setMaterial =
    (key: "material" | "background") => (material: Material) =>
      update({ [key]: material });
  const px = design.period_nm;
  const py = design.period_y_nm;
  return (
    <section className="inspector-section" aria-labelledby="layer-heading">
      <div className="section-head">
        <h2 id="layer-heading">Layer {index + 1}</h2>
        <input
          className="name-input"
          aria-label="Layer name"
          value={layer.name}
          maxLength={100}
          onChange={(e) =>
            e.target.value.trim() && update({ name: e.target.value })
          }
        />
      </div>
      <Segmented
        label="Shape"
        value={layer.geometry}
        options={SHAPES}
        onChange={(kind) =>
          edit((d) => ({
            ...d,
            layers: d.layers.map((l, i) =>
              i === index ? convertLayer(l, kind, d) : l,
            ),
          }))
        }
      />
      <div className="field-grid">
        <NumberField
          label="Thickness"
          unit="nm"
          value={layer.thickness_nm}
          min={0}
          max={2000}
          sliderMax={thicknessTop(layer.thickness_nm)}
          onChange={(v) => update({ thickness_nm: v })}
        />
        {layer.geometry === "circular_hole_2d" && (
          <NumberField
            label="Hole diameter"
            unit="nm"
            value={layer.diameter_nm}
            min={0}
            max={Math.min(px, py)}
            onChange={(v) => update({ diameter_nm: v })}
          />
        )}
        {layer.geometry === "rectangle_2d" && (
          <>
            <NumberField
              label="Width X"
              unit="nm"
              value={layer.cd_x_nm}
              min={0}
              max={px}
              onChange={(v) => update({ cd_x_nm: v })}
            />
            <NumberField
              label="Width Y"
              unit="nm"
              value={layer.cd_y_nm}
              min={0}
              max={py}
              onChange={(v) => update({ cd_y_nm: v })}
            />
          </>
        )}
        {layer.geometry === "rectangle_1d" && (
          <NumberField
            label="Line width"
            unit="nm"
            value={layer.cd_nm}
            min={0}
            max={px}
            onChange={(v) => update({ cd_nm: v })}
          />
        )}
      </div>
      {layer.geometry === "homogeneous" ? (
        <MaterialField
          label="Material"
          material={layer.material}
          span={span(design)}
          onChange={setMaterial("material")}
        />
      ) : layer.geometry === "circular_hole_2d" ? (
        <>
          <MaterialField
            label="Host"
            material={layer.background}
            span={span(design)}
            onChange={setMaterial("background")}
          />
          <MaterialField
            label="Hole fill"
            material={layer.material}
            span={span(design)}
            onChange={setMaterial("material")}
          />
        </>
      ) : (
        <>
          <MaterialField
            label={layer.geometry === "rectangle_1d" ? "Line" : "Block"}
            material={layer.material}
            span={span(design)}
            onChange={setMaterial("material")}
          />
          <MaterialField
            label="Gap"
            material={layer.background}
            span={span(design)}
            onChange={setMaterial("background")}
          />
        </>
      )}
    </section>
  );
}

function MediumEditor({
  design,
  which,
}: {
  design: Design;
  which: "ambient" | "substrate";
}) {
  const edit = useStore((s) => s.edit);
  return (
    <section className="inspector-section" aria-labelledby="medium-heading">
      <div className="section-head">
        <h2 id="medium-heading">
          {which === "ambient" ? "Incident medium" : "Substrate"}
        </h2>
      </div>
      <p className="section-note">
        {which === "ambient"
          ? "Light arrives through this half-space. It must be lossless."
          : "Semi-infinite below the stack. Transmission is measured into it."}
      </p>
      <MaterialField
        label="Material"
        material={design[which]}
        span={span(design)}
        lossless={which === "ambient"}
        onChange={(material) => edit((d) => ({ ...d, [which]: material }))}
      />
    </section>
  );
}

function LatticeEditor({ design }: { design: Design }) {
  const edit = useStore((s) => s.edit);
  const square = design.period_nm === design.period_y_nm;
  return (
    <section className="inspector-section" aria-labelledby="lattice-heading">
      <div className="section-head">
        <h2 id="lattice-heading">Pattern spacing</h2>
      </div>
      <div className="field-grid">
        <NumberField
          label={square ? "Pitch" : "Pitch X"}
          unit="nm"
          value={design.period_nm}
          min={20}
          max={5000}
          sliderMax={Math.max(1000, design.period_nm * 2)}
          onChange={(v) =>
            edit((d) => ({
              ...d,
              period_nm: v,
              period_y_nm: square ? v : d.period_y_nm,
            }))
          }
        />
        {!square && (
          <NumberField
            label="Pitch Y"
            unit="nm"
            value={design.period_y_nm}
            min={20}
            max={5000}
            sliderMax={Math.max(1000, design.period_y_nm * 2)}
            onChange={(v) => edit((d) => ({ ...d, period_y_nm: v }))}
          />
        )}
      </div>
    </section>
  );
}

function LightEditor({ design }: { design: Design }) {
  const edit = useStore((s) => s.edit);
  const light = design.illumination;
  const range = describeRange(light.wavelengths_nm);
  const setRange = (start: number, end: number, points: number) =>
    edit((d) => ({
      ...d,
      illumination: {
        ...d.illumination,
        wavelengths_nm: wavelengthRange(
          start,
          Math.max(end, start + 1),
          points,
        ),
      },
    }));
  return (
    <section className="inspector-section" aria-labelledby="light-heading">
      <div className="section-head">
        <h2 id="light-heading">Light</h2>
        {!range.uniform && <span className="tag">Custom samples</span>}
      </div>
      <div className="field-grid">
        <NumberField
          label="From"
          unit="nm"
          value={range.start}
          min={200}
          max={2490}
          slider={false}
          onChange={(v) => setRange(v, range.end, range.points)}
        />
        <NumberField
          label="To"
          unit="nm"
          value={range.end}
          min={210}
          max={2500}
          slider={false}
          // A single-wavelength design has no spacing yet; widening it needs samples.
          onChange={(v) =>
            setRange(range.start, v, range.points > 1 ? range.points : 21)
          }
        />
      </div>
      <div className="field-grid">
        <NumberField
          label="Angle of incidence"
          unit="°"
          value={light.angle_deg}
          min={0}
          max={75}
          step={0.5}
          onChange={(v) =>
            edit((d) => ({
              ...d,
              illumination: { ...d.illumination, angle_deg: v },
            }))
          }
        />
        <NumberField
          label="Azimuth φ"
          unit="°"
          value={light.azimuth_deg}
          min={0}
          max={359.9}
          step={1}
          onChange={(v) =>
            edit((d) => ({
              ...d,
              illumination: { ...d.illumination, azimuth_deg: v },
            }))
          }
        />
      </div>
      <Segmented
        label="Polarization"
        value={light.polarization}
        options={[
          { value: "s", label: "s (TE)" },
          { value: "p", label: "p (TM)" },
          { value: "both", label: "Both" },
        ]}
        onChange={(polarization) =>
          edit((d) => ({
            ...d,
            illumination: { ...d.illumination, polarization },
          }))
        }
      />
    </section>
  );
}

export function Inspector() {
  const design = useStore((s) => s.design);
  const selection = useStore((s) => s.selection);
  return (
    <div className="inspector">
      {selection.kind === "layer" ? (
        <LayerEditor design={design} index={selection.index} />
      ) : (
        <MediumEditor design={design} which={selection.kind} />
      )}
      {/* Pitch has no effect on a stack of uniform films. */}
      {patternKind(design) !== "film" && <LatticeEditor design={design} />}
      <LightEditor design={design} />
    </div>
  );
}
