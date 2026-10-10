# Development setup

Requires Python 3.12+ and Node.js 22+.

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements-lock.txt
cd frontend && npm ci && cd ..
```

Terminal 1, using the zero-setup SQLite demo:

```sh
. .venv/bin/activate
PYTHONPATH=backend uvicorn api.main:app --host 127.0.0.1 --port 8000
```

Terminal 2:

```sh
cd frontend
npm run dev -- --host 127.0.0.1
```

Open http://localhost:5173. API documentation is at http://localhost:8000/docs.

### Use PostgreSQL

```sh
docker compose up -d db
export DATABASE_URL='postgresql+psycopg://rcwa:local-development-only@localhost:5432/rcwa'
PYTHONPATH=backend uvicorn api.main:app --host 127.0.0.1 --port 8000
```

`.env.example` is a reference file; it is not loaded automatically. Set the environment variable in your shell as shown. If a configured PostgreSQL server is unavailable, API startup fails. It does not silently fall back to SQLite. The SQLite demo is selected only when `DATABASE_URL` is absent.

## Checks

```sh
. .venv/bin/activate
ruff check backend
pytest -q
cd frontend
npm run lint
npm run build
```

The PostgreSQL integration test runs when `TEST_POSTGRES_URL` is configured. GitHub CI provides a separate PostgreSQL service. Without a local test service, only that test is explicitly skipped. See [verification status](validation.md) for observed results and remaining limits.

## GitHub and mobile viewing

GitHub Actions runs code and physics checks. GitHub Pages serves the static React interface. **Pages does not run the Python/meent solver.** The static preview displays a genuinely precomputed reference, makes no API requests, and disables live computation. Editing its inputs marks the displayed result as stale; it does not generate a new spectrum.

For the normal local application, `VITE_API_BASE_URL` sets the API address at build time. An HTTPS page may be blocked by browser security rules when connecting to an HTTP local API.

The API is an unauthenticated local-development prototype. Do not expose it on the public internet or through a temporary tunnel. Multiuser authentication, production quotas, TLS configuration, and deployment operations are not implemented.

### Pages reference preview

The workflow is prepared to publish the static preview after `Checks` succeeds on the main branch. Set repository Settings → Pages → Source to GitHub Actions. The `VITE_STATIC_PREVIEW=true` build displays only the stored example computed by the real Python solver. The local calculation API remains private. See [GitHub's official Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Job and storage lifetime

Run the API with **one worker**. It retains at most 100 job records in memory; restarting the API removes them. It accepts up to two simultaneous calculations and returns HTTP 429 when both slots are occupied. Each job has a 120-second deadline that terminates the numerical process. Save completed results to the database or export JSON to retain them. Saving creates a new snapshot rather than overwriting an existing project.

Lengths are in nm. Public passive-material input uses n > 0 and k ≥ 0. Internal complex signs, diffraction-order conventions, and power normalization are documented in result metadata and [the physics contract](physics.md). Example optical constants are synthetic values, not a calibrated material database.

## Programmatic local access

The [agent API guide](agent-api.md) describes discovery, no-job admissibility
checks, typed jobs, and server-owned snapshots. This is an HTTP/OpenAPI interface
and a runnable candidate-evaluation example, not an integrated or deployed LLM
agent. No keys or paid services are required.

Mutation requests reject browser Origins outside `CORS_ORIGINS`; Host must be
`localhost`, `127.0.0.1`, or `::1`. Origin-less local HTTP scripts are supported.
These checks are defense in depth, not authentication. Keep loopback binding and
one Uvicorn worker. Do not expose this service or loosen the host boundary for a
remote agent.

Existing `projects` rows and columns are preserved. An additive `run_provenance`
table stores trusted local origin for new server-owned snapshots. There is no
claim that SQLAlchemy `create_all()` migrates existing columns. Old rows and
client-import saves remain unverified. Snapshot input/result JSON is append-only;
saving the same completed forward job again returns its existing snapshot ID.
