# 2D editor and exact result identity

The ordinary editor opens the synthetic three-layer circular-hole 2D
example. Choose a layer, edit its Diameter or Thickness, then run the local
solver. Rectangular layers retain Width X/Y. Shared Pitch X/Y applies to the whole stack and never silently resizes a
layer. A value smaller than an existing feature is rejected while the last valid
value remains. A uniform film has no width control; a 1D ridge in a 1.2 stack is
uniform along Y. Layer settings retain names, materials, type and ordering.

Each physical dimension also has a slider for coarse adjustment. The number
field retains exact values and the full allowed range. Slider endpoints show a
local linear interval: the lower physical bound through the smaller of the upper
physical bound and `ceil(max(200, 2 × value, 2 × minimum) / 100) × 100` nm.
This keeps small features easy to adjust even inside large periods. The interval
stays fixed while the control is open, including drag release; typing outside it
or changing its geometry bounds establishes a new interval without changing the
entered value. Arrow keys adjust by 1 nm, Page Up/Down by 10 nm, and Home/End reach
the displayed endpoints. A drag or held adjustment key creates one undo step.
Closing, losing focus or canceling a touch keeps the last valid value; Undo
reverts that gesture. Editing does not start a calculation or replace a spectrum.

Centered circular holes or rectangular patterns repeat along both X and Y. The 3×3 scene uses
one common physical scale. Cutaway hides a corner for inspection without moving
layers or changing any input. Use View → Full stack to restore it. Colors identify
layers. Circular holes expose the surrounding host and their actual fill
material; rectangular backgrounds remain pale gray. The substrate's displayed
depth is schematic. A low-index inclusion is still material, not automatically
air. The image is an inspection view, not a precision measurement surface.

### When 3D is unavailable

If WebGL cannot start or its context is lost, the schema-1.2 editor displays
two physical SVG projections: one repeat of the **selected layer from above
(X–Y)**, and one repeat of the **stack's center section (X–Z at Y=0)**. Each
projection fits independently, with equal physical scales on its two axes.
Circles stay circular even when X/Y pitches differ. These are orthographic
sections of the current inputs, not a simulated 3D image or a new solver result.

Layer order, host/fill roles and dimensions match the canonical geometry.
Only constant n=1, k=0 material is shown as air; low-index and tabulated material
remains visible. Ambient and substrate are labeled boundaries with no invented
depth. Zero-thickness layers have no finite area; an all-zero stack has
coincident ambient/substrate boundaries. Thin geometry is never enlarged.

Tap a clearly separated section to select its layer, or use the existing layer
chips, including for keyboard selection and thin/zero-thickness layers. The
same dimension and material editors update both projections. Selection changes
no inputs and starts no calculation. The inactive 3D View and Reset controls
are hidden until WebGL recovers. Restoration rebuilds the current edited inputs
without moving focus from an open editor. The retained schema-1.0/1.1 viewer is
unchanged by this fallback.

## Stored example versus a new calculation

Both local and static builds initially show the complete input-bound circular
example result. Its geometry, material semantics and spatial approximation are
explained in [the circular-hole guide](circular-hole-example.md). Numerical
evidence applies only to the recorded synthetic inputs and sampled wavelengths.
It does not certify edits, continuous spectra, experimental accuracy, or actual
HBM structures. Ordinary result metadata keeps `convergence_checked=false`.

The retained rectangular example is available at `?example=rectangle`, with
original input hash
`eeb26da3484602221944f1784b4b93ce2ed76f89b61e95d34bb68730be7bddc7`.
Its [historical input-specific evidence](../true-2d/default-acceptance.txt)
remains separate from the circular example.

Pages makes no API requests and cannot calculate. Editing marks the stored
spectrum as stale. A compatible local server is discovered through its
version-specific capability profile; Run simulation explicitly validates and
submits the captured inputs. Validation, job and result hashes must agree before
a new spectrum is installed. Unsupported, cancelled, failed or malformed responses
preserve the previous result. Fitting and legacy change-proposal formats remain
unsupported for 1.2. The separate [dimension-only proposal format](../agent-api.md#exact-base-2d-dimension-proposals)
supports exact-base review through Import JSON. Angular settings and separate
Hx/Hy remain in existing disclosures.

## Inspect diffraction orders

Open **Diffraction orders** below the spectrum to inspect all retained `(m, n)`
orders at the same exact wavelength sample and incident s/p selection as the
plot. The initially closed view shows R/T as incident-power fractions and the
stored port classifications. A copied display list puts the largest absolute
R/T contributions first, with original retained order breaking ties. Every
small signed contribution, including signed zero, remains unchanged and visible. **Exact values** exposes the
full stored numeric values; **Outgoing local s/p** adds the local reflected and
transmitted port components, distinct from incident polarization. The table is
keyboard-focusable and scrolls within the spectrum panel. When the table region
itself is focused, unmodified Home/End immediately jump to its top/bottom without
moving focus. Arrow/Page keys, modified keys and child controls keep native
behavior. Changing the selected sample, polarization or result resets only table
scroll, without moving focus.

The table always follows the displayed, input-bound result, even while edited
inputs make it stale. It never derives ports from current geometry, filters
orders or starts a calculation. Absorbing-substrate T is interface flux into the
half-space, not backside transmission; ordinary propagating/evanescent labels
do not apply to those transmitted rows. This view supports validated schema-1.2
results only and adds no physical-accuracy or convergence claim.

## Import, history and saving

- `rcwa-change-proposal/1.2` files propose only dimensions on an exact existing
  base. The browser verifies the allowed patch, complete input hashes and diff;
  a stale base cannot Apply. Imported numerical claims are unverified. Reported
  errors conservatively block Apply, while the local server checks numerical
  admissibility when you choose **Run simulation**. Review/Apply do not calculate
  or save to the server. The old spectrum retains its original inputs and the
  selected layer is preserved; Apply is one undo step.

- Input-only schema 1.2 JSON opens **Review imported design** with Current and
  Proposed inputs. **Apply changes** creates one undo step and keeps the displayed
  spectrum bound to its original inputs, visibly stale when appropriate.
  **Cancel** changes nothing. Exact material tables remain in **Full inputs**;
  this review does not calculate, save to the server or check physical accuracy. Identical
  inputs create no edit. New imports or editor/history transitions discard old
  reviews and queued reads.
- Imported schema 1.0/1.1 projects retain their original 1D behavior and identity.
  Nothing is silently migrated or downgraded. The explicit `?example=1d` URL opens
  the retained original 1D fixture; the ordinary URL remains the circular-hole 2D example.
- 1.2 file and API boundaries check raw integer tokens, exact schema defaults,
  Unicode, signed zero, the complete order basis and channel powers. Local
  canonical bytes and hashes are checked against unchanged Python-generated
  conformance vectors. Imported provenance is always unverified.
- Result binding happens before installation. History shares the verified frozen
  result, preserves exact inputs and origins, and does not recompute a spectrum.
  A stale export includes the original `result_project` and every `(m,n)` order.
- Browser file reading is capped at 20 MiB. The local API's whole UTF-8 request
  cap remains 2,000,000 bytes. An oversized full-result save leaves state intact;
  keep an export, save inputs only, or save a completed server job by its ID.
- A server-computed snapshot binds actual job ID, input hash, project/result
  versions, engine and adapter. Origin alone is not a convergence certificate.

`build_circular_ui_reference.py --check` and `build_2d_ui_reference.py --check`
verify each fixture’s hashes and the public/shared Python binder without solving. `generate_frontend_2d_conformance.py
--check` verifies deterministic normalization/hash/binder vectors without solving.
The production 2D browser suite supplements the retained 1D suites. CI mobile
contexts and accessibility-tree evidence do not claim real-phone onscreen-keyboard
or spoken screen-reader validation.


## Edited designs and reload recovery

On the static Pages preview, changing the inputs replaces the example-spectrum
primary action with **Use this design locally**. Its accessible dialog offers
**Export current inputs** as the next action, plus macOS/Linux and Windows
setup commands and the local **Project → Import JSON → Apply changes → Run
simulation** flow.
The export contains current inputs only, never the stale example result. The
unchanged first-open example still links to its precomputed spectrum. All static
editing and recovery remain API-free.

A validated input-only draft is saved in sessionStorage for this browser tab and
origin, up to 512 KiB, after a 300 ms debounce and when the page is hidden or left.
Reload restores those inputs with no result, server provenance or undo history;
the restored message says so. Closing the tab normally clears the draft, though
browser session restore may keep it. Use JSON export for a durable copy or to
move from Pages to localhost. Corrupt/unsupported drafts are ignored, and quota failures and oversized drafts remove the older saved draft when storage
permits, so it is not mistaken for the newest edit. Invalid inputs preserve the
last valid draft. Storage failures show export guidance; if a browser blocks even
removal, the recovery message explicitly identifies inputs as the last saved
valid draft, which can omit later unsaved edits. An
explicit rectangle or 1D route uses its own draft slot and retains its schema.
