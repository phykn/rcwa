# Versioned optical-stack physical contract

This is a numerical RCWA prototype for infinite periodic optical stacks. Explicit schema 1.2 supports centered circular holes, rectangular two-dimensional patterns, one-dimensional ridges and uniform films. The legacy 1.0/1.1 contracts below remain unchanged. The default optical constants are synthetic examples. They are not calibrated silicon, silica, or process-specific material data.

## Legacy 1.0/1.1 sample and illumination

- Input schema `1.0` retains exactly one finite rectangular layer and its original defaults and normalized serialization. Explicit schema `1.1` supports 1–8 finite layers in physical **top-to-bottom** order, sharing one `period_nm`. The legacy constructor default remains schema `1.0`; merely reading or normalizing it does not upgrade it. The browser’s ordinary example is explicit schema `1.2`.
- Each nonzero-thickness layer is one computational slab. Zero-thickness layers remain in the project but are omitted from Fourier compilation and layer recursion. If all layers have zero thickness, the solve is the ambient/substrate interface.
- Periodic along x, invariant along y, with a centered rectangular ridge. Its full width is `cd_nm`; interfaces are at `(period-CD)/2` and `(period+CD)/2`. CD=0 and CD=period are explicit homogeneous limits.
- A `rectangle_1d` layer retains the original name, thickness, CD, ridge material, and background fields. A `homogeneous` layer has only the geometry tag, name, thickness, and material; CD/background fields are rejected. There are no persistent layer IDs, lateral offsets, or independent per-layer periods.
- Ambient above z=0; successive finite layers extend in +z; the substrate starts at the **sum of all layer thicknesses** and is semi-infinite. There is no backside reflection or finite-wafer transmission model.
- Isotropic, local, linear, passive, nonmagnetic materials. The ambient must be transparent. The ridge, background, and substrate may absorb.
- One coherent plane wave at a time. Incidence lies in the x-z plane; incidence angle is measured from the surface normal. s has E along y; p has H along y. `both` evaluates these separately; it is not coherent polarization mixing or an unpolarized sum.
- No conical illumination, 2D patterns, trapezoids, roughness, anisotropy, finite-NA integration, depolarization, or phase observables.

The input resource limits are 200–2500 nm vacuum wavelengths (at most 81 strictly increasing samples), 0–75° incidence, period 20–5000 nm, thickness 0–2000 nm per finite layer (at most 16000 nm in total), and harmonics 1–20. These are resource/scope limits, not a claim that every parameter combination has converged or been verified. The finite tests in `validation-physics.md` and `multilayer-physics.md` describe the numerical evidence. Exact sampled Rayleigh cutoffs are rejected, and near-cutoff samples are flagged. Every order inside the larger of the ambient index and the substrate's real index must fit inside the retained basis. This includes absorbing substrates: a small k does not stop nearly propagating substrate orders from carrying flux.

## Explicit 1.2 two-dimensional stacks

Schema 1.2 has shared X/Y periods and separate Hx/Hy Fourier half-widths. Its basis contains every `(m,n)` pair, ordered with m varying fastest. Incidence includes azimuth, and outgoing s/p channel powers are resolved in each order’s local basis. Public limits are eight layers, 31 wavelengths and Hx/Hy 1–5. Admissibility and passive flux balance do not establish convergence.

Adapter 1.4.0 builds the x and y permittivity operators with the same directional rule: inverse rule across the field component's own direction first, then Laurent along the other. Pinned meent applies the two steps in opposite orders for x and y, which breaks x/y symmetry on genuinely 2D cells. Results from adapters 1.2.0 and 1.3.0 remain readable as historical results.

A `circular_hole_2d` layer has `diameter_nm`, `material` (the hole fill), `background` (the host), and its own `thickness_nm`. The centered circular boundary is repeated along both X and Y. Diameter must be between zero and the smaller period. Zero diameter leaves the host. At diameter equal to the smaller period, corner host regions still remain; this is never a full-cell homogeneous limit. Holes extend through their own layer only. A uniform intervening layer remains a film. Zero thickness contributes no finite volume.

The circular solver uses a deterministic, explicitly reported spatial approximation to the circular boundary, separate from Fourier truncation. Refining the spatial approximation is a different check from increasing Hx/Hy. Independent S4 checks use S4’s actual circle primitive. The circular example has its own input-bound numerical evidence; the earlier rectangular evidence remains historical and cannot certify the circular path. No ordinary call automatically establishes convergence. See [the circular-hole example](ui/circular-hole-example.md).

## Materials and signs

The public convention is time dependence exp(-iωt), refractive index N=n+ik with k≥0, and permittivity ε=N². n is constrained to (0,10] and k to [0,10]. Material values may be constant or tabulated. Tables contain increasing vacuum wavelengths in nm; n and k are linearly interpolated separately, with no extrapolation. Coverage validation checks every declared material table, including lower layers, zero-thickness layers, and unused material regions in CD=0/full rectangles. Errors identify the layer index and material field. `source` is preserved in the project; entering a provenance label does not authenticate the values.

The pinned meent 0.13.2 NumPy finite-layer calculation uses the conjugate convention internally. The adapter supplies N* to its continuous Fourier matrices. All computations use complex128.

### Explicit absorbing-port correction

The upstream `transfer_1d_1` conjugates its square-root longitudinal wavenumber, while its TM boundary admittance divides by the unconjugated supplied index squared. Passing one complex substrate index unchanged into that interface does not consistently implement the convention used here.

The adapter therefore initializes the homogeneous port explicitly:

- kz = conjugate(sqrt(N² − kx²)), choosing an outgoing/decaying branch in the internal exp(+iωt) convention
- s boundary admittance = kz
- p boundary admittance = kz / conjugate(N)²

It then uses the unchanged meent `transfer_1d_2`, `transfer_1d_3`, and `transfer_1d_4` for the eigenproblem, stable layer recursion, and power conversion, passing the conjugated substrate index consistently. The substrate boundary is initialized once. Nonzero layers recurse in reverse physical order, from the layer next to the substrate back to the incident face. Zero thickness skips Fourier compilation and the layer eigenproblem. No upstream package is modified. The adapter correction is covered by independent analytic absorbing-film/interface tests and an independent S4 comparison. This narrow correction does not establish correctness of arbitrary upstream conical/2D or phase outputs.

## Geometry and Fourier basis

The exact rectangle segment boundaries are integrated by meent's continuous Fourier coefficient routine. This is vector geometry, not raster sampling, and there is no effective-medium replacement. Inverse-rule Fourier factorization is used for the discontinuous normal field. `harmonics=h` means all x orders m=−h,…,+h, with y order zero and basis size 2h+1. The recursion is meent's TMM formulation, not a claim that the upstream SMM path is enabled.

No loss, pseudoinverse, or angular perturbation is added for stabilization. Invalid/nonfinite results, significantly negative power, or failed passive flux checks raise a solver error; output is never clipped into a plausible curve. Numerical flux tolerance is 1e-6 and does not certify spectral accuracy.

An exact internal modal cutoff can make the pinned modal inverse singular even when both external ports are away from Rayleigh cutoffs. This is an explicit numerical failure, with no fallback spectrum or angle perturbation. For example, a homogeneous n=1.5 layer with period 400 nm at normal incidence and wavelength 600 nm has an internal grazing order. Tests check the exact failure and independently verify nearby indices on both sides. Passing preflight therefore establishes admissibility, not numerical success.

## Meaning of outputs

For each requested polarization and wavelength:

- `R`, `T`: sums of retained reflected/transmitted normal powers, normalized by incident normal Poynting flux
- `R_specular`, `T_specular`: zeroth-order values only
- `orders`: actual m, kx/k0, R/T power, and port classification
- `A_balance`: 1−R−T, the finite-stack flux deficit; it is not an independently integrated absorption observable

R is evaluated at z=0 and T at z=`total_thickness_nm`. For an absorbing substrate, T is flux entering its front face, not power emerging from its backside. Lossy substrate orders can have nonzero entrance-plane flux at large |kx|; `transmission_propagating` is null and `transmission_class` is `absorbing_half_space`. For a transparent substrate the usual propagating/evanescent classification is reported. Absorption inside the semi-infinite substrate is not included in `A_balance`. Lossless-stack flux checks inspect only positive-volume finite material regions: zero-thickness layers, the absent ridge at CD=0, and the absent background at full CD cannot make a stack lossy. This accounting is wavelength-specific for dispersive materials. A lossless finite stack still has R+T=1 at the front of an absorbing substrate.

New forward results use schema `1.1` and adapter `1.1.0`, including `layer_count`, `active_slab_count`, `total_thickness_nm`, and `stack_order="top_to_bottom"`. These values are bound to the accepted project at the worker boundary. Historical schema `1.0`/adapter `1.0.0` results have a separate read-only contract; historical snapshots need no fabricated stack fields. Current workers must return the current result contract.

Only power observables are exported. Complex amplitudes, Jones matrices, ellipsometric Psi/Delta, and their phase-reference conventions are not promised. Each result identifies engine/version, retained basis, conventions, elapsed time, limitations, and whether convergence was checked. A normal forward call does not automatically establish convergence.

## Synthetic fitting

`fit_cd(project, {target_cd_nm, lower_cd_nm, upper_cd_nm})` accepts exactly one `rectangle_1d` layer in either supported input schema. Multiple layers and homogeneous layers are rejected before any target computation. It generates a synthetic target and fits CD only, holding every other property fixed. The residual is equal-weight specular R and T for the selected polarizations. Three bounded starts and finite-difference least squares are used; a flat response is rejected. Fitting is limited to 5–41 wavelengths and at most 12 harmonics. One additional h+4 evaluation reports a refinement discrepancy, not a convergence certificate.

The target and fit share the same engine and discretization. This is deliberately labeled an inverse-crime demonstration. A recovered number proves neither uniqueness nor measurement accuracy. No measurement import, noise model, uncertainty interval, material fitting, or production metrology qualification is implemented.
