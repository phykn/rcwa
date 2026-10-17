import { useId, useState } from "react";
import { useStore } from "../state/store";

export interface NumberFieldProps {
  label: string;
  value: number;
  unit?: string;
  min: number;
  max: number;
  /** Upper end of the slider; typing still accepts values up to max. */
  sliderMax?: number;
  step?: number;
  integer?: boolean;
  slider?: boolean;
  hint?: string;
  onChange: (value: number) => void;
}

const format = (value: number) => String(Math.round(value * 1e6) / 1e6);

/** Exact typed value plus a coarse slider; a drag is one undo step. */
export function NumberField({
  label,
  value,
  unit,
  min,
  max,
  sliderMax,
  step = 1,
  integer,
  slider = true,
  hint,
  onChange,
}: NumberFieldProps) {
  const id = useId();
  // Non-null only while the person is typing; otherwise the store value shows.
  const [typed, setTyped] = useState<string | null>(null);
  const focused = typed !== null;
  const draft = typed ?? format(value);
  const setDraft = setTyped;
  const beginGesture = useStore((s) => s.beginGesture);
  const endGesture = useStore((s) => s.endGesture);

  const parsed = Number(draft.trim());
  const error =
    draft.trim() === "" || !Number.isFinite(parsed)
      ? "Enter a number"
      : integer && !Number.isInteger(parsed)
        ? "Enter a whole number"
        : parsed < min || parsed > max
          ? `Use ${format(min)}–${format(max)}${unit ? ` ${unit}` : ""}`
          : null;

  function commit(text = draft) {
    const next = Number(text.trim());
    if (text.trim() !== "" && Number.isFinite(next) && next >= min && next <= max && (!integer || Number.isInteger(next)))
      onChange(next);
  }

  const top = Math.max(sliderMax ?? max, value);
  return (
    <div className={`field${error && focused ? " field-invalid" : ""}`}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className="field-input">
        <input
          id={id}
          inputMode="decimal"
          value={draft}
          aria-invalid={!!error}
          aria-describedby={error || hint ? `${id}-note` : undefined}
          onFocus={() => setTyped(format(value))}
          onBlur={() => setTyped(null)}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const delta = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
              const next = Math.min(max, Math.max(min, Number(format(value + delta))));
              setDraft(format(next));
              onChange(next);
            }
          }}
        />
        {unit && <span className="field-unit">{unit}</span>}
      </div>
      {slider && (
        <input
          type="range"
          className="field-slider"
          aria-label={`${label} slider`}
          min={min}
          max={top}
          step={step}
          value={Math.min(value, top)}
          onPointerDown={beginGesture}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          onKeyDown={(e) => !e.repeat && beginGesture()}
          onKeyUp={endGesture}
          onBlur={endGesture}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}
      {(error && focused) || hint ? (
        <p id={`${id}-note`} className={error && focused ? "field-error" : "field-hint"} aria-live="polite">
          {error && focused ? error : hint}
        </p>
      ) : null}
    </div>
  );
}
