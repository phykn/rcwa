# Actual independent S4 reference check

## Result and scope

The current adapter `1.1.0` was compared against **official upstream S4** on 2026-10-10. It passed **40 scenarios and 276 polarization/wavelength samples**, checking total reflected/transmitted power and **every retained diffraction order**. The largest absolute cross-engine difference was **5.7477 × 10⁻¹³**; the regression threshold remains **1 × 10⁻⁹** in incident-normalized power.

The default reference script retains all 19 original single-layer cases and adds 21 stack cases. These cover 2–8 layers, mixed film/pattern orderings, distinct rectangular CDs, lower-layer loss and independent n/k tables, absorbing and metal-like substrates, multiple propagating orders, zero-thickness insertions and all-zero stacks, degenerate CD limits, splitting and reversal, and separate H=3/7/11/15/19 refinement evidence. See [multilayer numerical evidence](multilayer-physics.md) and [complete current reference evidence](multilayer-reference-results.json.gz). The single-layer table below records the original regression cases, all of which remain in the current run.

This is evidence that the meent adapter and S4 agree for the tested, matched finite Fourier bases. It is **not** a guarantee of Fourier convergence, validation against an instrument, a CD-accuracy claim, or validation of all allowed inputs. S4 and meent independently implement the same Fourier-modal method, so some shared methodological limitations remain.

For perspective, the ordinary lossless rectangular sample's maximum change in total R/T across these four wavelengths was:

| Basis change | Maximum absolute change |
|---|---:|
| H = 3 → 7 | 0.00334889 |
| H = 7 → 11 | 0.000444668 |
| H = 11 → 15 | 0.000106145 |

Thus the impressive cross-engine agreement must never be displayed as the physical accuracy of a default H = 7 solve. The application's per-project convergence check remains necessary.

## Tested implementations and build

- meent **0.13.2**, NumPy **2.5.3**, SciPy **1.17.1**, Python **3.12.14**.
- Official [victorliu/S4](https://github.com/victorliu/S4), pinned commit [7fd00a231610bff51f5c7de5f723e3956eab7453](https://github.com/victorliu/S4/commit/7fd00a231610bff51f5c7de5f723e3956eab7453). The script requires a clean tracked source tree at that commit.
- Linux x86-64, glibc 2.41, GCC/G++ 14.2.0. Existing `liblapack.so.3` and `libblas.so.3` runtime libraries are linked explicitly; no operating-system package installation was needed.
- `make -B -j2 build/libS4.a` builds the upstream static library. A small original C++ driver calls its C API; pinned internal access is used for by-order flux and basis inspection. S4's Python/Lua wrappers are not needed.
- The existing upstream make recipe compiles its bundled RNP eigensolver and KissFFT, and links system BLAS/LAPACK needed by other numerical routines. The build produces legacy compiler warnings; success does not establish that upstream is warning-free or fully maintained. The complete build log is retained next to the test executable.
- The initially inspected Python-3 fork at `phoebe-p/S4` needs additional Boost headers/libraries absent in this environment. Its build was not attempted and it is not the numerical reference reported here.

The reference driver and S4 source/binary are separate from the application runtime. No S4 source or compiled binary is bundled in the project. S4's GPL-2.0-or-later terms must be reviewed before distributing an S4-containing product; this optional local test does not establish a distribution or licensing conclusion.

## Exact physical and numerical matching

The periodic axis is x, the invariant axis is y, and incidence is in the x-z plane. Both engines receive the same vacuum wavelength, common period, ordered physical layers, nanometer lengths, rectangle CDs, ambient/substrate index, and material tables. Each stack is passed top-to-bottom to the S4 layer API; the application independently recurses bottom-to-top from its substrate load. S4 receives zero-thickness layers explicitly while the application skips them.

- s polarization means electric field along y; p means magnetic field along y.
- Public materials use `N = n + i k` and `exp(-i ωt)`. S4 receives `epsilon = N²`; the adapter maps to meent's conjugated finite-layer convention and explicit passive outgoing port admittances.
- Geometry is an exact-boundary rectangle centered at x = period/2. It is not rasterized. CD = 0, CD = period, and zero thickness are tested as limits.
- meent retains integer orders `[-H, ..., 0, ..., H]`. S4 is explicitly given `[0, -H, ..., -1, 1, ..., H]`; the driver verifies the same reciprocal-vector **set**, rather than equating an ambiguous `NumG` value to a harmonic order. Basis size is exactly `2H + 1`.
- Both use analytic continuous Fourier integrals and the appropriate 1D inverse Fourier-factorization rule. S4's closed-form 1D implementation supplies that rule without a sampled polarization basis. No Lanczos, subpixel smoothing, artificial damping, angular perturbation, or pseudoinverse is enabled.
- S4 uses its scattering-matrix algorithm. The application uses the pinned meent layer eigensolver and recursive transfer formulation, with an explicit complex-port initialization correction.
- Power is divided by each S4 run's actual incident normal flux. R uses minus the backward top-layer flux; T uses the forward substrate flux at the entrance plane.
- In an absorbing semi-infinite substrate, T is entrance-plane flux, including attenuating orders. It is not power transmitted through a substrate backside. Ordinary binary propagating/evanescent classification does not apply to complex substrate modes.
- Dispersion is independently linearly interpolated in n and k in the reference script; it does not call the application's interpolation helper.

## Scenarios and measured maximum discrepancies

Ordinary cases use period 400 nm, CD 180 nm, height 160 nm, ridge n = 2.1, background/ambient n = 1, substrate n = 1.5, angle 15°, H = 7, and wavelengths 450/550/650/850 nm unless a row says otherwise. Every row checks both s and p.

| Scenario | Overrides | Maximum absolute R/T/order difference |
|---|---|---:|
| Lossless rectangle, H3 | H = 3 | 1.32e-14 |
| Lossless rectangle, H7 | H = 7 | 4.55e-14 |
| Lossless rectangle, H11 | H = 11 | 6.27e-14 |
| Lossless rectangle, H15 | H = 15 | 8.85e-14 |
| Normal incidence | angle = 0° | 6.49e-14 |
| Oblique incidence | angle = 55°, H = 11 | 2.02e-13 |
| High-contrast lossy ridge | N = 3.8 + 0.02i, CD = 167 nm, height = 240 nm, H = 11 | 7.59e-14 |
| Lossy ridge | ridge k = 0.1 | 4.83e-15 |
| Lossy background | ridge k = 0.03, background k = 0.02 | 1.01e-14 |
| Uniform lossy film | CD = 400 nm, ridge k = 0.1 | 7.77e-16 |
| Empty ridge | CD = 0 | 7.77e-16 |
| Zero thickness | height = 0 | 3.23e-14 |
| Many propagating orders | period = 800 nm, CD = 370 nm, angle = 30°, H = 11; 450/550/750 nm | 1.50e-14 |
| Immersion ambient | ambient n = 1.33 | 1.48e-13 |
| Absorbing substrate | N = 3.5 + 0.1i; 450/550/632.8/850 nm | 8.77e-14 |
| Absorbing substrate and ridge | substrate N = 3.8 + 0.5i, ridge k = 0.1, angle = 55°, H = 11 | 2.40e-14 |
| Strongly absorbing substrate | substrate N = 0.8 + 2i, ridge k = 0.05, angle = 67°, H = 11 | 4.72e-14 |
| Metal-like substrate | substrate N = 0.25 + 5i, angle = 31°, H = 15 | 5.53e-14 |
| Independent tabulated interpolation | ridge n = 2.4/2.1/1.9 and k = 0.08/0.03/0 at 400/600/900 nm | 2.09e-14 |

These optical constants are deliberately synthetic. The names are scenario descriptions, not assertions of measured silicon, oxide, or metal optical constants.

### Why the port correction matters

Inspection of meent 0.13.2 found that its stock port initializer conjugates `sqrt(N² - kx²)` but uses unconjugated `N²` in the p-polarized admittance. The adapter initializes consistent passive-port quantities explicitly, then retains meent's eigensolver, layer recursion, and flux conversion. That correction is checked independently by homogeneous-film analytical tests and the patterned lossy-substrate S4 cases above. It should not be silently removed during an upstream-version upgrade.

For the `Nsub = 3.5 + 0.1i`, 632.8 nm case, S4 gives:

| Polarization | Total R | Total T | Specular T |
|---|---:|---:|---:|
| s | 0.24483576275919983 | 0.75516423724079884 | 0.41477461582729752 |
| p | 0.08146265221532863 | 0.91853734778467322 | 0.56774869791225124 |

All finite-layer materials in that case are lossless, so R + T = 1 at the substrate front face despite absorption deeper in the substrate. Some high-|m| substrate orders also carry small entrance-plane flux and must not be thrown away merely because they would be evanescent in a lossless medium.

## Reproduce

Start with the project's installed Python development dependencies and a system with Git, Make, G++, and BLAS/LAPACK runtime libraries. The command below explicitly fetches official upstream source. The reference script itself never downloads or installs dependencies.

```sh
git clone https://github.com/victorliu/S4.git /tmp/rcwa-s4-upstream
git -C /tmp/rcwa-s4-upstream checkout 7fd00a231610bff51f5c7de5f723e3956eab7453
mkdir -p artifacts
.venv/bin/python scripts/reference_check.py \
  --s4-source /tmp/rcwa-s4-upstream \
  --output artifacts/independent-reference.json
```

The original single-layer-only run completed at `2026-10-10T05:48:18.036970+00:00` with adapter SHA-256 `e4ed30dddcab372499f2ad84e23fa92a007163adbce280eb6757e3b2a69eedae`. This includes the final zero-thickness bypass.

The JSON includes every model input, all compared per-order powers, total powers, tolerance, status, package versions, compiler/link command, source commit, timestamp, and hashes of the adapter, schema, reference script, and S4 executable. A failed build or solve raises an error; a discrepancy above the threshold returns a nonzero exit status. There is no mock spectrum or pass-by-fallback path.

The original build and 150 single-layer numerical comparisons took about 15 seconds on the test machine. This is an observed validation runtime, not a production performance promise. The original single-layer evidence remains in [compressed legacy reference evidence](independent-reference-results.json.gz); current stack evidence is saved separately in [compressed multilayer reference evidence](multilayer-reference-results.json.gz). Reproduce into `artifacts/` to retain machine-specific evidence. Run it locally when the numerical core changes; it is not substituted for the ordinary backend tests.

## Remaining gates

- Establish sample-specific Fourier convergence against measurement-noise targets.
- Validate gradients/sensitivities and blind synthetic recovery using an independent or higher-accuracy truth source.
- Add 2D structures, nonrectangular profiles, conical incidence, phase/Jones/Mueller observables, and anisotropy only with new independent tests. The present bounded 1D multilayer extension does not validate those features.
- Validate material provenance, instrument response, and held-out measured structures before metrology claims.
- Re-run the analytical tests and this cross-engine test after any engine, port convention, or geometry-compiler change.

To inspect the complete JSON evidence:

```sh
gzip -dc docs/independent-reference-results.json.gz > /tmp/rcwa-reference-results.json
```
