import { useEffect, useRef } from "react";
import { layerColor } from "./layerColors";
import type { KeyboardEvent } from "react";
import type { Project, StackOperation } from "./model";

function collapse(disclosure: HTMLDetailsElement | null, focus = true) {
  if (!disclosure) return;
  disclosure.open = false;
  if (focus) disclosure.querySelector<HTMLElement>(":scope > summary")?.focus();
}
function escapeDisclosure(event: KeyboardEvent<HTMLDetailsElement>) {
  if (event.key !== "Escape" || !event.currentTarget.open) return;
  event.preventDefault();
  event.stopPropagation();
  collapse(event.currentTarget);
}

export function LayerStack({
  project,
  selected,
  disabled,
  onSelect,
  onChange,
}: {
  project: Project;
  selected: number;
  disabled: boolean;
  onSelect: (index: number) => void;
  onChange: (operation: StackOperation) => void;
}) {
  const add = useRef<HTMLDetailsElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = rows.current;
    const chip = container?.querySelector<HTMLElement>(
      `[data-layer-index="${selected}"]`,
    );
    if (!container || !chip) return;
    const left = chip.offsetLeft - container.offsetLeft;
    if (left < container.scrollLeft) container.scrollLeft = left;
    else if (
      left + chip.offsetWidth >
      container.scrollLeft + container.clientWidth
    )
      container.scrollLeft = left + chip.offsetWidth - container.clientWidth;
  }, [selected, project.layers.length]);
  useEffect(() => {
    if (disabled) collapse(add.current, false);
  }, [disabled]);
  return (
    <section
      className="layer-stack"
      data-testid="layer-stack"
      aria-label="Choose a layer"
    >
      <div className="layer-stack-heading">
        <h2>Choose a layer</h2>
        <details className="stack-add" ref={add} onKeyDown={escapeDisclosure}>
          <summary
            aria-label="Add layer"
            aria-disabled={disabled || project.layers.length >= 8}
            onClick={(event) => {
              if (disabled || project.layers.length >= 8)
                event.preventDefault();
            }}
          >
            <span aria-hidden="true">+</span> Add layer
          </summary>
          <div>
            <button
              disabled={disabled || project.layers.length >= 8}
              aria-label="Add patterned layer"
              onClick={() => {
                onChange({ type: "add", geometry: "rectangle_1d" });
                collapse(add.current);
              }}
            >
              <strong>Patterned layer</strong>
              <span>Repeating ridges and gaps</span>
            </button>
            <button
              disabled={disabled || project.layers.length >= 8}
              aria-label="Add uniform layer"
              onClick={() => {
                onChange({ type: "add", geometry: "homogeneous" });
                collapse(add.current);
              }}
            >
              <strong>Uniform film</strong>
              <span>A continuous flat layer</span>
            </button>
          </div>
        </details>
      </div>
      <fieldset disabled={disabled} className="layer-picker-body">
        <div
          className="stack-rows"
          ref={rows}
          role="group"
          aria-label="Finite layers, top to bottom"
        >
          {project.layers.map((layer, index) => (
            <button
              key={index}
              className={`stack-row ${index === selected ? "selected" : ""}`}
              data-layer-index={index}
              aria-label={`Select layer ${index + 1}: ${layer.name}`}
              aria-pressed={index === selected}
              onClick={() => onSelect(index)}
            >
              <span
                className="stack-index"
                style={{ background: layerColor(index) }}
              >
                {index + 1}
              </span>
              <span className="stack-name">{layer.name}</span>
              {index === selected && (
                <span className="stack-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      </fieldset>
    </section>
  );
}

export function LayerActions({
  selected,
  count,
  disabled,
  onChange,
}: {
  selected: number;
  count: number;
  disabled: boolean;
  onChange: (operation: StackOperation) => void;
}) {
  const actions = useRef<HTMLDetailsElement>(null);
  function change(operation: StackOperation) {
    onChange(operation);
    collapse(actions.current);
  }
  return (
    <details
      className="layer-actions"
      ref={actions}
      onKeyDown={escapeDisclosure}
    >
      <summary aria-label="Layer actions">
        Layer actions{" "}
        <span className="chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div>
        <button
          disabled={disabled || selected === 0}
          aria-label={`Move layer ${selected + 1} up`}
          onClick={() => change({ type: "move", direction: -1 })}
        >
          Move up
        </button>
        <button
          disabled={disabled || selected === count - 1}
          aria-label={`Move layer ${selected + 1} down`}
          onClick={() => change({ type: "move", direction: 1 })}
        >
          Move down
        </button>
        <button
          disabled={disabled || count >= 8}
          aria-label={`Duplicate layer ${selected + 1}`}
          onClick={() => change({ type: "duplicate" })}
        >
          Duplicate
        </button>
        <button
          disabled={disabled || count <= 1}
          aria-label={`Remove layer ${selected + 1}`}
          onClick={() => change({ type: "remove" })}
        >
          Remove
        </button>
      </div>
    </details>
  );
}
