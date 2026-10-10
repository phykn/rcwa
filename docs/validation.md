# Verification status

This file reports observed checks for the first local prototype. Passing these cases does not certify arbitrary geometries, experimental OCD accuracy, or production readiness.

## Local checks (2026-10-10 UTC)

- Python 3.12, NumPy 2.5.3, SciPy 1.17.1, meent 0.13.2; frozen dependencies in `backend/requirements-lock.txt`.
- Backend: `OPENBLAS_NUM_THREADS=1 .venv/bin/pytest -q` → **55 passed, 1 skipped** after adding the independently recomputed static-preview fixture check.
- Backend lint: `.venv/bin/ruff check backend` → passed.
- PostgreSQL round-trip is **not run locally** because neither PostgreSQL nor Docker is installed here. GitHub CI defines a PostgreSQL 17 service and sets `TEST_POSTGRES_URL`; that remote workflow has not run until this code is pushed with permission.
- The test environment reports an upstream Starlette/AnyIO deprecation warning about `BlockingPortal`; it does not fail the checks.

## What the backend tests establish

- Analytic Fresnel/Airy comparisons for uniform lossless and absorbing films, including absorbing substrates, normal and oblique s/p incidence.
- Brewster-angle and total-internal-reflection limits.
- Lossless patterned flux conservation, passive absorption, nonzero diffraction orders, exact rectangular boundaries, and several harmonic truncations.
- Repeated-call state consistency, material interpolation, explicit rejected unsupported inputs and nonfinite JSON.
- Synthetic CD recovery with multiple starts and an explicit same-model-target warning.
- HTTP-to-real-process calculation and fitting, cancellation, bounded worker capacity, hard timeout, project save/reload and restart persistence under SQLite.

Detailed numerical metrics and assumptions: `validation-physics.md` and `physics.md`. Optional independent S4 build/comparison: `independent-reference.md`. Those comparisons are separate from self-consistency/energy checks and are not a gold-standard certification.

## Remaining verification

- Frontend ESLint, TypeScript type check, **9 Vitest tests**, regular production build, and `VITE_STATIC_PREVIEW=true` build all passed after the synthetic CD panel was added.
- The static fixture is re-solved in backend tests; all plotted power arrays agree within 1e-10.
- **Actual browser/visual QA is not completed locally.** System Chromium aborts before page creation with `socket() Operation not permitted`, including an accepted test-environment escalation. No screenshot or passing DOM-flow result is claimed. The supported cloud browser also could not reach the isolated local server (connection refused). Public Pages visual verification remains a separate pending step.
- `frontend/scripts/browser-qa.mjs` contains the reproducible real-backend/browser workflow, including synthetic recovery and 390px static mode. See `browser-qa.md` for setup. The script has not completed successfully in this runtime.
- GitHub-hosted CI, GitHub Pages publication, mobile public URL, production hosting, authentication, multiuser isolation, and experimental specimens are not verified by local tests.
- No public deployment or production performance benchmark was performed.
