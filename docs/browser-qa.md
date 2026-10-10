# Reproduce browser verification

This workflow needs a machine where Chromium may launch. The current build environment aborted Chromium before page creation (`socket() Operation not permitted`), so this script is a prepared check, not evidence of a completed browser pass.

1. Install the development dependencies described in README.
2. Install the official Playwright browser: from frontend, run `npx playwright install chromium`. Alternatively set `CHROMIUM_PATH` to an existing Chromium executable.
3. Start the real backend on 127.0.0.1:8000 using the README command.
4. Start the Vite development app on 127.0.0.1:5173 (`npm run dev`).
5. In another frontend shell, run `VITE_STATIC_PREVIEW=true npm run build`, then `npm run preview -- --port 4173`.
6. From frontend run `node scripts/browser-qa.mjs`.

The script uses the live app on port 5173 and the frozen static preview on 4173. It writes its JSON report, exported example, and desktop/mobile screenshots under the ignored `artifacts/` folder. It only declares success after all assertions pass. A failed assertion or browser launch must not be reported as a visual pass.

Coverage: real forward process and chart, s/p and total/specular selection, stale-input label, malformed JSON rejection without state replacement, metadata save/load, full JSON export/reload, real synthetic CD recovery, and a 390px static preview with no API requests and disabled live compute.

This is an unauthenticated local development app. Do not make the Python API public or use a tunnel for this check.

The `browser` job in `.github/workflows/checks.yml` runs this same check on a standard Ubuntu runner. It binds all three servers to localhost, limits the browser script to four minutes, and retains only PNG screenshots and `browser-qa.json` for one day. A successful build or job setup alone is not a browser-test pass.
