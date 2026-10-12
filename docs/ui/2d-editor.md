# 2D editor and exact result identity

The ordinary editor opens the synthetic three-layer circular-hole 2D
example. Choose a layer, edit its Diameter or Thickness, then run the local
solver. Rectangular layers retain Width X/Y. Shared Pitch X/Y applies to the whole stack and never silently resizes a
layer. A value smaller than an existing feature is rejected while the last valid
value remains. A uniform film has no width control; a 1D ridge in a 1.2 stack is
uniform along Y. Layer settings retain names, materials, type and ordering.

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
preserve the previous result. Fitting and change proposals are not supported for
1.2. Angular settings and separate Hx/Hy remain in existing disclosures.

## Import, history and saving

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
setup commands and the local **Project → Import JSON → Run simulation** flow.
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
