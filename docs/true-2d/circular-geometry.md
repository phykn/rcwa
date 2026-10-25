# Circular-hole geometry and bounded evidence

Schema 1.2 additively supports `circular_hole_2d` with `diameter_nm`, finite
`thickness_nm`, hole-fill `material`, and host `background`. The centered disk
must fit within both periods. Zero diameter gives the host; zero thickness is
inactive. Even a disk tangent to all four sides leaves host material in the
corners. Optical tables must cover every requested wavelength, including for
currently inactive materials.

The default is synthetic: three air-filled holes in hosts with refractive
indices 1.45, 1.55 and 1.50; periods 150 by 140 nm; diameters 65, 80 and 95 nm;
thicknesses 90, 120 and 130 nm; lossless ambient 1.0 and substrate 1.5. It uses
20-degree incidence, 25-degree azimuth, both incident polarizations, Hx=Hy=5 and
21 wavelengths from 450 through 850 nm at 20 nm intervals. These are illustrative
constant optical indices, not measured materials or an HBM/metrology model.

## Numerical geometry

Production adapters 1.3.0 and 1.4.0 approximate each circle using 64 equal-height horizontal
midpoint strips. Each strip has the exact disk chord width at its midpoint:

`width(y) = diameter * sqrt(1 - (2*y/diameter)^2)`.

The strip widths are mirrored to preserve the y symmetry. The resulting
piecewise-constant cells are passed to meent 0.13.2's continuous Fourier
integrals and directional inverse-rule matrices. There is no FFT pixel sampling,
material smoothing, or substitution of a rectangular hole. The independent S4
reference uses its analytical `S4_REGION_TYPE_CIRCLE`, with its own geometry
construction, optical interpolation, modal calculation and flux projection.

Spatial boundary refinement and harmonic refinement are distinct. Public jobs
always use 64 strips. Offline numerical commands may request 128 or 256 strips;
that override is explicitly marked, bound to the result, and rejected by the
public result contracts. No user-controlled spatial mesh option is exposed.

For an even number N of strips, the disk width is monotone on each half of the
circle. The symmetric-difference area between the disk and midpoint-step region
is bounded by `d^2/N`: strip height times half the total variation of the chord
width. Metadata adds a floating-coordinate allowance of `64*eps*Px*Py`, reports
the exact disk area and midpoint-strip area, and includes all declared circular
layers, including zero-diameter and inactive layers. This conservative area
bound is explicitly **not an optical-error bound**. A positive circular disk
smaller than representable cell-coordinate spacing can reduce to the host;
its area is below that floating-coordinate allowance.

## What the checks mean

- `scripts/circular_gate.py`: the complete default grid, comparing production
  H5/H7/H9 against independently constructed exact S4 circles at H5/H7/H9;
  separate fixed-H5 spatial refinement at 64/128/256 strips.
- `scripts/circular_offgrid.py`: supplementary H3/64-strip discovery every 2 nm,
  with predeclared prominence and curvature selection; selected off-grid points
  receive the same harmonic, spatial and independent checks. This sampled search
  cannot exclude arbitrarily narrow sub-2-nm resonances.
- Each comparison covers s and p incidence, R/T totals and order-resolved
  co-/cross-polarization channels, common-order signed residuals and the sum of
  power in added orders. Success thresholds remain 5e-4 absolute power for
  successive refinements and 2e-3 for independent/highest-basis comparison.
- A lossless flux balance check establishes conservation, not convergence.
  Every ordinary result retains `convergence_checked: false`; numerical evidence
  applies only to the exact recorded synthetic inputs and sampled wavelengths.
- `scripts/true_2d_worker_resources.py --circles` measures the real bounded
  worker, saved snapshot, restart and transport size with eight circle layers,
  31 wavelengths and H5. A local resource measurement is not a deployment SLA.

Run commands with single-thread BLAS and the pinned backend environment:

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python scripts/circular_gate.py \
  --s4-source /path/to/pinned/S4 --output /tmp/circular-convergence.json.gz
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python scripts/circular_offgrid.py \
  --output /tmp/circular-discovery.json.gz
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python scripts/circular_offgrid.py \
  --discovery /tmp/circular-discovery.json.gz --s4-source /path/to/pinned/S4 \
  --output /tmp/circular-offgrid.json.gz
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python scripts/true_2d_worker_resources.py \
  --circles --case high_contrast --output /tmp/circular-worker.json
.venv/bin/python scripts/build_circular_ui_reference.py --check
```

## Historical evidence stays historical

The existing rectangular default, public bundle, archived numerical reports and
recorded hashes are unchanged. Their source-bound tests now check the immutable
historical source snapshot in the test fixtures, rather than claiming that old
runs used the new circle-capable source. Current-source rectangular replay tests
continue to compare the frozen real default's powers, and current CI still runs
the independent rectangular and lossy/mixed-stack S4 gates. New runs use adapter
1.4.0; historical 1.3.0 results remain readable, and 1.2.0 results only for
non-circular projects.

Circular evidence is separate, with its own input hash, source hashes, reference
provenance and exact generated bundle. Renaming the old rectangular example
cannot establish circular-hole numerical accuracy.

The recorded complete-grid gate passed on 2026-10-11. Maximum absolute power
residuals were 6.28e-5 (production H5→H7), 3.90e-5 (H7→H9), 4.62e-4
(production H5 versus exact-circle S4 H9), 1.89e-5 (64→128 strips) and 6.30e-6
(128→256 strips). Rounded numbers here are conservative summaries; every signed
component and added-order tail is preserved in `circular-convergence.json.gz`.
The saved UI fixture has exactly the same spectra as that gate's H5 output.
Dependency source and binary-generation provenance is recorded separately in
`circular-environment.json`; the exact clean upstream S4 build is recorded in
`circular-reference-provenance.json`.

The supplementary discovery selected two centers (452 and 588 nm) and six new
wavelengths (451/452/453 and 587/588/589 nm). All targeted harmonic, spatial and
independent comparisons passed unchanged thresholds; the largest H5-versus-S4-H9
residual there was 2.39e-4. The complete discovery and subsequent checks are in
`circular-discovery.json.gz` and `circular-offgrid.json.gz`.

A real capped circle worker with eight layers, 31 wavelengths, H5 and eighteen
2,000-row material tables succeeded in 33.98 seconds (36.47 seconds including
snapshot/serialization checks). Observed combined peak RSS was 256.1 MiB, with
152.2 MiB in the worker; these are local observations. Its 1.993 MB request and
4.237 MB saved snapshot stayed within their respective HTTP boundaries. The
full duplicated SDK envelope was 8.988 MB, exceeding the 8 MB stdio cap: both
supported protocol representations therefore exercise the existing bounded
`response_too_large` middleware and idempotent HTTP snapshot recovery guidance.
No transport cap was relaxed, and no oversized success payload is silently
truncated. The resource report distinguishes offline SDK serialization from a
live transport trace. Snapshot persistence across SQLite restart and worker
cleanup were verified.
