# RCWA Workbench

[Interactive example: phykn.github.io/rcwa](https://phykn.github.io/rcwa/)

A web workbench for modeling periodic optical multilayers and exploring their reflectance and transmittance with rigorous coupled-wave analysis (RCWA).

The hosted page is an interactive static preview with precomputed spectra from synthetic examples. New calculations run through the local Python API.

## Features

- Edit circular-hole and rectangular 2D multilayers, 1D gratings and uniform films in a 3D view
- Set per-layer optical constants and s/p illumination; inspect total, specular and order-resolved spectra
- Import/export project JSON, save exact input/result snapshots and compare saved spectra locally
- Connect scripts or AI tool clients through the local HTTP/OpenAPI interface or optional MCP adapter

Built with React, TypeScript, FastAPI and meent.

## Quickstart

Requires Git, Python 3.12+ and Node.js 22.13+ (22.x) or 24+.

Follow the [first-time setup](docs/development.md#install-dependencies), then start the editor and solver from the repository root:

```sh
.venv/bin/python scripts/start_local.py
```

On Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe scripts\start_local.py
```

After **RCWA ready**, open http://127.0.0.1:5173. Keep the terminal open; **Ctrl+C** stops both services. Keep this unauthenticated development API on localhost.

To calculate a design edited on Pages, [export its inputs and import them locally](docs/development.md#bring-a-pages-design-into-the-local-solver).

## Documentation

- [Setup, troubleshooting and development checks](docs/development.md)
- [Editor, examples and result identity](docs/ui/2d-editor.md)
- [Local HTTP API](docs/agent-api.md) · [MCP adapter](docs/mcp-tools.md)
- [Physical model](docs/physics.md) · [Validation](docs/validation.md) · [Independent S4 comparison](docs/independent-reference.md)
