# Using the workbench

The workbench does one thing: you build a periodic multilayer, and its
spectrum follows every change. It opens with a three-layer circular-hole
example and its stored spectrum, so there is something to look at before the
engine has started.

## Where calculations run

- **In this browser.** `backend/rcwa_core` and meent run in Python (Pyodide) inside
  Web Workers, one interpreter per worker, up to four. The first visit downloads
  about 25 MB; later visits use the browser cache. The status at the top shows
  progress, then *Engine ready*. The hosted page (GitHub Pages) always calculates
  this way.
- **On a local server.** When the local API answers (`scripts/start_local.py`),
  full calculations go to it automatically: native BLAS, several times faster
  at high orders. Previews still run in the browser.

Both paths run the same `rcwa_core` code. `npm run test:engine` checks the browser
runtime against frozen native results (agreement better than 1e-10).

## Editing

- **Stack** (left) lists the incident medium, the layers from top to bottom and the
  substrate. Swatch heights follow layer thickness; the pattern shows the shape
  (film, lines, blocks, holes). Select a row to edit it; move, duplicate or delete
  layers with the buttons below the list. Up to eight layers.
- **Inspector** (right) edits the selection: shape, thickness, feature size and
  materials, then the pattern pitch and the light (spectral range, incidence θ,
  azimuth φ and polarization: s, p or both).
- Every number has a field for exact values and a slider for quick changes. A
  slider drag or a held arrow key is one undo step. Arrow keys in a field step by
  1, Shift+arrow by 10.
- **Materials** come from a built-in library (Si, GaAs, SiO₂, Si₃N₄, TiO₂, Al₂O₃,
  MgF₂, HfO₂, Ta₂O₅, Au, Ag, Al, Cu, Cr), a constant n and k, or an imported
  table (CSV of wavelength, n, k; nm or µm). Library data comes from the
  refractiveindex.info database (CC0) and is limited to each source's measured
  range and to the solver's bounds (n, k ≤ 10). A material whose data does not
  cover the light's range is flagged; the solver never extrapolates.
- The incident medium must be lossless. The substrate is a half-space; with an
  absorbing substrate, T is the flux entering it.

### Settings chosen for you

- **Fourier orders** follow the geometry. When an edit changes which axes are
  patterned, the orders switch to that kind's default: films ±1, lines only
  (1D) ±5 in x and ±1 in y, any blocks or holes (2D) ±3 on both axes. Edits that
  keep the same kind leave the orders alone, so an opened file keeps the orders
  it asked for.
- **Spectral samples** keep the count of the example or file; changing the range
  respaces the same number of samples.

## Live preview and full calculation

Each edit starts a **preview**: at most ±2 Fourier orders and 13 wavelengths.
When editing pauses (or a drag ends), the **full calculation** runs with the
design's own orders and all wavelengths. Spectra longer than 31 samples are
split into several requests and joined.

The chart shows one set of curves: the full result for the current inputs,
else their preview, else the newest result until the next one arrives (the
status line says which is calculating). A new result morphs the curves into
place over a quarter second instead of redrawing the chart.

## Spectrum

- R, T and A = 1 − R − T against wavelength for the light the design asks for:
  s, p, or unpolarized (the mean of s and p) when polarization is *Both*.
- Click the chart or use the slider below it to inspect one wavelength; the
  values at that wavelength appear on the right, with the data table below.
- **Reflected and transmitted color**: CIE 1931 2° observer (Wyman–Sloan–Shirley
  fit), a 6500 K blackbody standing in for daylight, sRGB output. It needs a
  spectrum covering 400–700 nm; with 450–650 nm it is marked approximate.
- The solver's notes for the result (for example, that convergence was not
  assessed) are listed under the color swatches.

## Files

- **Examples** opens a starting design.
- **Open** reads design files, `{ "project": … }` envelopes, `{ "projects": [...] }`
  lists of chunked projects and bare 1.0–1.2 projects. Older 1D projects are
  converted (period Y = period X, one order in y). A dimension proposal file
  opens a review of its changes before they apply.
- **Export**: design file (.json), spectrum (.csv) and the spectrum chart as SVG
  or PNG (2×).
- Edits are kept as a draft for the browser tab.

## Keyboard

- ⌘Z / Ctrl+Z and Shift+⌘Z: undo and redo outside text fields.
- In the 3D view: drag to rotate, scroll to zoom, click a layer to select it.

## Limits

- Schema 1.2 bounds: 1–8 layers, Fourier orders 1–5 per axis, 20–5000 nm
  pitch, 200–2500 nm light, θ ≤ 75°.
- Results do not certify convergence. The workbench has no sweep, field-map,
  fitting or convergence views; dimension fitting and forward jobs at chosen
  orders remain available through the HTTP API and the MCP adapter (see
  `docs/agent-api.md` and `docs/mcp-tools.md`).
- Browser calculations at ±5 orders take seconds per wavelength; the local
  server is several times faster.
