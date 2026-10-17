# Verification and release gates

This is a bounded numerical workbench. Passing its tests does not certify arbitrary inputs, Fourier convergence, experimental CD accuracy or production readiness.

## Preserved baseline

The preceding single-layer workflow release, commit `ec9fa014c7e7027d387a2fd478c0b7190b267783`, passed all four CI jobs and 51 browser check groups. Its twelve workflow screenshots were inspected. The multilayer stage preserves the existing checks instead of replacing them with a smaller stack-only suite.

## Multilayer numerical evidence

The application adapter is independently checked against a planar 2×2 characteristic-matrix implementation and a rebuilt, pinned official S4 reference. The committed [numerical summary](multilayer-validation-summary.json) records tolerances, measured errors, sample-specific harmonic refinement, a bounded resource observation and source hashes. The [full compressed S4 evidence](multilayer-reference-results.json.gz) includes actual inputs and per-order comparisons.

- Planar reference: 540 polarization/wavelength/angle/port samples, absolute R/T tolerance 2e-10.
- S4: 40 scenarios and 276 polarization/wavelength samples, including every retained diffraction order, absolute tolerance 1e-9.
- Legacy regression: 19 pre-upgrade cases retain identical normalized Project 1.0 inputs, canonical hashes and powers.
- Genuine pre-upgrade server-owned snapshot fixtures test old result/provenance reading without rewriting database rows.
- Loss/dispersion in lower layers, zero-thickness removal, all-zero stacks, full/empty CD, split-layer invariance, layer reversal, passive flux and malformed output binding are checked separately.

These references agree for the tested finite bases. That agreement is distinct from convergence to the continuous problem. Ordinary forward results deliberately retain `convergence_checked=false`. Materials in examples and tests are synthetic.

A stack with no patterned layer couples only the specular order, so it is solved
with that order alone; this is exact and avoids the singular modal inverse that an
order exactly tangent inside a film would otherwise cause. In patterned stacks an
exactly tangent retained order inside a homogeneous film is reported by preflight
as a cutoff. No hidden loss, angular perturbation or clipping is added.

## Reproducible checks

```sh
OPENBLAS_NUM_THREADS=1 .venv/bin/ruff check backend
OPENBLAS_NUM_THREADS=1 .venv/bin/pytest backend/tests -q
cd frontend
npm run typecheck && npm run lint && npm test
npm run test:engine
RCWA_E2E_PYTHON=../.venv/bin/python npm run e2e
```

Local PostgreSQL integration tests are explicitly skipped without `TEST_POSTGRES_URL`; `docker compose up -d db` provides a PostgreSQL 17 service for it. Current pinned Python dependencies use meent 0.13.2, NumPy 2.5.3 and SciPy 1.17.1. An upstream Starlette/AnyIO deprecation warning is not a test failure.

The new circular example has separate [spatial/harmonic and off-grid evidence](true-2d/circular-geometry.md). Historical rectangular evidence retains its original source binding; it is not transferred to circles. Circular evidence is bound to an archived copy of the core that generated it (`backend/tests/fixtures/true-2d/circular-core`), and current production must reproduce the frozen circular result within 1e-10. The circular S4 comparison (`scripts/circular_gate.py`) reruns the complete default circle grid against independently constructed exact S4 circles.

The independent reference comparison builds official S4 at the exact source commit described in [the reference guide](independent-reference.md), runs the application's normal forward adapter and retains the comparison JSON/build log. S4 is a test-only reference; it is not bundled in the application runtime.

## Browser engine and end-to-end checks

- `npm run test:engine` loads the browser engine's exact Python stack in Node
  Pyodide 0.28.3 (NumPy 2.2.5, SciPy 1.14.1) and requires the frozen circular-hole
  H5 result to be reproduced within 1e-10 for every total and order power. It also
  checks that sharded partial solves assemble into exactly the whole-spectrum
  result, that every template passes preflight, and that field maps and fits run.
- Field maps are checked against the analytic thin-film field (rtol 1e-6) and
  refuse cases where meent's native powers disagree with production.
- 2D fitting recovers synthetic one- and two-parameter targets.
- `npm run e2e` builds the static site and drives it in Chromium: first load with
  the stored example, in-browser recalculation after edits, a slider drag as one
  undo step with live preview, a sweep heat map and point pick, field map and
  convergence check, fitting, share-link round trip, examples, the command
  palette, a 390 px phone layout without sideways scrolling, and the first-visit
  guide. With `RCWA_E2E_PYTHON` it also starts the local API and checks that full
  calculations switch to it.

Screenshots of failing tests and traces are written to `frontend/test-results`.

## Publication policy and remaining limits

There is no CI. Run the checks above locally (and the S4 reference scripts when the numerical core changes) before merging to `main`; every push to `main` deploys Pages without further checks.

Pages calculates in the visitor's browser with the same `rcwa_core`; it runs no server. Production authentication, multiuser isolation, instrument response, measured-sample validation, uncertainty estimates, phase and general inverse design remain outside this stage.
