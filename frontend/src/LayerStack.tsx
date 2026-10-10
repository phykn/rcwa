import { useEffect, useRef } from "react";
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
  onEdit,
  onChange,
}: {
  project: Project;
  selected: number;
  disabled: boolean;
  onSelect: (index: number) => void;
  onEdit: () => void;
  onChange: (operation: StackOperation) => void;
}) {
  const picker = useRef<HTMLDetailsElement>(null);
  const add = useRef<HTMLDetailsElement>(null);
  function close() {
    collapse(add.current, false);
    collapse(picker.current);
  }
  useEffect(() => {
    if (disabled) {
      collapse(add.current, false);
      collapse(picker.current, false);
    }
  }, [disabled]);
  return (
    <details
      className="layer-stack"
      data-testid="layer-stack"
      ref={picker}
      onKeyDown={escapeDisclosure}
      onToggle={(event) => {
        if (!event.currentTarget.open) collapse(add.current, false);
      }}
    >
      <summary
        className="layer-picker-toggle"
        data-testid="layer-picker-toggle"
        aria-label={`Choose layer, selected ${selected + 1}: ${project.layers[selected].name}, ${project.layers.length} ${project.layers.length === 1 ? "layer" : "layers"}`}
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <span>
          Layers <small>· {project.layers.length}</small>
        </span>
        <span className="selected-layer-label">
          {selected + 1} · {project.layers[selected].name}
        </span>
        <span className="chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <fieldset disabled={disabled} className="layer-picker-body">
        <div
          className="stack-rows"
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
              onClick={() => {
                onSelect(index);
                close();
              }}
            >
              <span className="stack-index">{index + 1}</span>
              <span className="stack-name">{layer.name}</span>
              <span className="stack-kind">
                {layer.geometry === "rectangle_1d" ? "Patterned" : "Uniform"}
              </span>
              <span className="stack-thickness">{layer.thickness_nm} nm</span>
            </button>
          ))}
        </div>
        <button
          className="stack-edit"
          onClick={() => {
            close();
            onEdit();
          }}
        >
          Edit selected layer
        </button>
        <details className="stack-add" ref={add} onKeyDown={escapeDisclosure}>
          <summary
            aria-label="Add layer"
            aria-disabled={disabled || project.layers.length >= 8}
            onClick={(event) => {
              if (disabled || project.layers.length >= 8)
                event.preventDefault();
            }}
          >
            Add layer{" "}
            <span className="chevron" aria-hidden="true">
              ⌄
            </span>
          </summary>
          <div>
            <button
              disabled={disabled || project.layers.length >= 8}
              aria-label="Add patterned layer"
              onClick={() => {
                onChange({ type: "add", geometry: "rectangle_1d" });
                close();
              }}
            >
              Patterned
            </button>
            <button
              disabled={disabled || project.layers.length >= 8}
              aria-label="Add uniform layer"
              onClick={() => {
                onChange({ type: "add", geometry: "homogeneous" });
                close();
              }}
            >
              Uniform
            </button>
          </div>
        </details>
      </fieldset>
    </details>
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
