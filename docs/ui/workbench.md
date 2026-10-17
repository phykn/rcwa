# Using the workbench

The workbench edits periodic multilayers and calculates their optical response
with RCWA. It opens with a three-layer circular-hole example and its stored
spectrum, so there is something to look at before the engine has started.

## Where calculations run

- **In this browser.** `backend/rcwa_core` and meent run in Python (Pyodide) inside
  Web Workers, one interpreter per worker, up to four. The first visit downloads
  about 25 MB; later visits use the browser cache. The status at the top shows
  progress, then *In browser · N workers*.
- **On a local server.** When the local API answers (`scripts/start_local.py`),
  full calculations and fits go to it automatically: native BLAS, several times
  faster at high orders. Previews, sweeps and field maps still run in the browser.
  Settings → Calculation engine overrides the choice.

Both paths run the same `rcwa_core` code. `npm run test:engine` checks the browser
runtime against frozen native results (agreement better than 1e-10).

## Editing

- **Stack** (left) lists the incident medium, the layers from top to bottom and the
  substrate. Swatch heights follow layer thickness; the pattern shows the shape
  (film, lines, blocks, holes). Select a row to edit it; move, duplicate or delete
  layers with the buttons below the list. Up to eight layers.
- **Inspector** (right) edits the selection: shape, thickness, feature size and
  materials, then the lattice (pitch, Fourier orders) and the light (spectral
  range and sampling, incidence θ, azimuth φ, polarization).
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

## Live preview and full calculation

Each edit starts a **preview**: at most ±2 Fourier orders and 13 wavelengths,
drawn dashed over the faded previous result. When editing pauses (or a drag
ends), the **full calculation** runs with the design's own orders and all
wavelengths. Spectra longer than 31 samples are split into several requests and
joined. Turning off automatic calculation in Settings adds a Calculate button.

A result always belongs to the exact inputs it was calculated for. After an
edit, the old curves stay visible but faded and labelled *Previous inputs* until
the new result arrives.

## Results

- **Spectrum**: R, T and A = 1 − R − T against wavelength, for s, p or
  unpolarized light (the mean of s and p). *Specular only* adds the zero-order
  powers. *Before last change* keeps the previous result as a grey reference.
  Click the chart or use the slider below it to inspect one wavelength.
  *Zoom to data* fits the vertical axis to the curves.
- **Reflected and transmitted color**: CIE 1931 2° observer (Wyman–Sloan–Shirley
  fit), a 6500 K blackbody standing in for daylight, sRGB output. It needs a
  spectrum covering 400–700 nm; with 450–650 nm it is marked approximate.
- **Orders**: every retained (m, n) order at the inspected wavelength, strongest
  first, with its direction and whether it propagates above and below.
- **Sweep**: one input (a thickness, feature size, pitch, θ or φ) against
  wavelength as a heat map. Rows are filled coarse-to-fine across the workers;
  rows the solver rejects stay empty and are reported. Dashed lines mark
  Wood–Rayleigh anomalies (orders up to ±2 turning grazing in either half-space).
  Click a point to apply that value and wavelength. *Fast* uses ±2 orders.
- **Field**: |E|² inside the stack at the inspected wavelength for s or p
  incidence, as a side cut through the cell centre or a top cut at a layer's
  mid-plane. The map comes from meent's field reconstruction and is shown only
  when meent's own powers at that wavelength match the reported spectrum to 1e-6.
- **Convergence**: compares the spectrum at the design's orders with one step
  finer (or coarser at the ±5 limit) and reports the largest change in R or T.
- **Fit**: paste or load a measured R or T spectrum (wavelength, value per line;
  fractions or percent; up to 31 points, thinned if longer), choose up to three
  dimensions with bounds, and fit with bounded least squares from several starts.
  The fit runs on the local server when one is in use, otherwise in this browser.
  The ±1σ values are linearized estimates from the residual; they do not cover
  model error or non-unique solutions. *Apply fitted values* edits the design.

## Files, links and saving

- **Share link** encodes the whole design (deflate, base64url) in the URL
  fragment. Nothing is uploaded.
- **Export**: design file, schema-1.2 projects for the HTTP API/MCP (split into
  ≤ 31-wavelength projects when needed), spectrum and order CSV, the spectrum
  chart as SVG or PNG (2×), and a standalone HTML report. Sweep and field maps
  have their own *Save image (.png)* button.
- **Open** reads design files, `{ "project": … }` envelopes and bare 1.0–1.2
  projects. Older 1D projects are converted (period Y = period X, one order in y).
- **Saved** keeps designs, with their spectra when up to date, in this browser.
  Saved spectra can be overlaid on the current one.

## Keyboard

- ⌘K / Ctrl+K: command palette (calculate, add or select layers, switch views,
  examples, settings, theme).
- ⌘Z / Ctrl+Z and Shift+⌘Z: undo and redo outside text fields.
- In the 3D view: drag to rotate, scroll to zoom, click a layer to select it.

## Limits

- Schema 1.2 bounds: 1–8 layers, Fourier orders 1–5 per axis, 20–5000 nm
  pitch, 200–2500 nm light, θ ≤ 75°.
- Results do not certify convergence; use the Convergence view.
- Browser calculations at ±5 orders take seconds per wavelength; the local
  server is several times faster.
