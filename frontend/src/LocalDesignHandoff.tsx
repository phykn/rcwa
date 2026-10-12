import { useEffect, useRef } from "react";
import type { Project } from "./model";
import { downloadProject, stackSummary, validateProject } from "./model";

export const LOCAL_SETUP_URL = "https://github.com/phykn/rcwa#quickstart";
export const POSIX_LOCAL_SETUP = `git clone https://github.com/phykn/rcwa.git
cd rcwa
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-lock.txt
cd frontend && npm ci && cd ..
.venv/bin/python scripts/start_local.py`;
export const WINDOWS_LOCAL_SETUP = `git clone https://github.com/phykn/rcwa.git
cd rcwa
py -3.12 -m venv .venv
.\\.venv\\Scripts\\python.exe -m pip install -r backend/requirements-lock.txt
cd frontend
npm ci
cd ..
.\\.venv\\Scripts\\python.exe scripts\\start_local.py`;

export function LocalDesignHandoff({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.showModal();
    node?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => {
      node?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const valid = validateProject(project).length === 0;
  return (
    <dialog
      ref={dialog}
      className="local-handoff"
      aria-labelledby="local-handoff-title"
      aria-describedby="local-handoff-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="local-handoff-body">
        <div className="sheet-heading">
          <h2 id="local-handoff-title">Use this design locally</h2>
          <button
            className="icon-button"
            aria-label="Close local setup"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p id="local-handoff-description">
          This page cannot calculate edited inputs. Export this design, then run
          it with the free local Python solver.
        </p>
        <ol className="local-handoff-steps">
          <li>
            <h3>Export your current inputs</h3>
            <p className="local-handoff-project">
              {project.name}
              <br />
              {stackSummary(project)}
            </p>
            <button
              className="preview-result-button"
              disabled={!valid}
              onClick={() => downloadProject(project, null, null)}
            >
              Export current inputs
            </button>
            <p className="local-handoff-note">
              Input-only JSON. No example spectrum is included.
            </p>
            {!valid && (
              <p role="alert">Fix the input errors before exporting.</p>
            )}
          </li>
          <li>
            <h3>Start the local workbench</h3>
            <p>
              Requires Git, Python 3.12+ and Node.js 22.13+ (22.x) or 24+. Install
              once, then keep the launcher terminal open. Ctrl+C stops both the
              editor and solver.
            </p>
            <details>
              <summary>First-time setup commands</summary>
              <h4>macOS / Linux</h4>
              <pre>
                <code>{POSIX_LOCAL_SETUP}</code>
              </pre>
              <h4>Windows PowerShell</h4>
              <pre>
                <code>{WINDOWS_LOCAL_SETUP}</code>
              </pre>
              <p>After the first setup, restart with the last command only.</p>
            </details>
            <p>
              <a href={LOCAL_SETUP_URL} target="_blank" rel="noreferrer">
                Full local setup guide ↗
              </a>
            </p>
          </li>
          <li>
            <h3>Import and calculate</h3>
            <p>
              Open{" "}
              <a href="http://127.0.0.1:5173" target="_blank" rel="noreferrer">
                127.0.0.1:5173
              </a>
              . Choose Project → Import JSON and select your exported file.
              Review the input changes and choose Apply changes. Once Solver
              connected appears, choose Run simulation.
            </p>
            <p className="local-handoff-note">
              Keep the API on 127.0.0.1. No account, paid hosting or design
              upload is needed. Edited inputs need their own accuracy checks.
            </p>
          </li>
        </ol>
        <button className="local-handoff-done" onClick={onClose}>
          Back to design
        </button>
      </div>
    </dialog>
  );
}
