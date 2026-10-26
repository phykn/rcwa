# Implementation boundaries

1. Frontend owns editing and display, not physics. Its designs are schema-1.2 `Project`s whose spectrum may be longer than one request; the engine splits it into contract-sized projects.
1a. The same `rcwa_core` source runs in two places: the API's worker processes and Pyodide Web Workers in the browser (`frontend/src/engine/pyodide/bridge.py`). Browser workers solve single wavelengths and one call assembles them with `assemble_forward_2d`, so aggregation exists only in Python.
2. FastAPI validates once before allocating a process. A worker validates again at its boundary.
3. `rcwa_core` imports no API/database code. Engine-specific values stay in the solver adapter.
4. Each numerical job owns a fresh spawned OS process. No unbounded process pool or task queue is accepted. BLAS is limited to one thread per process to avoid accidental oversubscription.
5. A temporary file transfers results only after process completion. Deadline and cancellation terminate the process. Job state is deliberately ephemeral.
6. SQLAlchemy stores versioned input and optional result snapshots as JSON text. This keeps PostgreSQL and the explicit SQLite demo on one small implementation. Binary arrays and a generalized scientific data warehouse are unnecessary at this scale.
7. Input/body limits are prototype guardrails, not a complete public-service security boundary. Run on localhost only, one API worker.
8. Project 1.0 keeps its original normalized one-rectangle representation. Project 1.1 holds one to eight finite layers in physical top-to-bottom order. A layer is either `rectangle_1d` or `homogeneous`; the period belongs to the project. Explicit project 1.2 adds shared X/Y periods, rectangular 2D patterns and circular holes with a single diameter. No generic geometry graph or database migration is introduced.
9. The meent adapter compiles each active slab and connects them from substrate to ambient with the existing corrected complex-port convention. Power observables remain referenced to the external entrance planes. Historical result readers are separate from current-worker validation.
10. Stack proposals replace only a bounded finite-layer list and/or the shared period. They have no apply, solve or persistence side effects. The workbench opens 1.2 dimension proposals only, rebuilds the candidate from the current design and rejects proposals made for another design.
11. Fitting (`fit_2d`) is bounded least squares over the real forward model, served by the HTTP API and MCP adapter. The workbench shows only the live spectrum.

Extension points are ordinary files, not abstraction layers: extend `Layer` validation and solver mapping for additional layer types; add measured-data/observable schemas before real inverse fitting; introduce durable queueing only when a demonstrated workload requires it.
