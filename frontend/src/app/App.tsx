import { useCallback, useEffect, useState } from "react";
import { CommandPalette } from "../features/CommandPalette";
import { Inspector } from "../features/Inspector";
import { LibraryDialog } from "../features/LibraryDialog";
import { ResultsPanel } from "../features/results/ResultsPanel";
import { SettingsDialog } from "../features/SettingsDialog";
import { StackPanel } from "../features/StackPanel";
import { TemplatesDialog } from "../features/TemplatesDialog";
import { Tour } from "../features/Tour";
import { Viewport3D } from "../features/Viewport3D";
import { useStore } from "../state/store";
import { TopBar } from "./TopBar";

type Modal = "templates" | "library" | "settings" | "palette" | "tour" | null;
type Pane = "structure" | "edit" | "results";

function Notice() {
  const notice = useStore((s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => useStore.setState({ notice: null }), notice.tone === "error" ? 9000 : 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  return (
    <div className={`notice notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
      {notice.text}
      <button type="button" className="btn btn-quiet" onClick={() => useStore.setState({ notice: null })} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function App({ firstVisit }: { firstVisit: boolean }) {
  const [modal, setModal] = useState<Modal>(firstVisit ? "tour" : null);
  const [pane, setPane] = useState<Pane>("structure");
  const theme = useStore((s) => s.settings.theme);
  const close = useCallback(() => setModal(null), []);
  const open = useCallback((what: Exclude<Modal, null | "palette">) => setModal(what), []);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setModal((m) => (m === "palette" ? null : "palette"));
      } else if (mod && e.key.toLowerCase() === "z" && !typing(e.target)) {
        e.preventDefault();
        if (e.shiftKey) useStore.getState().redo();
        else useStore.getState().undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app" data-pane={pane}>
      <a className="skip" href="#results">
        Skip to results
      </a>
      <TopBar
        onTemplates={() => setModal("templates")}
        onLibrary={() => setModal("library")}
        onPalette={() => setModal("palette")}
        onSettings={() => setModal("settings")}
        onTour={() => setModal("tour")}
      />
      <nav className="pane-tabs" aria-label="Workspace sections">
        {(["structure", "edit", "results"] as const).map((p) => (
          <button key={p} type="button" aria-pressed={pane === p} onClick={() => setPane(p)}>
            {p === "structure" ? "Structure" : p === "edit" ? "Edit" : "Results"}
          </button>
        ))}
      </nav>
      <main className="workspace">
        <div className="col-stack pane-structure" data-tour="stack">
          <StackPanel />
        </div>
        <div className="col-center">
          <div className="pane-structure viewport-wrap">
            <Viewport3D />
          </div>
          <div className="pane-results" id="results" data-tour="results">
            <ResultsPanel />
          </div>
        </div>
        <aside className="col-inspector pane-edit" aria-label="Inspector" data-tour="inspector">
          <Inspector />
        </aside>
      </main>
      <Notice />
      {modal === "templates" && <TemplatesDialog onClose={close} />}
      {modal === "library" && <LibraryDialog onClose={close} />}
      {modal === "settings" && <SettingsDialog onClose={close} />}
      {modal === "palette" && <CommandPalette onClose={close} open={open} />}
      {modal === "tour" && <Tour onClose={close} />}
    </div>
  );
}
