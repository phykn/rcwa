# RCWA Workbench

[Open the workbench: phykn.github.io/rcwa](https://phykn.github.io/rcwa/)

Design periodic optical nanostructures — films, gratings, pillars, holes — and see their reflection, transmission and absorption calculated with rigorous coupled-wave analysis (RCWA), right in your browser.

The solver runs on your machine inside the page (Python and [meent](https://github.com/kc-ml2/meent) compiled to WebAssembly). Nothing is uploaded. If the local API is running, full calculations switch to it automatically for native speed.

## What you can do

- Build a stack of up to eight layers: uniform films, line gratings, rectangular blocks and circular holes, on a square or rectangular lattice
- Pick materials from a sourced library (Si, SiO₂, Si₃N₄, TiO₂, Au, Ag, Al and more), type constants, or import an n, k table
- Drag any dimension and watch a live preview follow, then a full-accuracy result when you let go
- Read R, T and A for s, p or unpolarized light, the reflected and transmitted colour, and every diffraction order
- Sweep a dimension or the incidence angle against wavelength as a heat map, with Wood–Rayleigh anomaly lines
- Map |E|² inside the structure, check Fourier-order convergence, and fit dimensions to a measured spectrum
- Start from examples (anti-reflection coating, Bragg mirror, wire-grid polarizer, photonic-crystal slab, gold nanodisks, silicon nanopillars), share a design as a link, save designs in the browser, and export CSV, JSON or an HTML report
- Drive the same solver from scripts or AI tool clients through the local HTTP/OpenAPI interface or the optional MCP adapter

Built with React, TypeScript, three.js, Pyodide, FastAPI and meent.

## Run it locally

Requires Git, Python 3.12+ and Node.js 22.13+ (22.x) or 24+.

Follow the [first-time setup](docs/development.md#install-dependencies), then start the workbench and the native solver from the repository root:

```sh
.venv/bin/python scripts/start_local.py
```

On Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe scripts\start_local.py
```

After **RCWA ready**, open http://127.0.0.1:5173. Keep the terminal open; **Ctrl+C** stops both services. Keep this unauthenticated development API on localhost.

## Documentation

- [Using the workbench](docs/ui/workbench.md)
- [Setup, troubleshooting and development checks](docs/development.md)
- [Local HTTP API](docs/agent-api.md) · [MCP adapter](docs/mcp-tools.md)
- [Physical model](docs/physics.md) · [Validation](docs/validation.md) · [Independent S4 comparison](docs/independent-reference.md)
- [Implementation boundaries](docs/architecture.md)
