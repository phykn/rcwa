import { useEffect, useId, useRef, useState } from "react";
import type { StructureGeometryProject2D } from "./structureGeometry2d";
import "./structure2d.css";

export type DimensionAxis2D = "x" | "y";
export type DimensionSheet2D = "width" | "pitch";
export interface DimensionField2D {
  readonly axis: DimensionAxis2D;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly minimumReason?: string;
}

export function exactDimensionText2D(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/**
 * Cards prefer the accepted six-significant-digit display. Long values use four
 * significant digits, then two in scientific notation so X/Y and nm still fit.
 * Exact input is retained in the accessible name, tooltip, and numeric editor.
 */
export function formatDimension2D(value: number): string {
  if (Object.is(value, -0)) return "-0";
  const six = Number(value.toPrecision(6)).toString();
  if (six.length <= 6) return six;
  const four = Number(value.toPrecision(4)).toString();
  return four.length <= 7 ? four : value.toExponential(1).replace("e+", "e");
}

/** A rejected draft is never converted to zero, clamped, or submitted on blur. */
export function parseDimensionDraft2D(
  text: string,
  min: number,
  max: number,
): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()))
    return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export function dimensionFields2D(
  project: StructureGeometryProject2D,
  selectedLayer: number,
  kind: DimensionSheet2D,
): readonly DimensionField2D[] {
  if (kind === "pitch")
    return (["x", "y"] as const).map((axis) => {
      const bound = project.layers.reduce(
        (largest, layer, index) => {
          const width =
            layer.geometry === "rectangle_2d"
              ? axis === "x"
                ? layer.cd_x_nm
                : layer.cd_y_nm
              : layer.geometry === "rectangle_1d" && axis === "x"
                ? layer.cd_nm
                : 0;
          return width > largest.value ? { value: width, index } : largest;
        },
        { value: 20, index: -1 },
      );
      const label = `Pitch ${axis.toUpperCase()}`;
      return {
        axis,
        label,
        value: axis === "x" ? project.period_nm : project.period_y_nm,
        min: bound.value,
        max: 5000,
        minimumReason: `${label} must be at least ${exactDimensionText2D(bound.value)} nm${bound.index >= 0 ? ` because of Layer ${bound.index + 1}` : ""}.`,
      };
    });
  const layer = project.layers[selectedLayer];
  if (!layer || layer.geometry === "homogeneous") return [];
  const fields: DimensionField2D[] = [
    {
      axis: "x",
      label: "Width X",
      value: layer.geometry === "rectangle_2d" ? layer.cd_x_nm : layer.cd_nm,
      min: 0,
      max: project.period_nm,
    },
  ];
  if (layer.geometry === "rectangle_2d")
    fields.push({
      axis: "y",
      label: "Width Y",
      value: layer.cd_y_nm,
      min: 0,
      max: project.period_y_nm,
    });
  return fields;
}

function NumericDimensionField2D({
  field,
  disabled,
  onChange,
  onBeginEdit,
  onEndEdit,
}: {
  field: DimensionField2D;
  disabled: boolean;
  onChange: (value: number) => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
}) {
  const { label, value, min, max, minimumReason } = field;
  const id = useId();
  const [draft, setDraft] = useState(exactDimensionText2D(value));
  const active = useRef(false);
  const lastApplied = useRef(value);
  const callbacks = useRef({ onBeginEdit, onEndEdit });
  callbacks.current = { onBeginEdit, onEndEdit };
  const finish = () => {
    if (!active.current) return;
    active.current = false;
    callbacks.current.onEndEdit();
  };
  useEffect(() => {
    // Preserve text while our own valid edit is echoed back. Undo/import/reset
    // replaces it with the new exact input rather than leaving a stale draft.
    if (!Object.is(value, lastApplied.current)) {
      lastApplied.current = value;
      setDraft(exactDimensionText2D(value));
    }
  }, [value]);
  useEffect(() => {
    if (disabled && active.current) {
      active.current = false;
      callbacks.current.onEndEdit();
    }
  }, [disabled]);
  useEffect(
    () => () => {
      if (active.current) {
        active.current = false;
        callbacks.current.onEndEdit();
      }
    },
    [],
  );
  const valid = parseDimensionDraft2D(draft, min, max) !== null;
  const reason =
    minimumReason && Number(draft) < min && draft.trim() !== ""
      ? minimumReason
      : `${label} must be ${exactDimensionText2D(min)}–${exactDimensionText2D(max)} nm.`;
  return (
    <div className="s2-field">
      <label htmlFor={id}>
        {label}
        <span>nm</span>
      </label>
      <input
        id={id}
        data-axis={field.axis}
        type="number"
        inputMode="decimal"
        step="any"
        min={min}
        max={max}
        disabled={disabled}
        value={draft}
        aria-invalid={!valid}
        aria-describedby={!valid ? `${id}-error` : undefined}
        onFocus={() => {
          if (disabled || active.current) return;
          active.current = true;
          callbacks.current.onBeginEdit();
        }}
        onBlur={finish}
        onChange={(event) => {
          if (disabled) return;
          const text = event.target.value;
          setDraft(text);
          const next = parseDimensionDraft2D(text, min, max);
          if (next === null || Object.is(next, value)) return;
          if (!active.current) {
            active.current = true;
            callbacks.current.onBeginEdit();
          }
          lastApplied.current = next;
          onChange(next);
        }}
      />
      {!valid && (
        <p id={`${id}-error`} className="s2-error" role="alert">
          {reason} {draft || "This value"} is not applied. Keeping{" "}
          {exactDimensionText2D(value)} nm.
        </p>
      )}
    </div>
  );
}

export interface DimensionEditor2DProps {
  project: StructureGeometryProject2D;
  selectedLayer: number;
  kind: DimensionSheet2D;
  onChange: (axis: DimensionAxis2D, value: number) => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onDone: () => void;
  disabled?: boolean;
}

/** The parent owns native dialog, title, Close/Escape handling and focus return. */
export function DimensionEditor2D({
  project,
  selectedLayer,
  kind,
  onChange,
  onBeginEdit,
  onEndEdit,
  onDone,
  disabled = false,
}: DimensionEditor2DProps) {
  const fields = dimensionFields2D(project, selectedLayer, kind);
  return (
    <div className="s2-editor">
      <p className="s2-sheet-help">
        {kind === "pitch"
          ? "Repeat spacing for all layers."
          : "Size of one pattern within each repeat."}
      </p>
      {fields.map((field) => (
        <NumericDimensionField2D
          key={`${kind}-${selectedLayer}-${field.axis}`}
          field={field}
          disabled={disabled}
          onChange={(value) => onChange(field.axis, value)}
          onBeginEdit={onBeginEdit}
          onEndEdit={onEndEdit}
        />
      ))}
      <button type="button" className="s2-done" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
