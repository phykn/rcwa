# Development setup

Requires Python 3.12+ and Node.js 22+.

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements-lock.txt
cd frontend && npm ci && cd ..
```

Terminal 1, using the zero-setup SQLite demo:

```sh
. .venv/bin/activate
PYTHONPATH=backend uvicorn api.main:app --host 127.0.0.1 --port 8000
```

Terminal 2:

```sh
cd frontend
npm run dev -- --host 127.0.0.1
```

Open http://localhost:5173. API documentation is at http://localhost:8000/docs.

### Use PostgreSQL

```sh
docker compose up -d db
export DATABASE_URL='postgresql+psycopg://rcwa:local-development-only@localhost:5432/rcwa'
PYTHONPATH=backend uvicorn api.main:app --host 127.0.0.1 --port 8000
```

`.env.example` is a reference file; it is not loaded automatically. Set the environment variable in your shell as shown. If a configured PostgreSQL server is unavailable, API startup fails. It does not silently fall back to SQLite. The SQLite demo is selected only when `DATABASE_URL` is absent.

## Checks

```sh
. .venv/bin/activate
ruff check backend
pytest -q
cd frontend
npm run lint
npm run build
```

The PostgreSQL integration test runs when `TEST_POSTGRES_URL` is configured. GitHub CI provides a separate PostgreSQL service. Without a local test service, only that test is explicitly skipped. See [verification status](validation.md) for observed results and remaining limits.

## GitHub and mobile viewing

GitHub Actions runs code and physics checks. GitHub Pages serves the static React interface. **Pages does not run the Python/meent solver.** The static preview displays a genuinely precomputed reference, makes no API requests, and disables live computation. Editing its inputs marks the displayed result as stale; it does not generate a new spectrum.

For the normal local application, `VITE_API_BASE_URL` sets the API address at build time. An HTTPS page may be blocked by browser security rules when connecting to an HTTP local API.

The API is an unauthenticated local-development prototype. Do not expose it on the public internet or through a temporary tunnel. Multiuser authentication, production quotas, TLS configuration, and deployment operations are not implemented.

### Pages reference preview

The workflow is prepared to publish the static preview after `Checks` succeeds on the main branch. Set repository Settings → Pages → Source to GitHub Actions. The `VITE_STATIC_PREVIEW=true` build displays only the stored example computed by the real Python solver. The local calculation API remains private. See [GitHub's official Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Job and storage lifetime

Run the API with **one worker**. It retains at most 100 job records in memory; restarting the API removes them. It accepts up to two simultaneous calculations and returns HTTP 429 when both slots are occupied. Each job has a 120-second deadline that terminates the numerical process. Save completed results to the database or export JSON to retain them. Saving creates a new snapshot rather than overwriting an existing project.

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

Drag a dimension handle or tap Width, Height or Pitch for exact entry. The
canonical Project feeds the viewport, forms, JSON files and solver. Ridge/film
and substrate surfaces or captions open their material editors; the inspector
tabs also expose groove and ambient properties. Constant and tabulated n/k
inputs remain available.

The viewport shows three repeats of an infinite one-dimensional stack. Width,
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

Undo and Redo live in the Project menu. Keyboard shortcuts are Ctrl/Cmd+Z and
Ctrl/Cmd+Shift+Z outside text fields; Ctrl+Y also redoes. Native text-field undo
is preserved. A pointer drag or focused numeric edit is one history step. This
history keeps at most 30 committed edits in the current browser session; reload
clears it. Undo restores the input and displayed result/origin together, and
never starts a calculation or saves a project.

A live forward run is validated before submission. Its normalized input/hash,
job ID, result wavelengths and polarization channels must match before display.
Saving the current computed run uses the existing server-owned snapshot route.
An expired job cannot be silently resaved as a trusted result: export a local
JSON copy or run it again. Draft inputs and imported results retain the existing
unverified save path. An unchanged server snapshot is already durable.

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

Open the compact Layers row to select a layer or reveal Add layer's patterned
and uniform choices. Selection closes the picker and focuses the structure's
existing dimension/material controls. Edit selected layer opens its inspector;
the closed Layer actions section contains move, duplicate and remove controls.
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
must pass before that commit reaches main. The Pages workflow follows successful
main checks and remains a static, precomputed-only preview.
