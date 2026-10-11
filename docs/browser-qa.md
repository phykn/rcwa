# Reproduce browser verification

This workflow needs a machine where Chromium may launch. The current build environment aborted Chromium before page creation (`socket() Operation not permitted`), so this script is a prepared check, not evidence of a completed browser pass.

1. Install the development dependencies described in README.
2. Install the official Playwright browser: from frontend, run `npx playwright install chromium`. Alternatively set `CHROMIUM_PATH` to an existing Chromium executable.
3. Start the real backend on 127.0.0.1:8000 using the README command.
4. Start the Vite development app on 127.0.0.1:5173 (`npm run dev`).
5. In another frontend shell, run `VITE_STATIC_PREVIEW=true npm run build`, then `npm run preview -- --port 4173`.
6. From frontend run `node scripts/browser-qa.mjs`.

The script uses the live app on port 5173 and the frozen static preview on 4173. It writes its JSON report, exported example, and desktop/mobile screenshots under the ignored `artifacts/` folder. It only declares success after all assertions pass. A failed assertion or browser launch must not be reported as a visual pass.

Coverage: real forward process and chart, s/p and total/specular selection, stale-input label, malformed JSON rejection without state replacement, metadata save/load, full JSON export/reload, real synthetic CD recovery, deterministic forward/fit cancellation with mocked queued jobs (separate from the real solver checks), Escape dismissal, and a 390px static preview with first-screen geometry and inputs, collapsed secondary settings, no API requests, and a setup link instead of live compute.

This is an unauthenticated local development app. Do not make the Python API public or use a tunnel for this check.

The `browser` job in `.github/workflows/checks.yml` runs this same check on a standard Ubuntu runner. It binds all three servers to localhost, limits the browser script to four minutes, and retains only PNG screenshots and `browser-qa.json` for one day. A successful build or job setup alone is not a browser-test pass.

The visual-builder check also captures 390 × 844 and 360 × 800 initial viewports, selected dimensions, the spectrum viewport, edited/stale output, Materials, Light, fit demo, and model assumptions. It asserts dimension-button touch sizes, tap/keyboard focus and highlighted geometry, first-screen numeric inputs, a 260 CSS-pixel chart with at least 12 CSS-pixel rendered tick labels, and no horizontal overflow. These browser assertions complement, rather than replace, independent screenshot review.

## Ordinary circular-hole example

The current ordinary URL opens the circular-hole example. Run
`node scripts/circular-browser-qa.mjs` against the same live/static servers for
its dedicated 360×800, 390×844 and desktop checks. The script records
`circular-*` screenshots, exported files and a JSON report in `artifacts/`. It
covers genuine host cutouts, one Diameter control, independent layer thickness
and X/Y pitch, Hole/Host material roles, zero/max diameter, non-air fills,
cutaway/full stack, history, imports, fallback editing and real run/cancel
lifecycle. Successful numerical responses are never mocked.

The older `true-2d-browser-qa.mjs` retains the full rectangular regression suite
through `?example=rectangle`; the retained 1D suites use their explicit legacy
route. All suites run in the browser CI job, and the exact candidate's screenshots
need independent inspection before release. Existing screenshots from another
commit do not establish acceptance.
