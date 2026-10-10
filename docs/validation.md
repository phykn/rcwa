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

An exact tangent retained mode inside a homogeneous finite layer can make the pinned meent modal inverse singular even when external-port preflight passes. This produces an explicit numerical failure. Nearby samples have independent-reference tests; no hidden loss, angular perturbation or clipping is added.

## Reproducible checks

```sh
OPENBLAS_NUM_THREADS=1 .venv/bin/ruff check backend
OPENBLAS_NUM_THREADS=1 .venv/bin/pytest backend/tests -q
cd frontend
npm test
npm run lint
npm run build
```

Local PostgreSQL integration tests are explicitly skipped without `TEST_POSTGRES_URL`; the backend CI job supplies a PostgreSQL 17 service. Current pinned Python dependencies use meent 0.13.2, NumPy 2.5.3 and SciPy 1.17.1. An upstream Starlette/AnyIO deprecation warning is not a test failure.

The independent-reference CI job builds official S4 at the exact source commit described in [the reference guide](independent-reference.md), runs the application's normal forward adapter and retains the comparison JSON/build log. S4 is a test-only reference; it is not bundled in the application runtime.

## Browser and visual acceptance

The browser CI job runs real local API jobs and the separately built static preview through all seven scripts:

- `first-use-browser-qa.mjs`: discoverable layer selection, exact dimension edits, other-layer isolation, static-result honesty and viewport/full-page screenshots
- `first-use-touch-qa.mjs`: 360/390px mobile touch replay, layer-strip overflow/limits, isolated drag edits and page scrolling (not a real-phone keyboard test)
- `browser-qa.mjs`: existing editor, illumination, real forward/fitting and mobile interaction checks
- `snapshot-browser-qa.mjs`: server-owned snapshots, stale results and imported provenance
- `contract-browser-qa.mjs`: geometry, exact controls, interrupted gestures, fallback behavior and delayed material-import ownership
- `workflow-browser-qa.mjs`: history, comparison-review cancellation, exact accessible samples, proposal semantics and asynchronous ownership
- `multilayer-browser-qa.mjs`: ordered stack rendering/editing, lower-layer selection, structural history, new proposals, dense-table byte limits and legacy compatibility

Accessibility checks verify native sample indices, exact wavelength text, named live-region associations and independently reconstructed browser accessible descriptions. Chromium CDP serializes native range `valuetext` from the numeric control value; these checks do not treat it as the ARIA text override or claim spoken screen-reader testing.

Successful physics responses are not mocked. Required screenshots must be captured and inspected; passing DOM assertions alone does not establish visual acceptance. The multilayer script uses fresh browser processes for its desktop/360/390 px evidence before stress cases.

The isolated development container cannot launch Chromium because its socket operation is restricted. Browser execution and screenshots therefore run on the GitHub-hosted test-branch runner. This limitation does not count as a local browser pass. CI reports and screenshots are retained as workflow artifacts.

## Publication policy and remaining limits

Publish changes to a test branch first. All five CI jobs, independent reference checks, exact input/result/provenance regressions and inspection of the candidate commit's actual screenshots must pass before that exact commit reaches main. A running or failed test branch is not a release. Main's successful checks then gate the static Pages workflow.

Pages contains a genuinely precomputed example and local editing/review functionality, not a live numerical service. Production authentication, multiuser isolation, instrument response, measured-sample validation, uncertainty estimates, 2D periodicity, conical incidence, phase and general inverse design remain outside this stage.
