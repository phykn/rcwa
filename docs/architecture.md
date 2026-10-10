# Implementation boundaries

1. Frontend owns editing and display, not physics. Its input JSON matches `Project`.
2. FastAPI validates once before allocating a process. A worker validates again at its boundary.
3. `rcwa_core` imports no API/database code. Engine-specific values stay in the solver adapter.
4. Each numerical job owns a fresh spawned OS process. No unbounded process pool or task queue is accepted. BLAS is limited to one thread per process to avoid accidental oversubscription.
5. A temporary file transfers results only after process completion. Deadline and cancellation terminate the process. Job state is deliberately ephemeral.
6. SQLAlchemy stores versioned input and optional result snapshots as JSON text. This keeps PostgreSQL and the explicit SQLite demo on one small implementation. Binary arrays and a generalized scientific data warehouse are unnecessary at this scale.
7. Input/body limits are prototype guardrails, not a complete public-service security boundary. Run on localhost only, one API worker.
8. Project 1.0 keeps its original normalized one-rectangle representation. Project 1.1 holds one to eight finite layers in physical top-to-bottom order. A layer is either `rectangle_1d` or `homogeneous`; the period belongs to the project. No generic geometry graph or database migration is introduced.
9. The meent adapter compiles each active slab and connects them from substrate to ambient with the existing corrected complex-port convention. Power observables remain referenced to the external entrance planes. Historical result readers are separate from current-worker validation.
10. Stack proposals replace only a bounded finite-layer list and/or the shared period. They have no apply, solve or persistence side effects. Full inputs remain available for review; material tables use atomic bounded diff summaries. The browser recomputes proposal semantics and rejects stale editor revisions.

Extension points are ordinary files, not abstraction layers: extend `Layer` validation and solver mapping for additional layer types; add measured-data/observable schemas before real inverse fitting; introduce durable queueing only when a demonstrated workload requires it.
