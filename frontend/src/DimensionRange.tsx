import { useEffect, useRef, useState } from "react";

export interface DimensionBounds {
  min: number;
  max: number;
}

/** A useful local scale; the paired number field retains the full legal domain. */
export function dimensionTrackBounds(
  value: number,
  min: number,
  max: number,
): DimensionBounds | null {
  if (
    ![value, min, max].every(Number.isFinite) ||
    min < 0 ||
    max < min ||
    value < min ||
    value > max
  )
    return null;
  return {
    min,
    max: Math.min(
      max,
      Math.ceil(Math.max(200, 2 * value, 2 * min) / 100) * 100,
    ),
  };
}

export function dimensionKeyValue(
  key: string,
  value: number,
  bounds: DimensionBounds,
): number | null {
  const offset = {
    ArrowLeft: -1,
    ArrowDown: -1,
    ArrowRight: 1,
    ArrowUp: 1,
    PageDown: -10,
    PageUp: 10,
  }[key];
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  return offset === undefined
    ? null
    : Math.min(bounds.max, Math.max(bounds.min, value + offset));
}

export function dimensionPointerValue(
  value: number,
  bounds: DimensionBounds,
): number | null {
  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max)
    return null;
  if (value === bounds.min || value === bounds.max) return value;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

const exactText = (value: number) =>
  Object.is(value, -0) ? "-0" : String(value);

export function DimensionRange({
  label,
  value,
  min,
  max,
  disabled = false,
  onChange,
  onBeginEdit,
  onEndEdit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
}) {
  const [scale, setScale] = useState(() => ({
    min,
    max,
    track: dimensionTrackBounds(value, min, max),
  }));
  let track = scale.track;
  // Freeze through every drag and its release. Only new constraints or a typed
  // value outside the displayed interval establish a new local interval.
  if (
    min !== scale.min ||
    max !== scale.max ||
    !track ||
    value < track.min ||
    value > track.max
  ) {
    track = dimensionTrackBounds(value, min, max);
    if (track || scale.track) setScale({ min, max, track });
  }
  const active = useRef(false);
  const pointer = useRef<number | null>(null);
  const keys = useRef(new Set<string>());
  const callbacks = useRef({ onChange, onBeginEdit, onEndEdit });
  callbacks.current = { onChange, onBeginEdit, onEndEdit };
  const finish = () => {
    pointer.current = null;
    keys.current.clear();
    if (!active.current) return;
    active.current = false;
    callbacks.current.onEndEdit();
  };
  useEffect(() => {
    const release = (event: globalThis.PointerEvent) => {
      if (event.pointerId === pointer.current) finish();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", finish);
      finish();
    };
  }, []);
  const unavailable = disabled || !track || track.min === track.max;
  useEffect(() => {
    if (unavailable) finish();
  }, [unavailable]);
  if (!track) return null;
  const bounds = track;
  function apply(next: number) {
    if (
      disabled ||
      !Number.isFinite(next) ||
      next < bounds.min ||
      next > bounds.max ||
      Object.is(next, value)
    )
      return;
    // Reasserting this idempotent reducer action also handles native focus
    // transfer: the number field's blur must not split a range gesture.
    callbacks.current.onBeginEdit();
    active.current = true;
    callbacks.current.onChange(next);
    if (pointer.current === null && keys.current.size === 0) finish();
  }
  return (
    <div className="dimension-range">
      <input
        type="range"
        aria-label={`${label} range`}
        aria-valuetext={`${exactText(value)} nanometers`}
        min={bounds.min}
        max={bounds.max}
        step="any"
        value={value}
        disabled={unavailable}
        onPointerDown={(event) => {
          if (disabled || !event.isPrimary || event.button !== 0) return;
          finish();
          pointer.current = event.pointerId;
          // Native focus/blur happens before the first input event. Merely
          // touching/focusing the control does not create an edit transaction.
        }}
        onLostPointerCapture={(event) => {
          if (event.pointerId === pointer.current) finish();
        }}
        onBlur={finish}
        onKeyDown={(event) => {
          if (disabled || event.altKey || event.ctrlKey || event.metaKey)
            return;
          const next = dimensionKeyValue(event.key, value, bounds);
          if (next === null) return;
          event.preventDefault();
          keys.current.add(event.key);
          apply(next);
        }}
        onKeyUp={(event) => {
          if (!keys.current.delete(event.key)) return;
          if (keys.current.size === 0) finish();
        }}
        onChange={(event) => {
          const next =
            pointer.current === null
              ? event.target.valueAsNumber
              : dimensionPointerValue(event.target.valueAsNumber, bounds);
          // Coarse pointer adjustment uses whole nanometers, while true/local
          // fractional endpoints stay reachable. Rendering never rounds inputs.
          if (next !== null) apply(next);
        }}
      />
      <div className="range-labels" aria-hidden="true">
        <span>{exactText(bounds.min)} nm</span>
        <span>{exactText(bounds.max)} nm</span>
      </div>
    </div>
  );
}
