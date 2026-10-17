import { useId } from "react";

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  hideLabel,
}: {
  label: string;
  hideLabel?: boolean;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <span className={hideLabel ? "visually-hidden" : "field-label"} id={id}>
        {label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={id}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            title={option.title}
            className={option.value === value ? "on" : ""}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => {
              const i = options.findIndex((o) => o.value === value);
              const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!delta) return;
              e.preventDefault();
              const next = options[(i + delta + options.length) % options.length];
              onChange(next.value);
              (e.currentTarget.parentElement?.children[options.indexOf(next)] as HTMLElement | undefined)?.focus();
            }}
            tabIndex={option.value === value ? 0 : -1}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
