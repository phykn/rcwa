# Development setup

Requires Git, Python 3.12+ and Node.js 22.13+ (22.x) or 24+.

## Install dependencies

macOS / Linux:

```sh
git clone https://github.com/phykn/rcwa.git
cd rcwa
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-lock.txt
cd frontend && npm ci && cd ..
```

Windows PowerShell (Python 3.12 installed):

```powershell
git clone https://github.com/phykn/rcwa.git
cd rcwa
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-lock.txt
cd frontend
npm ci
cd ..
```

These commands use the virtual environment's Python directly, so shell activation
or a PowerShell execution-policy change is not needed. If you already cloned the
repository, open that `rcwa` folder instead of cloning it again. Repeat the two
explicit dependency-install commands after updating the dependency lock files.

## Start the editor and solver

Run one foreground command from the cloned repository root.

macOS / Linux:

```sh
.venv/bin/python scripts/start_local.py
```

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe scripts\start_local.py
```

The launcher checks Python package versions and direct frontend dependencies
against both lock files. It accepts Node 22.13+ on the 22.x line or Node 24+; the
locked ESLint requires a newer Node 22 minor than the locked Vite.

Keep this terminal open. After **RCWA ready**, open http://127.0.0.1:5173 and wait
for **Solver connected**. API documentation is at http://127.0.0.1:8000/docs.
Press **Ctrl+C** to stop both services and their active calculations. Saved
local-server snapshots survive restart; unfinished or unsaved jobs do not.
No dependency downloads, browser auto-open, background service, credentials,
tunnel, reload process or extra API worker is started. The optional external-API
MCP adapter and its lifetime behavior are unchanged.

The default SQLite database is `rcwa-demo.db` in the cloned repository root, even
when you invoke the script from another directory using its full path. An explicit
`DATABASE_URL` is preserved and must work; relative SQLite paths also resolve from
the repository root. Occupied ports fail with an explanation and are never reused
or cleared automatically. Clear `VITE_STATIC_PREVIEW` and `VITE_API_BASE_URL` in
your shell and frontend `.env` files before using this local launcher.

Use the local editor for calculations; the hosted Pages preview cannot contact
or run your solver. Keep the API bound to 127.0.0.1; do not expose this
unauthenticated development service through public hosting or a tunnel.

### Local launcher troubleshooting and shutdown

- Missing or mismatched Python packages: run the printed install command using
  the same virtual-environment Python. Missing frontend packages: run `npm ci`
  explicitly in `frontend`. The launcher never repairs installations itself.
- Port 8000 or 5173 occupied: stop the service you started there, then retry.
  The launcher neither adopts an existing API nor kills another process.
- Invalid or unavailable `DATABASE_URL`: fix it, or unset it to select the demo
  SQLite database. An explicit empty value is an error. The launcher never falls
  back from a configured database. `.env.example` is not loaded automatically.
- Static preview or external API settings: clear `VITE_STATIC_PREVIEW=true` and
  any nonempty `VITE_API_BASE_URL` in the shell and frontend `.env` files. The
  local launcher is always the owned editor plus its own local API.
- Repository paths may contain spaces. Invoke the virtual-environment Python
  and launcher by quoted absolute paths from another directory; both services
  still use the repository root for relative database paths.

Ctrl+C (also Ctrl+Break on Windows) requests normal Vite and API shutdown. On
Linux/macOS SIGTERM does the same. The API's existing lifespan closes numerical
workers and storage. Repeated interrupts are idempotent. Startup has a 30-second
bound after dependency checks. Shutdown allows 12 seconds for normal cleanup,
then forcibly stops the launcher's owned process tree; a forced shutdown exits
with an error and may leave temporary scratch files. Never rely on volatile jobs
as saved data. Save completed snapshots before stopping.

Linux uses a new process group. Windows assigns a non-inheritable, unnamed
kill-on-close Job Object before the runtime can import the API or start children.
If Windows cannot establish that boundary, startup fails without an uncontained
fallback. Force-killing the outer launcher itself (for example SIGKILL or Task
Manager) is outside the normal cross-platform cleanup guarantee. This is a local
development launcher, not a persistent service manager.

### Advanced: start two terminals separately

For separate server logs or debugging, retain the original workflow after the
same dependency installation. Run both commands from the cloned repository root.

Terminal 1, using the zero-setup SQLite demo:

```sh
.venv/bin/python -m uvicorn api.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

On Windows replace `.venv/bin/python` with `.\.venv\Scripts\python.exe`.

Terminal 2:

```sh
cd frontend
npm run dev -- --strictPort
```

Stop each terminal separately. These independent services are not owned by the
one-command launcher. Keep one API worker and loopback binding.

### Use PostgreSQL

```sh
docker compose up -d db
export DATABASE_URL='postgresql+psycopg://rcwa:local-development-only@localhost:5432/rcwa'
.venv/bin/python -m uvicorn api.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

`.env.example` is a reference file; it is not loaded automatically. Set the environment variable in your shell as shown. If a configured PostgreSQL server is unavailable, API startup fails. It does not silently fall back to SQLite. The SQLite demo is selected only when `DATABASE_URL` is absent.

## Use designs on Pages and locally

The hosted page and the local app are the same build. Both calculate in the
browser; the local app also uses the native solver when the API is running.
To move a design between them, use **Share link** (the whole design lives in
the URL fragment and is never sent to a server) or **Export → Design file** and
**Open** it on the other side. Schema 1.0/1.1 projects open too and are
converted to 1.2 with a note.

Edits are kept as a draft for the browser tab. **Saved** stores designs and
their spectra in this browser (IndexedDB); export a file to keep one elsewhere.

## Checks

```sh
. .venv/bin/activate
ruff check backend scripts/start_local.py scripts/local_runtime.py scripts/local_windows.py scripts/tests/*.py scripts/tests/fixtures/*.py
pytest -q
pytest scripts/tests/test_local_startup.py -q
cd frontend
npm run typecheck
npm run lint
npm test                 # unit and component tests (Vitest, jsdom)
npm run test:engine      # Pyodide engine vs frozen native results (downloads Pyodide once)
npx playwright install chromium
RCWA_E2E_PYTHON=../.venv/bin/python npm run e2e   # build + browser end-to-end
cd ..
node --test scripts/tests/pages_evidence_gate.test.mjs
```

`npm run test:engine` caches Pyodide's packages in `node_modules/pyodide`; the
end-to-end suite serves them from there, so run it first on a fresh checkout.
Without `RCWA_E2E_PYTHON` the local-server end-to-end check is skipped.

The launcher acceptance suite runs real processes serially on Linux and Windows
in CI, from a copied repository path containing spaces and a different working
directory. Its raw server logs, JUnit results and real-eigensystem markers are
retained with each run. It covers cancellation after real numerical work, saved
circle snapshot identity across restart, occupied ports, startup interruption,
service failure and stubborn owned descendants. A Linux-only local run does
not establish Windows behavior; inspect the exact candidate's Windows CI result.

The PostgreSQL integration test runs when `TEST_POSTGRES_URL` is configured. GitHub CI provides a separate PostgreSQL service. Without a local test service, only that test is explicitly skipped. See [verification status](validation.md) for observed results and remaining limits.

## Project layout

```text
backend/api/           HTTP API, bounded jobs and project storage
backend/mcp_adapter/   Optional local MCP tools backed by the HTTP API
backend/rcwa_core/     Schemas, RCWA adapter, field maps and fitting (also runs in the browser)
backend/tests/         Physics, API and persistence tests
frontend/src/core/     Design model, files, share links, materials, colour, parameters
frontend/src/engine/   Pyodide worker pool, browser and server engines
frontend/src/state/    Store, undo history and the calculation controller
frontend/src/features/ Stack, inspector, 3D view and result views
frontend/e2e/          Playwright end-to-end tests
docs/                  Physical conventions and validation evidence
```

See [implementation boundaries](architecture.md) for component responsibilities
and [the workbench guide](ui/workbench.md) for the interface.

## GitHub Pages

GitHub Actions runs code and physics checks. GitHub Pages serves the static
build, which calculates with the in-browser engine. The first visit downloads
the Python runtime and numerical packages (about 25 MB, from jsDelivr, pinned to
Pyodide 0.28.3) and caches them; the bundled example result shows immediately
while the engine starts. Designs never leave the browser.

Set `VITE_API_BASE_URL` at build time to point a build at a local API on another
origin. An HTTPS page may be blocked by browser rules when calling an HTTP local
API, so local acceleration is normally used from the local app at
http://127.0.0.1:5173.

The API is an unauthenticated local-development prototype. Do not expose it on the public internet or through a temporary tunnel. Multiuser authentication, production quotas, TLS configuration, and deployment operations are not implemented.

The workflow publishes after verified exact-commit `Checks` evidence; see the
[release evidence policy](release-evidence.md). Set repository Settings → Pages →
Source to GitHub Actions.

## Job and storage lifetime

Run the API with **one worker**. Volatile job history is limited to 100 records and
64 MB of estimated completed-input/result object memory; oldest completed records
are evicted, and restarting removes all jobs. Active and cleanup-owned records
remain protected. Saved database snapshots survive eviction and restart. There
can be a temporary overage while terminal records still own cleanup resources;
the byte bound applies to evictable completed history after cleanup. Unreaped
children retain their slots, and pending cleanup blocks new admission. There
are at most two simultaneous calculations, including at most one schema 1.2 2D
calculation; unavailable slots return HTTP 429 without a queue. Each job has a
120-second acceptance deadline that terminates its owned numerical process.
Save useful completed results promptly. Snapshot save is append-only and
idempotent by server job ID, never overwriting an existing project.

Lengths are in nm. Public passive-material input uses n > 0 and k ≥ 0. Internal complex signs, diffraction-order conventions, and power normalization are documented in result metadata and [the physics contract](physics.md). Example optical constants are synthetic values, not a calibrated material database.

## Programmatic local access

The [agent API guide](agent-api.md) describes discovery, no-job admissibility
checks, typed jobs, and server-owned snapshots. This is an HTTP/OpenAPI interface
and a runnable candidate-evaluation example. An [optional stdio MCP adapter](mcp-tools.md)
lets general tool-capable AI clients use that same API. No integrated model, keys,
or paid services are required. Install `backend/requirements-mcp-lock.txt` to run
the adapter and its protocol tests; the base install remains sufficient for the UI
and HTTP example.

Mutation requests reject browser Origins outside `CORS_ORIGINS`; Host must be
`localhost`, `127.0.0.1`, or `::1`. Origin-less local HTTP scripts are supported.
These checks are defense in depth, not authentication. Keep loopback binding and
one Uvicorn worker. Do not expose this service or loosen the host boundary for a
remote agent.

Existing `projects` rows and columns are preserved. An additive `run_provenance`
table stores trusted local origin for new server-owned snapshots. There is no
claim that SQLAlchemy `create_all()` migrates existing columns. Old rows and
client-import saves remain unverified. Snapshot input/result JSON is append-only;
saving the same completed forward job again returns its existing snapshot ID.
