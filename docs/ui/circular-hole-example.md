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
The [packaging manifest](../../frontend/src/core/fixtures/reference-circular-manifest.json)
binds that input to the complete stored result and public bundle.

## Editing

Choose a layer in the scene or the stack list. A circular layer has one **Hole
diameter** control and its own **Thickness**. The shared **Pitch X/Y** sets the
periodic unit cell for all layers. The diameter must fit both pitches; reducing a
pitch below an existing diameter is rejected rather than resizing the hole.
Uniform layers have no diameter control.

The layer's two materials are named explicitly:

- **Hole fill** is the material inside the circle. Air gives an empty hole, but a
  non-air fill remains real material in the model.
- **Host** fills the rest of the layer's unit cell, including the corners when
  the diameter touches a period boundary.

Diameter zero leaves a host film. Zero layer thickness has no finite volume.
The scene shows a 3×3 block of unit cells, cut away so the holes inside every
layer are visible. The substrate's displayed depth is schematic.

## Calculation and reference

On first load the workbench shows the stored result for this exact input, then
recalculates live after every edit, in the browser (including on Pages) or on a
local server. Edited inputs get their own calculated spectrum; the stored result
is never reused for them.

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
means host for this tag. The diameter participates in the canonical input hash,
so a result for another diameter never matches this input. Historic rectangular
references retain their original input, result and source provenance; they do
not certify the circular solver path.
