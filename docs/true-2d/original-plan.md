# True x/y-periodic multilayer RCWA: next-stage implementation and acceptance plan

Status: preparation only, 2026-10-10. No application files were edited, no branch was created, and nothing was published. The inspected checkout remains clean at `41b81d56ce1c6f19c37d3c732ea46c36d71f53c6`. The parent reports that the approved 1D stage has since merged; implementation must start only on the baseline the parent releases after independent review of this plan.

## Decision

Proceed with a separately versioned, bounded **centered axis-aligned rectangular inclusion** in an orthogonal x/y lattice, in 1–8 top-to-bottom finite layers. The same inclusion implements a pillar or a rectangular hole by exchanging its material and background. Retain homogeneous films and existing x-periodic 1D rectangles. All layers share one x/y period pair. Do not add circles, offset patterns, rotation, arbitrary polygons, skew lattices, sloped sidewalls, anisotropy, ellipsometry, fields, fitting, or a second production solver in this stage.

The installed NumPy meent 0.13.2 backend has genuine coupled-vector 2D multilayer support. This is backend feasibility, **not validated application support**. It needs a 2D-specific port/basis adapter and new contracts, preflight, independent reference evidence, resource controls, and honest UI rendering.

## 1. Numerical architecture and the two necessary adapter corrections

Use the installed `to_conv_mat_vector(cells, Hx, Hy)` and `transfer_2d_2/3/4` functions, complex128, direct inverses, and the existing substrate-up recursion. A nondegenerate rectangular layer is at most a 3-by-3 piecewise-constant index cell with exact segment ends at `(P-CD)/2`, `(P+CD)/2`, and `P`; this is continuous Fourier integration, not image rasterization. Layer thickness order stays top-to-bottom. Skip zero-thickness layers before Fourier compilation. A zero width in either axis means all background; both full widths mean all inclusion material; one full width means the correct 1D reduction. Explicitly handle these limits rather than introducing zero-length segments.

Corrections required before calling the upstream cascade:

1. Preserve the public convention `N=n+i*k`, exp(-i omega t), while finite-layer cells contain conjugated N for meent. Form normalized real kx/ky from the lossless incident medium, and use `q = conj(sqrt(N_port**2 - kx**2 - ky**2))`. Initialize the substrate blocks with `q/conj(N_substrate)**2`, not `q/N_substrate**2`. Pass the internally conjugated substrate index to the final TM power calculation. The installed 2D initializer repeats the same mixed port convention already corrected for the 1D adapter.
2. Replace its `atan(ky/kx)` basis construction with real `atan2(ky,kx)`. At a zero transverse vector, use the explicit incident reference azimuth. Do not use the high-level `theta=0` perturbation, artificial absorption, pseudoinverse, or clipping. This removes division by zero at normal incidence and axial orders without changing the requested direction.

The 2D eigensystem is 2N by 2N and the final boundary system is 4N by 4N, where N=(2Hx+1)(2Hy+1). Both incident s and p results are already returned from the same cascade; do not solve the whole stack twice for `polarization=both`.

## 2. Public input contract and compatibility

Add an explicit project schema `1.2`; keep frozen 1.0 and 1.1 normalizers/readers. Absence of `schema_version` must still mean the historical 1.0 input. Do not add null/default 2D fields to old normalized objects: hashes use `model_dump()`, so doing that would invalidate saved inputs.

Proposed 1.2 additions/replacements:

- `period_nm`: retain the existing name for x period; UI label is “Period X”.
- `period_y_nm`: required positive y period; same 20–5000 nm bounds. No alternative aliases or skew vectors.
- New layer discriminator `geometry: rectangle_2d`, with `cd_x_nm` and `cd_y_nm`, each 0 through its corresponding period. Retain `name`, `thickness_nm`, `material`, and `background`. No separate `hole` physics flag is needed.
- Existing `rectangle_1d` and `homogeneous` layer contracts stay valid inside 1.2. A 1D layer is invariant y. Homogeneous layers have no width or background controls.
- `illumination.azimuth_deg`: 0 <= phi < 360, default 0; existing angle remains 0–75 degrees. `s`, `p`, and `both` are the only incident states.
- 1.2 `solver` has `harmonics_x` and `harmonics_y` instead of scalar `harmonics`. Each initially 1–5, default 3; the selected default example uses 5. Internal/reference tests may use zero in one axis or larger orders; the initial public true-2D profile need not expose those modes.
- 1.2 maximum 31 wavelength samples, 1–8 physical finite layers; retain existing wavelength/material/thickness ranges. Legacy 1D limits remain H<=20 and <=81 wavelengths.
- Explicitly reject 2D synthetic fitting in HTTP, MCP, and UI. Do not silently apply the old first-layer CD fit to either 2D dimension.

Implement one shared version-dispatch parser and generate matching JSON Schema/TypeScript/MCP contracts. Return 1.2 result contracts only for 1.2 inputs. Historical forward readers remain, and existing 1D new runs retain their 1.1 result shape. Project conversion to 1.2 is an explicit edit with a new input hash, not an implicit load/save migration.

Compatibility gate: all frozen 1.0 projects retain byte-equivalent normalized JSON, hash, and power arrays; add equivalent frozen 1.1 multilayer fixtures before editing. All old storage migrations, snapshots, worker binding, preview/apply hashes, stale-result rejection, agent examples, and MCP tests must continue to pass.

## 3. Power, orders, polarization, and preflight

Use order `(m,n)` with x fast, y slow: n=-Hy..Hy outside, m=-Hx..Hx inside. meent arrays have shape `(2Hy+1, 2Hx+1)`. The zero order is `[Hy,Hx]`; never infer labels from array length or S4's basis order.

Normalized transverse wavevectors are:

- kx/k0 = n_ambient sin(theta) cos(phi) + m wavelength/Px
- ky/k0 = n_ambient sin(theta) sin(phi) + n wavelength/Py

Incident s has electric direction (-sin(phi), cos(phi), 0); incident p lies in its incidence plane. At normal incidence phi defines the polarization reference axes, which still matters for a rectangular anisotropic pattern. Every outgoing order has its own local s/p basis perpendicular/parallel to its transverse wavevector; use the same reference phi when that vector vanishes.

A 1.2 order record should contain `m`, `n`, `kx_over_k0`, `ky_over_k0`, `R`, `T`, `R_s`, `R_p`, `T_s`, `T_p`, and the existing propagation/classification fields. The surrounding `spectra.s` / `spectra.p` selects the incident polarization. Thus `spectra.s...R_p` is cross-polarized reflection. Enforce R=R_s+R_p and T=T_s+T_p per order, aggregate/specular identities, ordered complete basis, and input/result binding. No complex amplitudes, Jones matrices, or ellipsometric parameters are public.

Normalize to incident normal Poynting flux. In the internal convention, s power weights Re(q)/(n0 cos(theta)); p power weights Re(q/conj(N_port)^2)/(n0 cos(theta)). Retain entrance-plane T for an absorbing substrate and label it as an absorbing half-space, without a misleading propagating/evanescent boolean. `A_balance=1-R-T` remains finite-stack flux deficit.

Generalize preflight to the full 2D light cone. Enumerate the finite integer bounding rectangle implied by the largest lossless port index and reject any physically propagating `(m,n)` missing from the retained basis. Do not check only four corners or two scalar x edges. Check q_squared=n_port_squared-kx_squared-ky_squared for cutoff across the full retained grid, preserve exact-cutoff failure and near-cutoff warning, and check every declared material table without extrapolation. Explain that internal modal singularities can still fail after preflight. Use actual occupied regions for finite-stack loss accounting.

## 4. Independent evidence and acceptance thresholds

Separate three questions:

A. **Same-basis algebraic agreement.** Freeze official S4 at commit `7fd00a231610bff51f5c7de5f723e3956eab7453`. Supply the exact explicit rectangular list of G=(m,n) through its C API; verify returned G and remap by integer labels. A requested NumBasis is not enough because the usual S4 selection is circular/symmetry-preserving. Independently build geometry, interpolation, and incident vectors. Compare totals and every retained order, and independently project uniform-port Hx/Hy amplitudes into outgoing s/p powers. Use <=1e-9 maximum absolute discrepancy for matched formulations. Preserve a deliberately diagnostic Laurent-matrix control, not as the production algorithm: it isolates port, coupling, normalization, and order-mapping errors from Fourier-factorization differences.

B. **Production inverse-rule physical convergence.** meent's directional inverse-rule Fourier matrices differ from S4's default 2D Laurent formulation. Do not falsely require or claim 1e-9 agreement at an equal low basis. Run both at explicit increasing rectangular bases; record all per-order/per-polarization residuals, not just totals. S4 polarization-decomposition variants have an additional basis-field resolution control: if used, refine that separately and preserve its settings and flux errors. Do not alter S4 internals to import production meent matrices and call that independent geometry validation.

Proposed release gate for selected representative fixtures and the shipped default: two successive larger-basis changes <=5e-4 absolute in totals and each retained outgoing polarization/order, and independent solver agreement <=2e-3 absolute after each reference's own convergence is demonstrated. Include reference truncation/tail changes for absorbing ports, where high orders can carry entrance-plane flux. If a feature does not meet this gate within the reviewed computation budget, report it as unresolved; simplify/tune the default or widen the offline reference budget. Do not relax the gate after seeing a failure or label a single run converged. These are fixture-specific evidence thresholds, not promises for every user-supplied structure.

C. **Reductions, invariants, and failures.** Planar multilayers must agree with the independent characteristic-matrix TMM to <=2e-10, including tabulated/lossy/metal-like substrates and zero/all-zero layers. Genuine 2D-to-current-1D reductions with full y width and phi=0 must match totals and every m order to <=1e-9, with n!=0 powers <=1e-10. Preserve duplicate-layer split, zero-thickness insertion, full/zero-width, equal inclusion/background, physical layer reversal, lossless/passive, and unmodified historic tests. Enforce existing no-clipping passivity tolerances: powers >=-1e-8; lossless |1-R-T|<=1e-6; passive balance >=-1e-6. Fail nonfinite output.

New fixtures must include: unequal Px/Py and Hx/Hy to catch transposes; holes and pillars; two distinct patterned layers separated by a film; mixed 1D/2D layers; loss confined to a lower inclusion/background; 8 layers; nonzero azimuth; phi=0/90/180/270; exact normal incidence; lossy and metal-like substrate; multiple propagating orders; material-table coverage failures; axis/full-width degeneracies; retained/missing light-cone channels; near/exact external and internal cutoffs; geometry/order/channel tampering. Use x/y-transpose and rotational-symmetry tests with refinement-aware tolerances: the production directional factorization itself has a small finite-basis orientation error, observed below. Only claim exact symmetry when the finite formulation warrants it. Do not demand every cross channel vanish in a mirror-symmetric 2D sample: off-plane diffracted orders use different local s/p axes.

## 5. Resource profile

Initial public cap: Hx,Hy<=5 (N<=121), <=31 wavelengths, <=8 layers, complex128, single-thread BLAS, at most one heavy 2D calculation at a time. Keep cancellation and 120-second deadline; check result bytes against the existing 8 MB worker boundary. Preserve old 1D limits. Do not grant H20 in both axes: that becomes 1681 orders, a 3362-mode eigenproblem, and a 6724-square final system, with roughly 690 MiB for just one complex128 final matrix.

The initial cap is a conservative proposal, not a measured worst-case guarantee. Before release, run max-size lossy/high-contrast/worst-layer cases and two-user admission/cancellation tests in the deployed resource class. Require no OOM, valid completion below a 90-second target, result serialization below 6 MB, and adequate combined-process memory headroom; lower the cap if these fail. Larger H7/H9 remain offline validation initially. A later adaptive cost budget can expose higher H for few samples without simultaneously allowing the maximum in all dimensions.

## 6. Minimal useful UI and an honest compelling default

Keep the compact selected-layer picker. Selecting `rectangle_2d` reveals Width X and Width Y plus inclusion/background material fields. Its contextual “pillar / hole” choice should only swap/preset materials, with the normal change preview showing the actual edit. Reveal Period Y, azimuth, and Hx/Hy only for 1.2 projects; a square-period lock may be a UI convenience, never a separate hidden physical input. Homogeneous layers show no irrelevant widths.

Use actual repeated rectangular holes/pillars in a small 3-by-3 x/y isometric stack and a selected-layer top view. Both must share the numeric geometry definition with preview tests. Mark top/bottom order, units, and repeated x/y axes. Keep the spectral chart initially simple; a contextual diffraction-order panel can show `(m,n)` and co/cross contributions. Avoid duplicating the entire editor, tables, or secondary panels by default. A change in y width must produce a changed numerical input/hash and a newly computed 2D spectrum, not just a different drawing.

Recommended default candidate: “2D nanohole cavity”, Px=460 nm, Py=420 nm, lossless ambient n=1, substrate n=1.5, theta=20 degrees, phi=25 degrees, both incident polarizations, 21 wavelengths 450–850 nm in steps of 20, Hx=Hy=5. Top-to-bottom:

1. 140 nm synthetic dielectric n=2.4 with a centered 220-by-180 nm air hole.
2. 90 nm homogeneous synthetic spacer n=1.45.
3. 180 nm synthetic dielectric n=2.1 with a centered 260-by-230 nm air hole.

This is one shape with genuinely different x/y dimensions and two independently patterned layers. It produces structured polarization-dependent spectra and visibly different layers. Label every material synthetic; do not imply fabricated performance. **This candidate is not accepted yet:** its H5→H7 worst power change was 0.00757, so it fails the proposed default convergence gate. Its role is a concrete starting point for parameter tuning during the numerical stage. Do not ship it or mark it validated merely because it looks impressive.

Example 1.2 input shape (material naming/default fields omitted for brevity):

```json
{
  "schema_version": "1.2",
  "name": "2D nanohole cavity",
  "period_nm": 460,
  "period_y_nm": 420,
  "ambient": {"n": 1, "k": 0},
  "substrate": {"n": 1.5, "k": 0},
  "layers": [
    {"geometry": "rectangle_2d", "thickness_nm": 140, "cd_x_nm": 220, "cd_y_nm": 180, "material": {"n": 1, "k": 0}, "background": {"n": 2.4, "k": 0}},
    {"geometry": "homogeneous", "thickness_nm": 90, "material": {"n": 1.45, "k": 0}},
    {"geometry": "rectangle_2d", "thickness_nm": 180, "cd_x_nm": 260, "cd_y_nm": 230, "material": {"n": 1, "k": 0}, "background": {"n": 2.1, "k": 0}}
  ],
  "illumination": {"angle_deg": 20, "azimuth_deg": 25, "polarization": "both", "wavelengths_nm": [450,470,490,510,530,550,570,590,610,630,650,670,690,710,730,750,770,790,810,830,850]},
  "solver": {"harmonics_x": 5, "harmonics_y": 5}
}
```

## 7. Phase order and stopping gates

1. Independent plan review and parent-released baseline. Freeze historical 1.0/1.1 artifacts and hashes first. No app changes before release of that baseline.
2. Numerical-only adapter and reference harness: exact geometry, correct ports, explicit order mapping, independent polarization powers, reductions, passivity, resource profiling, and converged reference fixtures. Tune and accept the default here. Stop if the physical-convergence gate is unresolved.
3. Versioned schemas, preflight, result validators, storage/worker boundaries, HTTP/MCP, and preview/apply behavior. No 2D fit. Pass all old and new contract tests.
4. Contextual UI and true geometry preview. Test legacy load/save, new 2D default, x/y edits, layer selection/reorder, material swaps, dimensions/periods, azimuth, zero/full widths, running-job edits, stale results, failed jobs, repeated run/cancel, refresh and result restoration, mobile layout, and keyboard flows. Run visual QA against actual app computations.
5. Aggregate local gates, independent numerical review of exact candidate commit, then separately authorized publication. Monitor CI/deployment for the exact published SHA. Backend feasibility or isolated spikes cannot substitute for this application validation.

## 8. Isolated spike results and reproducibility

All probe sources and evidence are in `/tmp/rcwa-true2d-spike/`, outside the checkout. These are exploratory prototypes, not production code. Python was `/workspace/shared/rcwa-project/.venv/bin/python`, with `OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1`. S4 linked the already-built official pinned static library; the S4 tracked source was not edited.

- `laurent-control.json`: 4 scenarios, both inputs, H3; maximum total/every-order S4 discrepancy 8.03e-14 for the same-formulation diagnostic. Normal and oblique pillars, three-layer true-2D stack, and lossy/metal-like output port are included.
- `cross-control.json`: independent S4 uniform-port Hx/Hy projection versus all four meent outgoing s/p power components; maximum 8.85e-14 over normal, oblique, and lossy-port three-layer cases. S4 component sums agree with its own order totals within 2.3e-16.
- `reductions-resources.json`: 12 1D-reduction scenarios / 72 polarization-wavelength samples, angles 0/31/67, Hy=0/3, transparent and metal-like substrates, including lower-layer absorption. Maximum difference from the current validated 1D application was 3.42e-14.
- `per-order-refinement.json`: complete true-2D inverse-rule versus default-S4 per-order arrays and signed residuals at H=1,3,5,7,9, for Px460/Py420, lambda632.8, theta20/phi25, and a three-layer pillar/spacer/pillar stack. Maximum discrepancy over both polarizations and all orders: 0.09372, 0.03820, 0.02373, 0.01720, 0.01351. This clearly does **not** establish converged independent agreement. Meent total R changed only about 4.6e-5 from H7 to H9, illustrating why totals alone are insufficient.
- The three-layer inverse-rule x/y-transpose maximum component discrepancy decreased from 4.32e-4 at H3 to 1.75e-4 at H5 and 7.70e-5 at H7. Treat this as an observed finite-basis factorization risk, not a certified universal bound.
- `reductions-resources.json`: 8 distinct finite layers, H5, 41 wavelengths, both inputs took 52.96 s, process peak RSS 88,760 KiB (~86.7 MiB). A prior H9 sequence reached 324,244 KiB (~316.6 MiB). These were local observations with some concurrent test activity, not deployment worst-case guarantees.
- `default-refinement.json`: the proposed nanohole default, all 21 wavelengths, H3/H5/H7, with per-order powers. Total solve times were about 0.98/8.60/47.20 s. H5 R ranged 0.00438–0.66988 for s and 0.02032–0.53137 for p; maximum H5→H7 power change was 0.00756968. Independent converged-S4 acceptance has not been attempted for this candidate.
- A no-finite-layer S4 driver control initially produced invalid bare-interface totals; retaining an explicit zero-thickness neutral film, as ordinary project fixtures do, restored Fresnel agreement to <=6.7e-16. Do not include the initial invalid fixture in a claimed pass. The production all-zero solve correctly skips finite-layer eigenproblems.

Installed meent source checksums:

- `transfer_method.py`: b9289812e56d46cd700026d4a1430ad12bbb29cd71caf0c574dd6f690b683213
- `convolution_matrix.py`: 6de8aca0a3323a3d5bf5209905ecd22c0cf73f8e5046a3c16394cd6f16763bfb
- `fourier_analysis.py`: 5d61002014c4dbe90b9dc1debe33cd1408afa89e8cdadd01447f0a82a927993f
- `_base.py`: 59993d4d95c8fd03badc8fb0351ef64840a1c7ca84e09cb1038ee03e351ccfee

A reproducibility gate should freeze installed wheel/source hashes as well as the distribution version, because public docs use some historical parameter names. In installed code, the relevant names are `fto`, `n_top`, `n_bot`, and `fourier_type`; do not copy obsolete documentation keyword examples blindly.

## Primary sources

- [Official meent program sequence](https://meent.readthedocs.io/en/latest/sequence/seq.html): x/y Fourier orders, rectangular periods, finite layer ordering, vector/raster geometry, and polarization definitions. Installed source above is authoritative for the exact pinned implementation.
- [Official meent repository](https://github.com/kc-ml2/meent): source provenance.
- [Official meent lossy-port issue #100](https://github.com/kc-ml2/meent/issues/100): upstream sign-convention issue; the adapter design here is based on independently inspected code and the numerical controls, not merely the issue's proposed remedy.
- [Official S4 Python API](https://web.stanford.edu/group/fan/S4/python_api.html): rectangle geometry, basis inspection, plane-wave polarization, per-order Poynting flux, amplitudes, and solver options.
- [Official S4 tutorial](https://web.stanford.edu/group/fan/S4/tutorial.html): multiple Fourier formulations and their convergence controls.
- [Official S4 repository](https://github.com/victorliu/S4): pinned source provenance. Local `S4/fmm/fmm_closed.cpp` explicitly uses its 1D inverse-rule special case only for a one-dimensional lattice; its default 2D case differs from meent's sequential directional inverse-rule formulation.
