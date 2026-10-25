# Experimental true-2D numerical validation

Historical report: this document records the numerical-only checkpoint
`cdfa4609ca35851dd5f058f84a9d65869b5f18f6`. Its hashes and counts below describe
that frozen generation. The later backend integration and freshly regenerated
archives are documented in [backend integration verification](backend-integration-validation.md).

At that checkpoint, the released application accepted only its existing 1D inputs.
No 2D API, worker admission, editor, fitting, default preview or deployment was
introduced. Ordinary results continued to say convergence not assessed.

## What is implemented

The isolated `rcwa_core.solver_2d.forward_2d` adapter uses pinned meent 0.13.2's actual coupled-vector x/y-periodic eigensystem, exact continuous Fourier cells, directional inverse-rule matrices and substrate-up multilayer recursion. It accepts one to eight centered rectangular patterned or homogeneous layers sharing one orthogonal period pair. Rectangular holes use the same geometry with exchanged inclusion/background materials. Mixed existing 1D layers are allowed in the proposed explicit numerical 1.2 input.

The adapter fixes the complex substrate TM port convention consistently with conjugated internal passive material indices, and uses atan2 for outgoing local polarization bases with the requested azimuth at zero transverse wavevector. Both incident s and p powers come from one coupled cascade. Results retain every integer (m,n), four outgoing polarization powers, total/specular powers and physical port classifications. They expose no complex amplitudes or Jones/ellipsometric claims.

All original tracked files at baseline `41b81d56ce1c6f19c37d3c732ea46c36d71f53c6` are unchanged. New source is additive. The core checkpoint is `15d1b45547e5239bcf00f8be28a3913f7d8c4428`; evidence also fingerprints the exact core files and installed engine sources.

## Distinct validation questions

1. Analytic/reduction/invariant tests check adapter behavior. They are not convergence proofs.
2. Same-Laurent S4 comparison isolates geometry, coupling, port, order mapping and outgoing-channel algebra. It is explicitly diagnostic and never replaces production inverse-rule convergence.
3. Production physical convergence requires two successive larger-basis changes at most 5e-4 absolute for totals and each common outgoing channel/order, plus summed added-order tails. The actual intended production basis must agree with independently converged S4 within 2e-3 absolute. Thresholds are fixed fixture-specific qualitative tolerances, not universal or metrology guarantees.

## Executed analytic and invariant coverage

The actual module passes independent 2x2 planar TMM controls across 288 combinations of non-air ambient, transparent/absorbing/metal-like substrate, normal/oblique incidence, azimuth and zero/eight-layer stacks. Additional tests cover both x-only and y-only legacy 1D reductions, normal phi45, quadrants, unequal periods/orders, exact x/y mirrors and 180-degree rotation, shared polarization cascade, mixed 1D/2D layers, lower-region loss, layer reversal/splitting, zero/full widths, zero-thickness bypass, exact/near external and internal cutoffs, omitted light-cone channels, material coverage, nonfinite/negative powers and input/order/channel tampering.

The x/y-transpose control is exact since adapter 1.4.0: every order and channel maps to its transposed partner within 1e-11 at H1–H3, and a square cell at normal incidence gives identical s and p powers. Adapters 1.2.0 and 1.3.0 showed a 2.97e-3 to 4.32e-4 transpose discrepancy, because pinned meent factorizes epx in the opposite order to epy; 1.4.0 rebuilds epx in epy's order. For circles the remaining s/p gap comes from the horizontal midpoint strips and shrinks as they refine. No blanket outgoing s/p swap is used.

Frozen 1.0/1.1 normalized JSON and hashes are exact. Local pre-edit versus additive-stage power arrays were bit-identical; portable checks allow 2e-12 absolute BLAS/CPU variation. Historical snapshots, API/MCP and job tests remain unchanged and pass.

## Independent reference provenance

Official S4 is pinned at `7fd00a231610bff51f5c7de5f723e3956eab7453`, with unchanged tracked source. The bridge supplies an explicit rectangular reciprocal basis, verifies every returned integer pair, and independently builds geometry, optical interpolation and incident vectors. It independently projects S4 uniform-port Hx/Hy amplitudes into outgoing s/p power and verifies component sums against S4's own order and total flux. No production convolution matrices are injected into S4.

The same-Laurent diagnostic archive covers 11 inputs / 13 wavelength samples including non-air ambient, unequal Hx/Hy, normal/principal/quadrant incidence, metal-like ports and tabulated mixed geometry. Its worst all-total/all-order/all-channel error is 3.33e-13 against a 1e-9 diagnostic threshold. See `laurent-diagnostic-results.json.gz` for raw evidence and source/build fingerprints.

## Accepted representative production regimes

These are synthetic fixtures, not measured devices.

- Multiple open channels: shallow weak-contrast three-layer stack, Px 680 / Py 590 nm, n0=1.33, substrate 1.7, theta 31 / phi 37 degrees, wavelength 632.8 nm. Bases (5,5), (7,7), (9,9). Production refinement maxima are 1.734e-6 and 8.323e-7; S4 refinements are 1.993e-6 and 1.451e-6. Actual H5 versus converged S4 differs by at most 9.823e-6. There are ten transmitted open channels and nonzero-order transmission exceeds 4e-4 for each incident polarization. This archive was independently recomputed without the harness comparison helper.
- Lossy mixed eight-layer stack: Px 460 / Py 420 nm, non-air ambient, lower inclusion/background absorption, metal-like substrate 0.4+3.1i. Bases (5,4), (7,6), (9,8). Production refinements are 1.210e-5 and 4.729e-6; S4 refinements are 1.535e-5 and 7.160e-6. Actual (5,4) versus converged S4 differs by at most 6.678e-5. Largest added-order absorbing tail is 1.948e-7. Finite-stack flux deficits are approximately 0.01892 (s) and 0.01615 (p). The final independent audit recomputed every archived comparison and approved this numerical fixture at commit cdfa4609.

Complete normalized inputs are under `backend/tests/fixtures/true-2d/representative/`; each matching `*-gate.json.gz` includes every production/reference result and signed comparison. Regression tests independently reconstruct those comparisons, check fixed tolerances, validate inputs/results/bases, and match source hashes.

## Accepted synthetic numerical default

The proposed example has passed its numerical gates at the exact input hash `eeb26da3484602221944f1784b4b93ce2ed76f89b61e95d34bb68730be7bddc7`. This is an offline fixture, not yet a public application default. The final independent audit approved this exact numerical evidence at commit cdfa4609, including all signed comparisons, generation/source bindings, dense-feature selection and perturbation controls.

The synthetic lossless stack uses periods 150/140 nm, air ambient, index-1.5 substrate, theta 20 / phi 25 degrees and both incident polarizations. From top to bottom: a 90 nm rectangle layer with widths 70x60 nm and inclusion/background indices 1.65/1.45; a 180 nm homogeneous index-2.1 film; and a 130 nm rectangle layer with widths 95x80 nm and indices 1.45/1.6. It is not a measured or actual HBM device.

All 21 default wavelengths (450–850 nm, 20 nm spacing) were evaluated with actual production H5/H7/H9 and independent S4 H5/H7/H9. Production refinement maxima are 2.554e-6 and 1.095e-6; S4 maxima are 3.048e-5 and 2.010e-5. Actual H5 versus independently converged S4 H9 is within 7.175e-5, and versus actual production H9 within 3.649e-6.

A full-band 1 nm exploratory scan selected local extrema and steepest intervals for 40 further 0.5 nm samples, including one overlap with the default grid: **60 distinct wavelengths** in total. All these local samples were rerun with the actual module and both S4 refinements. Dense production refinements are within 2.546e-6 and 1.092e-6; S4 refinements are within 2.756e-5 and 1.810e-5; actual H5 versus S4 H9 is within 6.390e-5. Neither solver showed a sampled H5-to-H9 extremum-position shift on those local grids. Every total, outgoing channel, integer order and signed added-order tail is retained.

Its nonzero reciprocal-order lower bound is 450/150-sin(20 degrees)≈2.658, above the largest finite-layer index 2.1 throughout 450–850 nm. This physical screen supports the design choice but does not replace convergence or exclude every possible sub-grid resonance. Added orders carry zero physical flux in the lossless ports; S4 retains signed roundoff tails up to 1.673e-22. Absorbing tails and multiple open channels are covered by the separate representative fixtures above.

Independently converged geometry controls establish visible pattern effects above the observed numerical discrepancies. Halving the top y width changes power by 0.004745 (33 times the sum of baseline/control reference discrepancies); halving the lower y width changes power by 0.007694 (257 times); removing both patterns changes power by 0.019069. These are input-specific synthetic demonstrations, not general sensitivity/error bounds.

The earlier broad-period high-contrast candidate failed its H5 refinement gate. A later weak-contrast broad-period candidate passed coarse samples but was rejected after the 1 nm scan found narrow resonances; at 806 nm its H5-to-H7 p-input transmitted-p zero-order change was 0.00599218, above 5e-4. Rejected raw evidence remains archived rather than being relabelled as accepted.

`default-convergence-evidence.tar.gz` holds full raw arrays, immutable generation manifests, exact input/result, signed comparisons, rejected-candidate evidence and reference source/build scripts. Its inventory covers 971 files; 438 accepted-basis caches were source/input-audited and all 839 array records losslessly round-tripped. `default-evidence-package.json` records the archive SHA256. The full ordinary H5 batch passed the result contract and matched all individually generated default samples exactly. That frozen result is adapter-1.2.0 evidence and stays archived unchanged. A fresh actual-module regression checks every wavelength/channel against `default-result-H5-adapter-1.4.json.gz` at 1e-10 absolute portability tolerance, far below the scientific thresholds. All ordinary outputs retain `convergence_checked=false`; arbitrary edits do not inherit acceptance.

## Adapter 1.4.0 re-check against archived S4 references

Adapter 1.4.0 changes only the epx factorization order (see `conv_matrices_2d` in `solver_2d.py`). The archived S4 references above were not regenerated; current production was rerun on each archived input and compared with them using `scripts/true_2d/convergence.py`:

| Input | Shipped basis vs converged S4, 1.3.0 | Same, 1.4.0 | 1.4.0 minus 1.3.0 |
|---|---:|---:|---:|
| Synthetic default, 21 wavelengths (S4 H9) | 7.175e-5 | 7.258e-5 | 3.56e-6 |
| Multiple open channels (S4 H9) | 9.822e-6 | 1.002e-5 | 1.97e-7 |
| Lossy mixed eight-layer (S4 (9,8)) | 6.678e-5 | 6.775e-5 | 1.42e-6 |
| Circular default, 21 wavelengths (S4 H9) | 4.613e-4 | 5.598e-4 | 3.14e-4 |

All remain inside the 2e-3 independent gate. `test_current_and_archived_default_meet_the_accepted_independent_s4_gate` and `test_current_circular_default_meets_the_archived_converged_s4_gate` recheck the default and circular rows. The archived S4 reference uses Laurent factorization, so closeness to it is a gate, not a ranking of factorizations. Rerun with 1.4.0, the production refinement maxima are 2.85e-6 (H5→H7) and 1.25e-6 (H7→H9) for the synthetic default, and 8.97e-5 and 5.39e-5 for the circular default; H5→H9 is 4.10e-6 and 1.44e-4. All stay inside the 5e-4 refinement gate. These reruns are not archived.

## Resource observations and deferred release gates

Single-thread standalone H5, 31-wavelength, eight 2 µm-layer cases completed in 34.8 s and 33.3 s. Peak process RSS was 99.3 MiB and 92.6 MiB; compact JSON was about 2.24 MB. Both satisfy local 90 s / 6 MB targets. These are observed cases, not worst-case/deployment guarantees.

No actual worker admission or cancellation integration was changed or tested for 2D. Before public integration: enforce one heavy 2D job within the two-slot manager; test heavy-plus-legacy admission, two-user contention, cancellation, 120 s termination cleanup and subsequent restart; measure deployed memory headroom and output boundaries. Preserve explicit version/geometry-tag parser-schema parity, old hashes, result/input binding, no 2D fitting and honest exact-geometry previews. See `numerical-stage.md` for the binding independent-review amendments.

## Aggregate local checks

- Backend: 915 passed, two PostgreSQL-service-dependent tests skipped, one dependency deprecation warning; 55.32 s. This includes a fresh full21 ordinary H5 solve and all archived package/hash checks.
- Ruff: backend and all new numerical harnesses pass.
- Unchanged frontend: 197 tests pass; lint and production build pass. No 2D UI or pixel acceptance is claimed.
- All 105 files tracked in the released baseline were compared byte-for-byte with Git blobs: zero changes. The released source worktree is still clean at the original baseline.

These are local numerical-stage checks. A later integrated release still needs its full CI, PostgreSQL service checks, actual worker tests, independent review and pixel checks on the same publication candidate.

## Reproduction

Use the pinned environment with OPENBLAS_NUM_THREADS=1 and OMP_NUM_THREADS=1.

- `ruff check backend scripts/true_2d*.py scripts/true_2d`
- `pytest -q`
- `python scripts/true_2d_reference.py --s4-source /path/to/pinned-clean-S4 --output /tmp/laurent.json.gz`
- `python scripts/true_2d_gate.py --project backend/tests/fixtures/true-2d/representative/multiple-open-channels.json --s4-source /path/to/pinned-clean-S4 --output /tmp/open-orders.json.gz`
- For the unequal lossy fixture, use its JSON and `--first-refinement 7,6 --second-refinement 9,8`.
- `timeout 120s python scripts/true_2d_resources.py --case high_contrast --output /tmp/resource.json`

The expensive optional S4 checks rebuild official source, require existing g++/make/BLAS/LAPACK, and do not download dependencies or publish anything. Full default/dense reference generation is an offline validation task; the public H5 compute profile does not expose H7/H9.
