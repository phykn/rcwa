# Circular-hole example

The ordinary browser example is a synthetic three-layer periodic stack. Each
patterned layer has a centered circular hole with its own diameter and depth.
Different diameters create shoulders at layer interfaces; adding a uniform layer
would interrupt the hole through that layer. Dimensions are in nm. Every
material value is synthetic; none is measured HBM or process data.

## Stored inputs

- Shared pitch: X 150 nm, Y 140 nm
- Top layer: 65 nm hole diameter, 90 nm depth, synthetic host n=1.45
- Middle layer: 80 nm hole diameter, 120 nm depth, synthetic host n=1.55
- Lower layer: 95 nm hole diameter, 130 nm depth, synthetic host n=1.50
- Hole fill and ambient: air n=1; substrate: synthetic n=1.5; all k=0
- Illumination: 20° incidence, 25° azimuth, both s and p
- Stored wavelengths: 450–850 nm in 20 nm steps; Hx=Hy=5

The exact normalized input hash is
`e625443a782c0d57f5d8a5597d5410812bf8fb541249303ace49c051c66a6931`.
The [packaging manifest](../../frontend/src/fixtures/reference-circular-manifest.json)
binds that input to the complete stored result and public bundle.

## Editing

Choose a layer in the scene or layer list. A circular layer exposes one Diameter
control and its own Thickness. Shared Pitch X/Y controls the periodic unit cell
for all layers. Diameter must fit both pitches; reducing a pitch below an
existing diameter is rejected rather than resizing the hole. Uniform layers
have no diameter control. Rectangular imports keep their Width X/Y controls.

Layer settings names the two material roles explicitly:

- Hole material is the material filling the circular region. Air produces an
  empty-looking hole, but a non-air fill remains real material in the model.
- Host material fills the rest of that layer's unit cell, including the corners
  when the diameter touches a period boundary.

Diameter zero leaves a host film. Zero layer thickness has no finite volume.
The 3×3 shadow-free scene repeats the same canonical input in both horizontal
axes. Its cutaway is an inspection aid only; Full stack restores the view without
changing any input. The substrate's displayed depth is schematic.

## Calculation and reference

Pages is a static preview. It displays the complete precomputed result bound to
the exact example input. Editing marks that result stale. Use the local Python
API to calculate edited inputs; the browser never invents a replacement curve.

The `circular_hole_2d` contract keeps a true circular target geometry with a
single `diameter_nm`. The production solver approximates that circular boundary
by 64 centered midpoint strips before Fourier truncation. The strip boundaries
are integrated continuously rather than sampled with an FFT. Metadata records
the fixed strip count, each circle’s exact and approximated area, and a
conservative area-discrepancy bound. That geometry bound is not an optical
error bound. Spatial resolution and Hx/Hy are separate numerical approximations. An accepted example
therefore requires independent checks of both, and an S4 reference using an
actual circular primitive rather than the same staircase.

The [numerical guide](../true-2d/circular-geometry.md) describes the source-bound
checks and reproducible commands. The [full-grid evidence](../true-2d/circular-convergence.json.gz)
retains every tested channel and order. Only the recorded example and tested
wavelengths are covered by that evidence. Ordinary result metadata continues to state that convergence is not
assessed. Edited inputs, continuous spectra between samples, experimental
accuracy, and actual HBM structures do not inherit that evidence.

## Compatibility

Schema 1.2 adds the explicit `circular_hole_2d` layer tag without changing old
rectangular or homogeneous inputs. `material` means hole fill and `background`
means host for this tag. The diameter participates in the canonical input hash
and all project/result binding. A result for another diameter cannot be attached
as a current result.

The explicit `?example=rectangle` URL opens the retained rectangular 2D example;
`?example=1d` opens the retained 1D fixture. Imports are never silently converted.
Historic rectangular references retain their original input, result and source
provenance; they do not certify the circular solver path.
