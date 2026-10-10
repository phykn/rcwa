# Version 1 physical contract

This is a numerical RCWA prototype for an infinite, one-dimensional rectangular grating. The default optical constants are synthetic examples. They are not calibrated silicon, silica, or process-specific material data.

## Supported sample and illumination

- One finite physical layer, also one computational slab. The ordered `layers` array is extensible, but this version rejects counts other than one.
- Periodic along x, invariant along y, with a centered rectangular ridge. Its full width is `cd_nm`; interfaces are at `(period-CD)/2` and `(period+CD)/2`. CD=0 and CD=period are explicit homogeneous limits.
- Ambient above z=0; the layer extends in +z to its thickness; the substrate starts there and is semi-infinite. There is no backside reflection or finite-wafer transmission model.
- Isotropic, local, linear, passive, nonmagnetic materials. The ambient must be transparent. The ridge, background, and substrate may absorb.
- One coherent plane wave at a time. Incidence lies in the x-z plane; incidence angle is measured from the surface normal. s has E along y; p has H along y. `both` evaluates these separately; it is not coherent polarization mixing or an unpolarized sum.
- No conical illumination, 2D patterns, trapezoids, roughness, anisotropy, finite-NA integration, depolarization, or multiple finite layers.

The input resource limits are 200–2500 nm vacuum wavelengths (at most 81 strictly increasing samples), 0–75° incidence, period 20–5000 nm, thickness 0–2000 nm, and harmonics 1–20. These are resource/scope limits, not a claim that every parameter combination has converged or been verified. The finite tests in `validation-physics.md` describe the numerical evidence. Exact sampled Rayleigh cutoffs are rejected, and near-cutoff samples are flagged. All propagating channels of lossless ports must fit inside the retained basis. Absorbing-port high-order flux instead needs harmonic refinement.

## Materials and signs

The public convention is time dependence exp(-iωt), refractive index N=n+ik with k≥0, and permittivity ε=N². n is constrained to (0,10] and k to [0,10]. Material values may be constant or tabulated. Tables contain increasing vacuum wavelengths in nm; n and k are linearly interpolated separately, with no extrapolation. `source` is preserved in the project; entering a provenance label does not authenticate the values.

The pinned meent 0.13.2 NumPy finite-layer calculation uses the conjugate convention internally. The adapter supplies N* to its continuous Fourier matrices. All computations use complex128.

### Explicit absorbing-port correction

The upstream `transfer_1d_1` conjugates its square-root longitudinal wavenumber, while its TM boundary admittance divides by the unconjugated supplied index squared. Passing one complex substrate index unchanged into that interface does not consistently implement the convention used here.

The adapter therefore initializes the homogeneous port explicitly:

- kz = conjugate(sqrt(N² − kx²)), choosing an outgoing/decaying branch in the internal exp(+iωt) convention
- s boundary admittance = kz
- p boundary admittance = kz / conjugate(N)²

It then uses the unchanged meent `transfer_1d_2`, `transfer_1d_3`, and `transfer_1d_4` for the eigenproblem, stable layer recursion, and power conversion, passing the conjugated substrate index consistently. Zero thickness skips the layer eigenproblem. No upstream package is modified. The adapter correction is covered by independent analytic absorbing-film/interface tests and an independent S4 comparison. This narrow correction does not establish correctness of arbitrary upstream conical/2D or phase outputs.

## Geometry and Fourier basis

The exact rectangle segment boundaries are integrated by meent's continuous Fourier coefficient routine. This is vector geometry, not raster sampling, and there is no effective-medium replacement. Inverse-rule Fourier factorization is used for the discontinuous normal field. `harmonics=h` means all x orders m=−h,…,+h, with y order zero and basis size 2h+1. The recursion is meent's TMM formulation, not a claim that the upstream SMM path is enabled.

No loss, pseudoinverse, or angular perturbation is added for stabilization. Invalid/nonfinite results, significantly negative power, or failed passive flux checks raise a solver error; output is never clipped into a plausible curve. Numerical flux tolerance is 1e-6 and does not certify spectral accuracy.

## Meaning of outputs

For each requested polarization and wavelength:

- `R`, `T`: sums of retained reflected/transmitted normal powers, normalized by incident normal Poynting flux
- `R_specular`, `T_specular`: zeroth-order values only
- `orders`: actual m, kx/k0, R/T power, and port classification
- `A_balance`: 1−R−T, the finite-layer flux deficit; it is not an independently integrated absorption observable

R is evaluated at z=0 and T at z=thickness. For an absorbing substrate, T is flux entering its front face, not power emerging from its backside. Lossy substrate orders can have nonzero entrance-plane flux at large |kx|; `transmission_propagating` is null and `transmission_class` is `absorbing_half_space`. For a transparent substrate the usual propagating/evanescent classification is reported. Absorption inside the semi-infinite substrate is not included in `A_balance`.

Only power observables are exported. Complex amplitudes, Jones matrices, ellipsometric Psi/Delta, and their phase-reference conventions are not promised. Each result identifies engine/version, retained basis, conventions, elapsed time, limitations, and whether convergence was checked. A normal forward call does not automatically establish convergence.

## Synthetic fitting

`fit_cd(project, {target_cd_nm, lower_cd_nm, upper_cd_nm})` generates a synthetic target and fits CD only, holding every other property fixed. The residual is equal-weight specular R and T for the selected polarizations. Three bounded starts and finite-difference least squares are used; a flat response is rejected. Fitting is limited to 5–41 wavelengths and at most 12 harmonics. One additional h+4 evaluation reports a refinement discrepancy, not a convergence certificate.

The target and fit share the same engine and discretization. This is deliberately labeled an inverse-crime demonstration. A recovered number proves neither uniqueness nor measurement accuracy. No measurement import, noise model, uncertainty interval, material fitting, or production metrology qualification is implemented.
