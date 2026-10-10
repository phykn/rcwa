# RCWA Workbench

A web workbench for simulating one-dimensional optical gratings and exploring synthetic critical-dimension (CD) recovery.

## Features

- Rectangular grating editor with plane-wave s/p illumination
- Constant or tabulated optical constants, including absorbing substrates
- Order-resolved, total and specular reflectance/transmittance
- Synthetic CD fitting with bounded multistart optimization
- Project and result JSON import/export

Built with React, TypeScript, FastAPI and meent. The current solver supports one isotropic 1D grating layer. The static preview shows a precomputed example; new simulations and fitting require the local Python API.

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
backend/rcwa_core/  Input schemas, RCWA adapter and CD fitting
backend/tests/      Physics, API and persistence tests
frontend/src/      Editor, visualization and API client
docs/              Physical conventions and validation evidence
```

## Documentation

- [Development and checks](docs/development.md)
- [Local agent HTTP API and bounded example](docs/agent-api.md)
- [Physical model and conventions](docs/physics.md)
- [Validation results](docs/validation.md)
- [Independent S4 comparison](docs/independent-reference.md)
