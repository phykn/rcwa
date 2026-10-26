import { lazy, Suspense, useEffect, useState } from "react";
import { Inspector } from "../features/Inspector";
import { ResultsPanel } from "../features/results/ResultsPanel";
import { StackPanel } from "../features/StackPanel";
import { TemplatesDialog } from "../features/TemplatesDialog";
import { useStore } from "../state/store";
import { TopBar } from "./TopBar";

const Viewport3D = lazy(() => import("../features/Viewport3D").then((m) => ({ default: m.Viewport3D })));

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

export function App() {
  const [templates, setTemplates] = useState(false);
  const [pane, setPane] = useState<Pane>("structure");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z" && !typing(e.target)) {
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
      <TopBar onTemplates={() => setTemplates(true)} />
      <nav className="pane-tabs" aria-label="Workspace sections">
        {(["structure", "edit", "results"] as const).map((p) => (
          <button key={p} type="button" aria-pressed={pane === p} onClick={() => setPane(p)}>
            {p === "structure" ? "Structure" : p === "edit" ? "Edit" : "Results"}
          </button>
        ))}
      </nav>
      <main className="workspace">
        <div className="col-stack pane-structure">
          <div className="viewport-wrap">
            <Suspense fallback={<div className="viewport" aria-busy="true" />}>
              <Viewport3D />
            </Suspense>
          </div>
          <StackPanel />
        </div>
        <div className="col-center pane-results" id="results">
          <ResultsPanel />
        </div>
        <aside className="col-inspector pane-edit" aria-label="Inspector">
          <Inspector />
        </aside>
      </main>
      <Notice />
      {templates && <TemplatesDialog onClose={() => setTemplates(false)} />}
    </div>
  );
}
