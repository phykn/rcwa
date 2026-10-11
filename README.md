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

Requires Python 3.12+ and Node.js 22+.

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements-lock.txt
PYTHONPATH=backend uvicorn api.main:app --host 127.0.0.1 --port 8000
```

In another terminal:

```sh
cd frontend
npm ci
npm run dev
```

Open http://localhost:5173. SQLite is used by default; see [development setup](docs/development.md) for PostgreSQL and static-preview configuration.

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
