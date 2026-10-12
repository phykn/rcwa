# RCWA Workbench

A web workbench for simulating circular-hole and rectangular 2D optical multilayers and 1D gratings, with direct 3D editing and saved spectra.

## Features

- Direct 3D stack editor for 1–8 circular-hole or rectangular 2D patterns, 1D ridges or uniform films
- Shared X/Y periods, per-layer dimensions/materials, and oblique plane-wave s/p illumination
- Constant or tabulated optical constants, including absorbing substrates
- Order-resolved, total and specular reflectance/transmittance
- Single-rectangular-layer synthetic CD fitting with bounded multistart optimization
- Session undo/redo, reviewable geometry proposals, and comparison of 2–3 saved spectra
- Project and result JSON import/export with exact server-run snapshots
- Local HTTP/OpenAPI and optional stdio MCP tools for general AI clients

Built with React, TypeScript, FastAPI and pinned meent 0.13.2. The default is a synthetic, three-layer, genuinely coupled 2D circular-hole example with an input-bound precomputed spectrum. Its centered cylindrical holes repeat along both X and Y, with explicit hole-fill and host materials. The labeled cutaway only changes the view; dimensions and materials remain the solver inputs. Static Pages never calculates; run the local Python API for new results.

Schema 1.2 supports separate X/Y periods, oblique incidence with azimuth, Hx/Hy up to 5, eight layers and 31 wavelengths. The editor exposes Diameter for circular holes, Width X/Y for rectangular patterns, and shared Pitch X/Y without changing imported 1D projects. Legacy schema 1.0/1.1 files, hashes, history, proposals and single-layer synthetic fitting remain supported. Fitting and change proposals are unavailable for 1.2. The explicit `?example=rectangle` URL opens the retained rectangular 2D fixture and `?example=1d` opens the original 1D fixture; it does not change the ordinary 2D default or migrate any import.

Circle calculations use a disclosed spatial approximation in addition to the Fourier basis. The stored circular example has its own spatial, harmonic and exact-circle S4 checks; those checks do not certify arbitrary edits.

See the [2D editor and result identity](docs/ui/2d-editor.md) and [explicit 1.2 API contract](docs/agent-api.md#explicit-schema-12) for scope, resource limits and oversized-export recovery. The example uses synthetic optical constants, not measured or actual HBM data. Successful edited inputs do not inherit its input-specific offline convergence evidence.

## Quickstart

Requires Git, Python 3.12+ and Node.js 22+. The API stays on your computer.
Keep the following two terminals open.

### Terminal 1: get the code and start the Python solver

macOS / Linux:

```sh
git clone https://github.com/phykn/rcwa.git
cd rcwa
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-lock.txt
.venv/bin/python -m uvicorn api.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Windows PowerShell (Python 3.12 installed):

```powershell
git clone https://github.com/phykn/rcwa.git
cd rcwa
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-lock.txt
.\.venv\Scripts\python.exe -m uvicorn api.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

These commands use the virtual environment's Python directly, so shell activation
or a PowerShell execution-policy change is not needed. If you already cloned the
repository, open that `rcwa` folder instead of cloning it again.

### Terminal 2: start the editor

Open another terminal **in the cloned `rcwa` folder**, then run on any platform:

```sh
cd frontend
npm ci
npm run dev
```

Open http://127.0.0.1:5173 and wait for **Solver connected**. Use the local editor
for calculations; the hosted Pages preview cannot contact or run your solver.
The default SQLite database requires no setup. Keep the API bound to 127.0.0.1;
do not expose this unauthenticated development service through public hosting or
a tunnel. See [development setup](docs/development.md) for PostgreSQL and
static-preview configuration.

### Bring an edited Pages design into the local solver

1. On Pages, edit the design, choose **Use this design locally**, then
   **Export current inputs**. This downloads input-only JSON; it does not include
   the old example spectrum. The Project menu also provides JSON export.
2. Start both local terminals above and open http://127.0.0.1:5173.
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

## Project layout

```text
backend/api/        HTTP API, bounded jobs and project storage
backend/mcp_adapter/  Optional local MCP tools backed by the HTTP API
backend/rcwa_core/  Input schemas, RCWA adapter and CD fitting
backend/tests/      Physics, API and persistence tests
frontend/src/      Editor, visualization and API client
docs/              Physical conventions and validation evidence
```

## Documentation

- [Development and checks](docs/development.md)
- [Local HTTP API and bounded example](docs/agent-api.md)
- [Connect an AI tool client with MCP](docs/mcp-tools.md)
- [Physical model and conventions](docs/physics.md)
- [Validation results](docs/validation.md)
- [Independent S4 comparison](docs/independent-reference.md)
