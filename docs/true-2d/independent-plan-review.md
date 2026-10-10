# Independent pre-implementation review: true 2D multilayer RCWA

Date: 2026-10-10. Reviewed baseline: 41b81d56ce1c6f19c37d3c732ea46c36d71f53c6. Application checkout remained unchanged. This is a plan review, not release approval.

## Decision

The numerical architecture is feasible. Approve a bounded numerical-only implementation stage after the parent releases the baseline and the conditions below are incorporated. Do not proceed to general application integration/default publication until the numerical gate closes. No evidence of a fundamental coupled-2D or port-normalization blocker was found. Physical convergence of the current high-contrast candidates remains unresolved.

## Verified findings

I inspected the actual installed meent 0.13.2 convolution and transfer code, the spike adapter, S4 driver and amplitude projection, current 1D contracts/solver tests, and the plan. The four meent source checksums match those recorded in the plan. S4 tracked source is clean at official commit 7fd00a231610bff51f5c7de5f723e3956eab7453; only build/reference-driver files are untracked.

The conjugated finite-layer indices, q=conj(sqrt(N_public^2-kx^2-ky^2)), substrate q/conj(N_public)^2 boundary block, and internally conjugated n_bot passed to TM power normalization are consistent. Replacing atan(ky/kx) with atan2(ky,kx), using the incident reference azimuth only at zero transverse wavevector, correctly handles normal incidence and all quadrants. The coupled solver returns both incident polarizations from one cascade; do not solve it twice. Index order is n outside, m inside, with output shape (2Hy+1,2Hx+1).

Independent additional controls run during this review:

- Matched-Laurent/S4 comparisons at Hx=2, Hy=3, ambient n=1.33, Px=460, Py=420; normal phi=0/45/90/180/270, oblique principal axes/quadrants, and metal-like substrates: all outgoing s/p order components agreed within 1.801e-13 across 12 scenarios. The explicit returned G set was verified.
- Production inverse-rule y-periodic-only patterns (full x width), phi=90, ambient n=1.33, theta=0/31/67, transparent and metal-like substrates: every retained n order matched the existing x-periodic 1D solver after axis relabeling within 1.011e-14. Forbidden m!=0 powers were at most 6.115e-29.
- Production inverse-rule centered-rectangle x mirror, y mirror, and 180-degree rotation with unequal Hx/Hy: all outgoing components agreed after order relabeling within 1.531e-14. These are exact finite-formulation symmetries and should not receive loose x/y-transpose convergence tolerances.

These controls validate adapter algebra, normalization, geometry reduction, and mapping. They do not establish high-contrast physical convergence.

## Required plan clarifications and release conditions

1. Gate the actual shipped basis. A converged H9/H11 reference does not validate an H5 default. At every shipped wavelength, require the actual H5 result to satisfy the unchanged independent-reference threshold, and demonstrate at least two higher-basis refinement checks for the production and reference formulations. Record H5-to-reference and H5-to-highest-production residuals explicitly; do not merely show two high-H runs agreeing.

2. Preserve all four outgoing power components throughout production refinement. The current default-refinement and per-order-refinement files retain R/T by incident polarization, but do not retain all four outgoing s/p components. The Laurent cross-control does retain components, but cannot substitute for production convergence. Store R_s/R_p/T_s/T_p, their sums and totals, signed residuals, basis lists, complete inputs, source/build hashes and settings. For growing bases, compare common orders and separately sum the newly added tail; maximum-per-order error alone can hide a significant summed tail, especially in absorbing ports.

3. Preserve the 5e-4 refinement and 2e-3 independent absolute tolerances. These mean 0.05 and 0.2 percentage points of incident power, respectively, and suit a bounded qualitative example, not metrology or a universal guarantee. Do not relax them to admit the existing high-contrast candidate. Avoid accepting a pattern whose apparent 2D effect is smaller than the demonstrated numerical uncertainty. Every default wavelength must pass; inspect a denser wavelength grid around sharp resonances and cutoff approaches so a coarse plotted sweep does not imply unsupported spectral resolution.

4. Make convergence claims input-specific. The result of an edited user structure must default to convergence not assessed, even if power conservation and cutoff checks pass. Any validated-example indication must be tied to the exact input/basis/wavelength hash. High contrast, sharp corners, resonances and metal-like materials may need orders beyond the public H5 profile. Convey this in one compact status/caption and API metadata, without adding editor clutter. A successful solve is not a convergence certificate.

5. Add the independently tested non-air ambient, unequal-basis, y-only reduction and exact mirror tests to the numerical suite. Include normal phi=45 and quadrant incidence, mixed 1D/2D layers and multiple open channels. Keep x/y interchange/90-degree geometry rotation separately refinement-aware, because the sequential directional factorization is not exactly x/y symmetric at finite basis. Do not apply a blanket s/p swap to every diffracted order at normal incidence: outgoing local bases and the zero-order reference basis transform differently.

6. Keep resource bounds provisional until tested through actual workers. Hx/Hy<=5, <=31 wavelengths, <=8 layers and one heavy job are reasonable starting caps. Test worst allowed lossy/high-contrast/thick stacks, output sizes, two-user admission, heavy plus legacy jobs, cancellation/timeout cleanup, and restart of a subsequent job. Current JobManager has two total process slots; a new heavy-job admission rule must be explicit and tested. Retain the documented single-API-process deployment assumption or provide shared admission if changing it. Never claim the 53-second spike establishes worst-case runtime.

7. Preserve schema and UI boundaries as written: frozen 1.0/1.1 normalized JSON/hashes/results, explicit 1.2 conversion, no 2D fitting, exact geometry-driven preview and hash changes, one selected-layer editor, and the existing headless HTTP/MCP/preview-apply flow. Actual repeated holes/pillars can be compelling without adding shadows, decorative 3D effects, or extra always-visible panels.

## Why the current high-contrast discrepancy is not a fundamental blocker

Recomputing deltas from the saved three-layer production/S4 refinement evidence gives:

- Meent H3->5 / H5->7 / H7->9 maximum total-or-order R/T changes: 0.00215649 / 0.000653733 / 0.000279560.
- S4 default H3->5 / H5->7 / H7->9: 0.0123181 / 0.00586897 / 0.00341326.

S4 is plainly not converged to the proposed gate at H9, so the 0.01351 intersolver residual cannot establish that the production adapter is wrong. Equally, the residual cannot be called acceptable agreement. The current high-contrast default's H5->H7 error 0.00757 remains a release failure.

Official S4 documentation distinguishes Laurent and polarization-decomposition formulations and their accuracy/resolution controls. A different finite-basis result is expected until each formulation converges. Using production convolution matrices inside the reference would invalidate independent geometry/factorization validation.

## Promising bounded reference cases, not accepted defaults

I ran exploratory production H3/H5/H7 and independent default-S4 H3/H5/H7 checks at wavelengths 450, 632.8 and 850 nm with Px=460, Py=420, theta=20, phi=25, ambient=1, substrate=1.5. Layer tuple order below is thickness, width X, width Y, inclusion n,k, background n,k.

A genuinely weak-contrast two-patterned-layer stack:

- (90,220,180,1.65,0,1.45,0)
- (180,460,420,2.1,0,1,0)
- (130,290,240,1.45,0,1.6,0)

Its maximum production all-component H3->5 change was 4.138e-5 and H5->7 was 1.227e-5; S4 maximum R/T refinement changes were 7.303e-5 and 4.523e-5. H5 production versus S4 H7 totals/orders differed by at most 1.715e-4. Small dielectric contrast reduces discontinuity-induced high-order sensitivity while the uniform high-index film retains spectral structure. This is evidence that a bounded profile is viable, but all wavelengths, S4 outgoing components and further refinements still need the full gate.

A shallower actual air-pattern alternative:

- (30,220,180,1.5,0,1,0)
- (180,460,420,2.1,0,1,0)
- (40,290,240,1,0,1.45,0)

At the same three wavelengths its production H5->7 maximum change was 2.529e-4 and H5 versus S4 H7 differed by at most 0.001727. However H3->5 reached 7.432e-4, so it does not yet have two accepted refinements; it needs higher-basis/component/full-sweep evidence. The thin patterned layers reduce accumulated phase and high-contrast coupling without pretending the pattern is a homogeneous film.

## Primary sources

- https://web.stanford.edu/group/fan/S4/tutorial.html (formulations and separate resolution/truncation controls)
- https://web.stanford.edu/group/fan/S4/python_api.html (basis, incident polarization, flux/amplitudes)
- https://meent.readthedocs.io/en/latest/sequence/seq.html (coupled 2D geometry/order conventions; installed source is authoritative for pinned parameter names)

Final status: numerical-stage plan conditionally accepted; current default and general release not accepted. No application files were edited and nothing was published.
