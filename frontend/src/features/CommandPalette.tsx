import { useMemo, useState } from "react";
import { newLayer } from "../core/design";
import { useServices } from "../state/context";
import { useStore, type ResultTab } from "../state/store";
import { Dialog } from "../ui/Dialog";
import { SHAPES } from "./Inspector";

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({
  onClose,
  open,
}: {
  onClose: () => void;
  open: (what: "templates" | "library" | "settings" | "tour") => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { calc } = useServices();
  const design = useStore((s) => s.design);

  const commands = useMemo<Command[]>(() => {
    const s = useStore.getState();
    const tabs: [ResultTab, string][] = [
      ["spectrum", "Spectrum"],
      ["orders", "Diffraction orders"],
      ["sweep", "Parameter sweep"],
      ["field", "Field map"],
      ["convergence", "Convergence check"],
      ["fit", "Fit to measurement"],
    ];
    return [
      { id: "calc", label: "Calculate now", hint: "Full accuracy", run: calc.solveNow },
      { id: "undo", label: "Undo", hint: "⌘Z", run: s.undo },
      { id: "redo", label: "Redo", hint: "⇧⌘Z", run: s.redo },
      ...SHAPES.map((shape) => ({
        id: `add-${shape.value}`,
        label: `Add layer: ${shape.title.toLowerCase()}`,
        run: () =>
          design.layers.length < 8 &&
          s.edit((d) => ({ ...d, layers: [...d.layers, newLayer(shape.value, d, d.layers.length)] })),
      })),
      ...design.layers.map((l, i) => ({
        id: `select-${i}`,
        label: `Select layer ${i + 1}: ${l.name}`,
        run: () => s.select({ kind: "layer", index: i }),
      })),
      { id: "substrate", label: "Select substrate", run: () => s.select({ kind: "substrate" }) },
      { id: "ambient", label: "Select incident medium", run: () => s.select({ kind: "ambient" }) },
      ...tabs.map(([tab, label]) => ({ id: `tab-${tab}`, label: `Show ${label.toLowerCase()}`, run: () => s.setTab(tab) })),
      { id: "templates", label: "Open examples", run: () => open("templates") },
      { id: "library", label: "Open saved designs", run: () => open("library") },
      { id: "settings", label: "Open settings", run: () => open("settings") },
      { id: "tour", label: "Show the guide", run: () => open("tour") },
      {
        id: "auto",
        label: s.settings.autoSolve ? "Turn off automatic calculation" : "Turn on automatic calculation",
        run: () => s.updateSettings({ autoSolve: !s.settings.autoSolve }),
      },
      {
        id: "theme",
        label: "Switch light/dark theme",
        run: () => {
          const dark =
            s.settings.theme === "dark" ||
            (s.settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
          s.updateSettings({ theme: dark ? "light" : "dark" });
        },
      },
    ];
  }, [calc, design.layers, open]);

  const q = query.trim().toLowerCase();
  const shown = commands.filter((c) => !q || c.label.toLowerCase().includes(q));
  const index = Math.min(active, shown.length - 1);
  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    <Dialog title="Commands" onClose={onClose}>
      <input
        className="popover-search"
        placeholder="Type a command"
        aria-label="Search commands"
        aria-controls="palette-list"
        aria-activedescendant={shown[index] ? `cmd-${shown[index].id}` : undefined}
        value={query}
        autoFocus
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, shown.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter") run(shown[index]);
          else return;
          e.preventDefault();
        }}
      />
      <ul id="palette-list" className="palette-list" role="listbox" aria-label="Commands">
        {shown.map((c, i) => (
          <li
            key={c.id}
            id={`cmd-${c.id}`}
            role="option"
            aria-selected={i === index}
            className={i === index ? "active" : ""}
            onMouseEnter={() => setActive(i)}
            onClick={() => run(c)}
          >
            <span>{c.label}</span>
            {c.hint && <kbd>{c.hint}</kbd>}
          </li>
        ))}
        {!shown.length && <li className="empty-note">No command matches “{query}”.</li>}
      </ul>
    </Dialog>
  );
}
