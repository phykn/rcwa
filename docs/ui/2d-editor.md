# 2D editor and exact result identity

The ordinary editor opens the accepted synthetic three-layer 2D dielectric
example. Choose a layer, edit its Width X/Y or Thickness, then run the local
solver. Shared Pitch X/Y applies to the whole stack and never silently resizes a
layer. A value smaller than an existing feature is rejected while the last valid
value remains. A uniform film has no width control; a 1D ridge in a 1.2 stack is
uniform along Y. Layer settings retain names, materials, type and ordering.

The centered rectangular pattern repeats along both X and Y. The 3×3 scene uses
one common physical scale. Cutaway hides a corner for inspection without moving
layers or changing any input. Use View → Full stack to restore it. Colors identify
layers, pale gray denotes background material, and the substrate's displayed
depth is schematic. A low-index inclusion is still material, not automatically
air. The image is an inspection view, not a precision measurement surface.

## Stored example versus a new calculation

Both local and static builds initially show the complete stored H5 result for
exact input hash
`eeb26da3484602221944f1784b4b93ce2ed76f89b61e95d34bb68730be7bddc7`.
The [input-specific offline evidence](../true-2d/default-acceptance.txt) applies to
those exact synthetic inputs and sampled wavelengths. It does not certify edits,
continuous spectra, experimental accuracy, or actual HBM structures. Ordinary
result metadata keeps `convergence_checked=false`.

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
  the retained original 1D fixture; the ordinary URL remains 2D.
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

`build_2d_ui_reference.py --check` verifies fixture hashes and the unchanged
public/shared Python binder without solving. `generate_frontend_2d_conformance.py
--check` verifies deterministic normalization/hash/binder vectors without solving.
The production 2D browser suite supplements the retained 1D suites. CI mobile
contexts and accessibility-tree evidence do not claim real-phone onscreen-keyboard
or spoken screen-reader validation.
