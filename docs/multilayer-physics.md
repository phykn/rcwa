# Bounded multilayer numerical evidence

## Scope and result

Adapter `1.1.0` adds 1–8 top-to-bottom finite layers under one common period. Each layer is an exact centered `rectangle_1d` or a `homogeneous` film. This document records tests of the actual application implementation, not only the preliminary feasibility calculation.

On 2026-10-10:

- **253 core, physics, and existing static-reference tests passed** using the command below.
- **540 independent planar TMM samples** had maximum absolute R/T error **2.1095e-15**, below the **2e-10** gate. Samples span s/p polarization, three wavelengths, angles 0/31/67°, ambient indices 1/1.33, transparent/absorbing/metal-like substrates, 2/3/8 films, lower-layer absorption, and zero/all-zero thicknesses. Additional tests cover total internal reflection and lower-layer independent interpolation.
- **40 official pinned-S4 scenarios / 276 polarization-wavelength samples** agreed in totals and **every retained order** to **5.7477e-13**, below the **1e-9** gate. All 19 legacy cases remain in the default reference run; 21 new scenarios cover multilayers.
- **19 pre-upgrade real projects**, frozen from commit `ec9fa014c7e7027d387a2fd478c0b7190b267783`, retained exact normalized inputs, canonical hashes, and spectra. No spectral differences were observed. New results intentionally have schema `1.1` and the new metadata; historical result readers retain schema `1.0`.

These are finite-basis and finite-test-case checks. They do not establish physical convergence for arbitrary inputs, material authenticity, instrument agreement, parameter uniqueness, or metrology accuracy. See [machine-readable summary](multilayer-validation-summary.json) and [complete S4 evidence](multilayer-reference-results.json.gz), which include source hashes. The existing single-layer evidence is preserved separately.

## Independent planar reference

`backend/tests/test_stack_physics.py::planar_tmm` uses independent tangential-electric-field 2×2 characteristic matrices with public `N=n+i*k`, `exp(-i*omega*t)` conventions. For each uniform slab it multiplies the matrix formed from its longitudinal wavevector, admittance, thickness, sine, and cosine. The input and substrate admittances give reflected amplitude and substrate entrance-plane transmitted flux.

This reference does not call meent, the application Fourier compiler, its interpolation helper, or its modal recursion. Its finite test materials/thicknesses avoid characteristic-matrix overflow; this small independent reference is not a replacement solver for arbitrary thick absorbing stacks.

The application retains the corrected complex-port initialization, then uses pinned meent 0.13.2 Fourier matrices, eigensolve, and recursive transfer operations. Layers recurse from the substrate upward. No pseudoinverse, smoothing, damping, angular perturbation, or output clipping is introduced.

## Independent S4 reference

`python scripts/reference_check.py --s4-source ... --output ...` builds the clean official `victorliu/S4` commit `7fd00a231610bff51f5c7de5f723e3956eab7453`. The independent driver receives all physical layers in top-to-bottom order, including zero-thickness entries, and explicitly fixes the same reciprocal-vector set. It independently evaluates tabulated n and k.

New cases include:

- Two distinct rectangles at H=3/7/11/15/19 and angles 0/31/67°
- Pattern above an absorbing film; film above an absorbing pattern
- Absorption only in a lower layer's background
- Three homogeneous films and eight physically distinct patterned layers
- Zero-thickness insertion, an all-zero stack, and CD=0/full-period limits
- Splitting an identical pattern and reversing unequal planar films
- Multiple propagating diffraction orders
- Distinct lower-layer ridge/background material tables
- Absorbing and metal-like substrate ports

Full inputs, totals, every order, error, package versions, compiler recipe, S4 commit, and source hashes are in the compressed evidence. Rerun this script locally when the numerical core changes. This comparison establishes agreement between two independent implementations of the Fourier-modal method at matched finite bases, not independent experimental truth.

## Geometry, contracts, and failure tests

Tests also verify:

- Splitting an identical layer leaves all retained-order powers invariant
- Inserting zero thickness leaves spectra exactly unchanged and only changes physical layer count
- CD=0/full rectangles agree with homogeneous films
- Reordering unequal layers changes the spectrum and agrees with the independent reordered TMM
- All-zero stacks bypass Fourier compilation and the eigenproblem entirely
- Active-region loss accounting excludes zero-thickness layers and absent degenerate-rectangle regions, including with absorbing substrate ports
- `A_balance=1-R-T` is the finite-stack flux deficit; T is substrate entrance-plane flux
- Lower-layer coverage errors report the correct layer/material path, including unused declared materials
- Malformed fields, over-limit stacks, unsupported fits, tampered stack metadata, and legacy worker output are rejected
- Historical forward readers remain available without weakening current worker validation
- Input schema `1.0` remains one rectangle in runtime validation and in the generated JSON Schema, including when its version is omitted
- An ordinary result always reports `convergence_checked=false`
- Nonfinite, significantly negative, or energy-creating mock outputs raise errors rather than being clipped
- Fourier singularities are surfaced as numerical failures

An **exact internal homogeneous modal cutoff** would make pinned meent's modal inverse singular even when neither external port is at a Rayleigh cutoff. A stack with no patterned layer couples only the specular order, so it is solved with that order alone: the test with n=1.5, period 400 nm, wavelength 600 nm, normal incidence, and substrate n=1.7 matches the independent TMM, as do nearby indices n=1.5±1e-6. In a patterned stack, preflight rejects a retained order exactly tangent inside any uniform slab (a film, a degenerate rectangle, or a rectangle whose two materials match) as a `rayleigh_cutoff`. Nothing is hidden with artificial loss or angular perturbation. A modal cutoff inside a patterned slab is not predicted by preflight and still fails explicitly with `SolverError`, so preflight is not a promise that every admissible point can be solved.

## Harmonic refinement is separate evidence

For the two-rectangle example (95 nm/CD167/n2.4 above 130 nm/CD247/n1.8/background1.1, period400, angle31°, wavelengths450/632.8/850), the maximum change in total R/T across both polarizations is:

| Basis change | Maximum absolute change |
|---|---:|
| H3 → H7 | 0.0038458966 |
| H7 → H11 | 0.0002348984 |
| H11 → H15 | 0.0001622817 |
| H15 → H19 | 0.0000494521 |

These changes are vastly larger than the matched-basis S4 discrepancy. They are sample-specific observations, with no universal stopping tolerance or convergence certificate implied.

## Resource observation

One local single-threaded-BLAS solve with **8 distinct layers, H20, 81 wavelengths, both polarizations** completed in approximately **2.4 seconds**, with finite output and validated metadata. The measurement process peak RSS was approximately **65 MiB** after its other numerical checks. The exact local observation is in the summary JSON. It is not a worst-case runtime, memory, or platform guarantee. Existing application process/deadline limits remain necessary.

## Reproduce

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python -m pytest \
  backend/tests/test_physics.py backend/tests/test_core_contracts.py \
  backend/tests/test_stack_physics.py backend/tests/test_stack_contracts.py \
  backend/tests/test_reference_fixture.py -q

OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python scripts/reference_check.py \
  --s4-source /tmp/rcwa-s4-upstream --output /tmp/rcwa-multilayer-reference.json

gzip -dc docs/multilayer-reference-results.json.gz > /tmp/rcwa-saved-multilayer-reference.json
```

Numerical gates are separate from API/storage, MCP protocol, frontend, browser/visual, and remote publication gates. A pass here alone does not authorize merging or publishing the application.
