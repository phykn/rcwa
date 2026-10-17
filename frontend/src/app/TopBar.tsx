import { useEffect, useRef, useState } from "react";
import { apiProjects, ordersCsv, spectrumCsv } from "../core/exporters";
import { download, fileSlug, parseProjectFile, serializeDesign } from "../core/projectFile";
import { encodeShare } from "../core/share";
import { isProposal, reviewProposal, type ProposalReview } from "../core/proposal";
import { ProposalDialog } from "../features/ProposalDialog";
import type { EngineState } from "../engine";
import { useServices } from "../state/context";
import { useStore } from "../state/store";
import { Popover } from "../ui/Popover";

function EngineBadge() {
  const { hub } = useServices();
  const [state, setState] = useState<EngineState>(hub.state);
  useEffect(() => hub.subscribe(setState), [hub]);
  const { browser, active } = state;
  const text =
    active === "server"
      ? "Local server"
      : browser.phase === "ready"
        ? `In browser · ${browser.workers} ${browser.workers === 1 ? "worker" : "workers"}`
        : browser.phase === "failed"
          ? "Engine unavailable"
          : browser.phase === "loading"
            ? `${browser.detail || "Starting engine"}…`
            : "Engine idle";
  return (
    <span className={`engine-badge engine-${active === "server" ? "ready" : browser.phase}`} role="status" title={browser.phase === "failed" ? browser.detail : undefined}>
      <span className="engine-dot" aria-hidden />
      {text}
    </span>
  );
}

export function TopBar({
  onTemplates,
  onLibrary,
  onPalette,
  onSettings,
  onTour,
}: {
  onTemplates: () => void;
  onLibrary: () => void;
  onPalette: () => void;
  onSettings: () => void;
  onTour: () => void;
}) {
  const design = useStore((s) => s.design);
  const full = useStore((s) => s.full);
  const key = useStore((s) => s.key);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const { undo, redo, edit, replace, notify } = useStore.getState();
  const [menu, setMenu] = useState<"export" | null>(null);
  const [proposal, setProposal] = useState<ProposalReview | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const slug = fileSlug(design.name);
  const current = full?.key === key ? full.result : null;

  async function share() {
    const url = `${location.origin}${location.pathname}#${await encodeShare(design)}`;
    history.replaceState(null, "", url);
    try {
      await navigator.clipboard.writeText(url);
      notify("Link copied. It contains the whole design.");
    } catch {
      notify("Link is in the address bar. Copy it to share the design.");
    }
  }

  async function open(selected: File) {
    try {
      const text = await selected.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // parseProjectFile reports malformed JSON with its own message.
      }
      if (isProposal(parsed)) {
        setProposal(reviewProposal(text, useStore.getState().design));
        return;
      }
      const { design: next, notes } = parseProjectFile(text);
      replace(next);
      notify(notes.length ? `Opened ${selected.name}. ${notes.join(" ")}` : `Opened ${selected.name}`);
    } catch (error) {
      notify(`Could not open ${selected.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
          <path d="M3 18h18M5 18V9m4 9V6m4 12V9m4 9V6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        </svg>
        <span>RCWA Workbench</span>
      </div>
      <input
        className="design-name"
        aria-label="Design name"
        value={design.name}
        maxLength={100}
        onChange={(e) => e.target.value.trim() && edit((d) => ({ ...d, name: e.target.value }))}
      />
      <EngineBadge />
      <nav className="topbar-actions" aria-label="Design actions">
        <button type="button" className="btn btn-quiet" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
          Undo
        </button>
        <button type="button" className="btn btn-quiet" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">
          Redo
        </button>
        <span className="divider" aria-hidden />
        <button type="button" className="btn btn-quiet" onClick={onTemplates}>
          Examples
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => file.current?.click()}>
          Open
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const selected = e.target.files?.[0];
            e.target.value = "";
            if (selected) void open(selected);
          }}
        />
        <button type="button" className="btn btn-quiet" onClick={onLibrary}>
          Saved
        </button>
        <div className="menu-wrap">
          <button type="button" className="btn btn-quiet" aria-haspopup="dialog" aria-expanded={menu === "export"} onClick={() => setMenu("export")}>
            Export
          </button>
          {menu === "export" && (
            <Popover label="Export" onClose={() => setMenu(null)} className="menu menu-right">
              <button type="button" className="menu-item" onClick={() => download(`${slug}.rcwa.json`, serializeDesign(design))}>
                Design file (.json)
              </button>
              <button type="button" className="menu-item" onClick={() => download(`${slug}-api.json`, apiProjects(design))}>
                API/MCP project (.json)
              </button>
              <button
                type="button"
                className="menu-item"
                disabled={!current}
                onClick={() => current && download(`${slug}-spectrum.csv`, spectrumCsv(current), "text/csv")}
              >
                Spectrum (.csv)
              </button>
              <button
                type="button"
                className="menu-item"
                disabled={!current}
                onClick={() => current && download(`${slug}-orders.csv`, ordersCsv(current), "text/csv")}
              >
                Diffraction orders (.csv)
              </button>
              <button
                type="button"
                className="menu-item"
                disabled={!current}
                onClick={async () => {
                  const { reportHtml } = await import("../core/report");
                  if (current) download(`${slug}-report.html`, reportHtml(design, current), "text/html");
                }}
              >
                Report (.html)
              </button>
              {!current && <p className="menu-note">Calculate first to export results.</p>}
            </Popover>
          )}
        </div>
        <button type="button" className="btn btn-quiet" onClick={() => void share()}>
          Share link
        </button>
        <span className="divider" aria-hidden />
        <button type="button" className="btn btn-quiet" onClick={onPalette} title="Command palette (⌘K)">
          ⌘K
        </button>
        <button type="button" className="btn btn-quiet" onClick={onTour}>
          Guide
        </button>
        <button type="button" className="btn btn-quiet" onClick={onSettings}>
          Settings
        </button>
      </nav>
      {proposal && <ProposalDialog review={proposal} onClose={() => setProposal(null)} />}
    </header>
  );
}
