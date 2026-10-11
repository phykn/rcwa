# Interactive 2D first-use prototype

This test-only page is available from the development server at
`/prototype-2d.html`. It is a bounded layout/interaction prototype, not the
production editor or an additional solver. The normal application remains intact.

The page renders the exact accepted synthetic three-layer 2D fixture and loads
its complete stored H5 spectrum. `scripts/build_2d_ui_reference.py --check` checks
the immutable fixture hashes, normalized input hash and public/shared backend
result binding. It performs no new calculation. Optical constants are synthetic;
this is not an HBM device, measurement or edited-input accuracy guarantee.

Three cards expose selected-layer Width X/Y, Thickness, and shared Pitch X/Y.
A labeled view-only cutaway exposes actual material/background regions; it never
moves layers or changes solver inputs. Region-volume and clipping tests precede
pixel review. The primary action navigates to the precomputed spectrum, whose
stale status remains explicit after edits.

The prototype browser suite captures mobile360/390 and desktop1440 viewports,
checks initial action/chip visibility, the bottom-layer Y-only edit, shared Y
bounds, invalid dismissal, focus return, Undo/Redo and zero API traffic. It is
separate from all existing production browser suites. Screenshot retries remain
recorded. Goal-only independent discoverability review is a separate gate.

Production import/canonical identity, live job/snapshot lifecycle, complete layer
settings/light controls and legacy integration are not represented as finished
by this prototype. They require the next implementation and independent gates.
Real-phone onscreen keyboards and spoken screen-reader behavior are unverified.
