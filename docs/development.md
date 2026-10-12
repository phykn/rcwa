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

## Bring a Pages design into the local solver

1. On Pages, edit the design, choose **Use this design locally**, then
   **Export current inputs**. This downloads input-only JSON; it does not include
   the old example spectrum. The Project menu also provides JSON export.
2. Start the local launcher above and open http://127.0.0.1:5173.
3. Choose **Project → Import JSON** and select the downloaded file. Review the
   current/proposed dimensions, materials and illumination, then choose
   **Apply changes** and **Run simulation**. **Cancel** keeps the current design.
4. Wait for the calculation to complete. A new result applies only to its exact
   inputs; edited designs need their own convergence/accuracy checks. Use
   **Project → Export** to keep inputs and the complete result together, or
   **Save to local server** for a server-owned snapshot.

Valid input edits also recover after reload in the same browser tab and origin.
This bounded session draft contains inputs only, never results or undo history.
Closing the tab normally clears it; browser session restore may retain it. It is
not a backup or a transfer between Pages and localhost. Export JSON to keep or
move a design. If storage is blocked, full or the draft is invalid/too large, the
editor reports the limitation and keeps export available for valid inputs.

## Checks

```sh
. .venv/bin/activate
ruff check backend scripts/start_local.py scripts/local_runtime.py scripts/local_windows.py scripts/tests/*.py scripts/tests/fixtures/*.py
pytest -q
pytest scripts/tests/test_local_startup.py -q
cd frontend
npm run lint
npm test
npm run build
VITE_STATIC_PREVIEW=true npm test
VITE_STATIC_PREVIEW=true npm run build
cd ..
node --test scripts/tests/pages_evidence_gate.test.mjs
```

The launcher acceptance suite runs real processes serially on Linux and Windows
in CI, from a copied repository path containing spaces and a different working
directory. Its raw server logs, JUnit results and real-eigensystem markers are
retained with each run. It covers cancellation after real numerical work, saved
circle snapshot identity across restart, occupied ports, startup interruption,
service failure and stubborn owned descendants. Deterministic fixture escalation
is a lifecycle test, not a numerical-accuracy claim. A Linux-only local run does
not establish Windows behavior; inspect the exact candidate's Windows CI result.

The PostgreSQL integration test runs when `TEST_POSTGRES_URL` is configured. GitHub CI provides a separate PostgreSQL service. Without a local test service, only that test is explicitly skipped. See [verification status](validation.md) for observed results and remaining limits.

## Project layout

```text
backend/api/          HTTP API, bounded jobs and project storage
backend/mcp_adapter/  Optional local MCP tools backed by the HTTP API
backend/rcwa_core/    Input schemas, RCWA adapter and CD fitting
backend/tests/        Physics, API and persistence tests
frontend/src/        Editor, visualization and API client
docs/                Physical conventions and validation evidence
```

See [implementation boundaries](architecture.md) for component responsibilities.

## GitHub and mobile viewing

GitHub Actions runs code and physics checks. GitHub Pages serves the static React interface. **Pages does not run the Python/meent solver.** The static preview displays a genuinely precomputed reference, makes no API requests, and disables live computation. Editing its inputs marks the displayed result as stale; it does not generate a new spectrum. The primary action becomes **Use this design locally**, with input-only export and exact setup/import steps. Pages sends no design to a server.

For the normal local application, `VITE_API_BASE_URL` sets the API address at build time. An HTTPS page may be blocked by browser security rules when connecting to an HTTP local API.

The API is an unauthenticated local-development prototype. Do not expose it on the public internet or through a temporary tunnel. Multiuser authentication, production quotas, TLS configuration, and deployment operations are not implemented.

### Pages reference preview

The ordinary URL opens the synthetic circular-hole 2D multilayer and its complete
stored spectrum. `?example=rectangle` retains the earlier rectangular 2D example. The explicit `?example=1d` URL retains the original fixture for
legacy exploration and regression checks. Neither route computes on Pages.
See [the 2D editor](ui/2d-editor.md) for controls and exact input/result binding.

The workflow publishes the static preview after verified exact-commit `Checks` evidence, either from a reviewed test branch already promoted unchanged to `main`, or from successful main-branch Checks. The full main Checks run remains enabled; see the [release evidence policy](release-evidence.md). Set repository Settings → Pages → Source to GitHub Actions. The `VITE_STATIC_PREVIEW=true` build displays only the stored example computed by the real Python solver. The local calculation API remains private. See [GitHub's official Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

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

## Direct structure editing

Choose a visible layer chip or tap a layer in the 3D view, then tap Diameter (a
circular hole), Width (a rectangular pattern),
Thickness or Shared pitch for exact entry. Layer settings opens the selected
layer’s name, type, dimensions and materials. The material tabs also expose
groove, ambient and substrate properties; constant and tabulated n/k inputs
remain available. Optional drag handles live under View guide. Calculation
settings are under the closed Advanced settings section. The canonical Project
still feeds the viewport, forms, JSON files and solver.

The following display conventions describe the retained 1D editor. The current
2D/circular editor is documented in [the 2D guide](ui/2d-editor.md).

Colors identify layer positions and do not simulate optical appearance. Ridge
regions use the layer color, non-air gaps use neutral gray and the substrate is
a separate base. The viewport shows three repeats of an infinite one-dimensional stack. Width,
layer thicknesses and pitch share one scale; the substrate depth and invariant
groove length are schematic. Layer order runs from ambient to substrate. A zero
width or thickness removes ridge volume, and full-width ridges form a continuous
film. No cast or contact shadows are rendered. This view does not add finite-target
effects, continuous sloped walls or two-dimensional periodicity.

Drag the scene to orbit, pinch or scroll to zoom, and use Reset view to return.
With the scene focused, arrow keys orbit, +/− zoom and 0 resets the view. With a
dimension handle focused, arrow keys edit by 1 nm, or 10 nm with Shift. Vertical
touch swipes scroll the page. If WebGL creation fails or its context is lost,
exact dimensions and all material/settings editors remain usable.

The browser CI covers live forward/fitting calculations, snapshot provenance,
360/390-pixel layouts, scene gestures, stale results, context loss and delayed
responses. Rendered screenshots and JSON check reports are retained in the
`browser-qa` artifact.

## Interface styling and fonts

The interface uses PipelinePro color, typography, spacing and control tokens in
`frontend/src/styles.css`. The three font families are self-hosted: Outfit for
headings, Inter for interface text, and Source Code Pro for numeric/code readouts.
Font files, upstream package versions, checksums and OFL licenses live in
`frontend/public/fonts`. No font service or external font request is required.
The orange/cyan spectrum strokes use darker related colors for contrast on white;
status badges retain their text labels in addition to color.


## Review edits and compare candidates

Valid schema-1.2 input-only JSON opens **Review imported design** before changing
the workspace. The existing Current/Proposed review includes every changed input
and exact optical tables under Full inputs. Apply changes is one undoable edit;
the displayed spectrum, original result inputs and origin stay together, with the
usual stale label when inputs differ. Cancel leaves them untouched. Identical
inputs report that nothing changed and create no history step. Invalid or
oversized files never install. Newer imports, input edits, layer selection,
history/reset transitions and dismissal invalidate an older review or pending
file read; Escape or opening an inspector also dismisses a queued read. Review
and Apply do not calculate or save to the server. This is an input comparison,
not a base-bound proposal or physical-accuracy check. Result-bearing imports and
legacy imports retain their existing routes; schema-1.2 proposal endpoints
remain unsupported.

Undo and Redo live in the Project menu. Keyboard shortcuts are Ctrl/Cmd+Z and
Ctrl/Cmd+Shift+Z outside text fields; Ctrl+Y also redoes. Native text-field undo
is preserved. A pointer drag or focused numeric edit is one history step. This
history keeps at most 30 committed edits while the page is open; reload
clears it. A separate tab-local recovery draft keeps only the latest valid inputs
(up to 512 KiB) in sessionStorage after a 300 ms debounce, and flushes pending
valid edits when the page is hidden or left. It restores no result, provenance,
job, selection or undo history, and never starts a calculation. The circle,
explicit rectangle and explicit 1D routes have independent draft slots. The
existing 1.0/1.1 and strict 1.2 input validators govern recovery. Closing the tab
normally clears its drafts; browser session restore may retain them. This is
not durable storage or a bridge between Pages and localhost. Corrupt or
unsupported drafts are ignored with a notice; quota failures and oversized drafts invalidate the older saved draft when
storage permits, preventing outdated recovery. Invalid edits preserve the last
valid draft. Failed writes and invalid edits show export recovery guidance. Export JSON for a durable copy. Undo restores the input and displayed result/origin together, and
never starts a calculation or saves a project.

A live forward run is validated before submission. Its normalized input/hash,
job ID, result wavelengths and polarization channels must match before display.
Saving the current computed run uses the existing server-owned snapshot route.
An expired job cannot be silently resaved as a trusted result: export a local
JSON copy or run it again. Draft inputs and imported results retain the existing
unverified save path. An unchanged server snapshot is already durable.

Project → Open lists at most the latest 100 saved copies. When this window is
full, the dialog says that older copies may exist. **Open by snapshot ID** opens
any known ID through the same validated load path, including records outside the
list. A save confirmation shows a selectable snapshot ID; each listed copy also
has a closed **Snapshot ID** disclosure for copying it later. Keep the ID before a
copy leaves the recent list. It refers to that local server's database, not a job
or a portable backup. Export JSON for a durable copy outside that database.
Missing or invalid IDs leave the current workspace unchanged. Closing a pending
load prevents its late response from changing the workspace. Opening by ID does
not calculate, save, overwrite or promote imported result provenance.

To compare, open Project → Open, select two or three saved projects, then choose
Compare. Each selected record needs a stored spectrum. The chart uses the exact
stored wavelengths and selected polarization; different grids or missing channels
are explicitly blocked, with no interpolation. Check each candidate's run details
for optical materials, incidence angle, Fourier order and warnings. The comparison
is descriptive and does not identify an optimum or establish convergence. Review
candidate opens an explicit Apply/Cancel preview. Applying restores that saved
input/result pair in one undoable step, without rerunning physics.

An external AI tool can call the read-only geometry-preview HTTP/MCP operation
and save its returned `rcwa-change-proposal/1.0` JSON. Import that file with the
existing Import JSON action to inspect current/proposed geometry and all changed
inputs before applying. Only width, height and pitch are supported in this
proposal format. Imported diffs and diagnostics are checked/recomputed locally;
files cannot establish server provenance. A proposal for different inputs or an
older editor revision cannot be applied. Applying it leaves the previous spectrum
paired with its original inputs and visibly stale. It does not call a language
model or start a simulation. See the HTTP/MCP guides for the exact file handoff.

The static preview supports session history and local proposal-file review/apply
without any API requests. Server-saved comparison still requires the local API.
No separate offline candidate library or newly generated static spectra are
provided. The workflow browser script covers the live and static paths and stores
screenshots/assertions alongside the existing browser CI artifacts.

## Multilayer stacks and compatibility

Select a layer using the always-visible horizontal layer chips; their colors
match the layer numbers in the schematic 3D view, independently of optical
material and selection. A checkmark, border, outline and selected-layer caption
identify selection without relying on color. The selected chip is automatically
revealed when the strip scrolls. Add layer offers named patterned and uniform
choices. Layer settings opens its inspector; the closed Layer actions section
contains move, duplicate and remove controls.
The list is bounded to one through eight finite layers. Ambient and substrate
stay outside that list and are reached through the material inspector tabs.
Uniform films have no CD or groove material. Every patterned CD must remain
within the one shared period. Each structural operation and dimension-edit
session is one undoable change; selecting a layer is not an input edit.

Legacy Project 1.0 inputs retain their original normalized fields and hash.
An explicit stack/type operation promotes the editable project to 1.1; stored
input/result JSON and provenance are never rewritten. Current runs return result
1.1 with adapter 1.1.0, physical layer count, active slab count and total thickness.
Known historical result 1.0 snapshots remain readable over HTTP, MCP and the UI.
Synthetic CD recovery is still restricted to exactly one rectangular layer.

The stack-preview HTTP/MCP operation returns `rcwa-change-proposal/1.1`. Its
bounded patch contains the period and/or a complete finite-layer list. Tables
remain exact in the full inputs while review diffs summarize them atomically.
Requests remain limited to 2 MB and stack proposal responses/imports to 8 MB.
Legacy proposal 1.0 imports retain their 2 MB cap; ordinary project imports retain
the existing 20 MiB local-file cap. Applying a proposal does not compute a new
spectrum or confer trusted provenance.

The multilayer browser script adds real-stack snapshots, lower-layer selection,
structural history, proposal compatibility, dense-table payload round trips and
desktop/360/390 px screenshots. CI additionally builds the pinned official S4
reference and compares actual application total and per-order powers. Numerical
agreement, flux balance and harmonic refinement are distinct checks; none alone
certifies metrology accuracy. An exact tangent retained mode inside a homogeneous
film can still be singular in the pinned engine and is reported as a numerical
failure, without hidden damping or perturbation.

Changes are first published on a test branch. Full CI, independent numerical
reference checks and inspection of the exact candidate's rendered screenshots
must pass before that commit reaches main. The Pages workflow validates exact-SHA
Checks evidence and current main before build and deploy; the complete main Checks
run remains enabled. Pages remains a static, precomputed-only preview. See the
[release evidence policy](release-evidence.md) for trust boundaries and fallback behavior.

### First-use verification

The first-use browser script checks the static path at 360×800, 390×844 and
1440×1000: select the initial layer, change its width, add/select another layer,
change thickness without changing the other layer, and identify the original
example spectrum. It checks page overflow, visible mobile result actions,
closed advanced controls and absence of API calls. Both viewport-only and
full-page screenshots are retained for independent visual review. The broader
browser suites continue to exercise real calculation, history, precise material
round trips, optional drag handles, mobile gestures and failed WebGL contexts.
