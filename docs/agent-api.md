# Local agent HTTP API

RCWA Workbench is **locally programmatic and agent-ready through HTTP/OpenAPI**. An external program can discover the supported model, validate an input, start a bounded calculation, inspect the result, and save its exact server-owned input/result pair. This is a local interface and example client, not a deployed agent, built-in language model, autonomous design optimizer, or hosted integration. A remotely hosted agent needs an execution route that can reach the user's local API; universal remote connectivity is not provided.

Project schema 1.2 supports explicit centered circular-hole or rectangular 2D
patterns and homogeneous layers. Request its current synthetic circle input with
`GET /api/example?example=circular_hole_2d`. The no-argument example remains
legacy-compatible. Project schema 1.1 supports one to eight top-to-bottom finite layers, each an isotropic centered rectangular 1D grating or homogeneous slab, sharing one period in classical mounting. Project 1.0 remains the exact one-rectangle legacy contract; its defaults and normalized hashes are unchanged. Read [physical conventions](physics.md) before comparing results. The synthetic CD recovery demo (`kind: "fit"`) requires exactly one rectangular layer, is a separate operation, and is not a general design optimizer.

An [optional local stdio MCP adapter](mcp-tools.md) exposes the same API to general
AI tool clients. HTTP/OpenAPI remains available independently of MCP.

## Run the complete HTTP example

From the repository root, install the backend dependencies as described in [development setup](development.md), then start one local API worker:

```sh
. .venv/bin/activate
PYTHONPATH=backend uvicorn api.main:app --host 127.0.0.1 --port 8000 --workers 1
```

In another terminal:

```sh
.venv/bin/python scripts/agent_example.py \
  --cd 140 180 220 \
  --max-candidates 3 \
  --deadline-seconds 180 \
  --request-timeout 10 \
  --output artifacts/agent-best.json \
  --report artifacts/agent-report.json
```

The script uses only the Python standard library and public HTTP routes. It imports no backend or numerical-core code and requires no model key. It gets `/api/capabilities` and `/api/example`, replaces the example's wavelength list with `[650.0]` and polarization with `"s"`, and evaluates the explicit CD candidates sequentially with all other settings fixed. The objective is **maximize total reflected power `R` at 650 nm, s polarization**. It does not optimize specular reflectance, average across polarizations, or silently use a nearby wavelength. A one-candidate run is also supported with `--cd 180 --max-candidates 1`.

Each candidate is validated, submitted as a forward job, and polled. The script then saves the best successful job, fetches that durable snapshot, and exports exactly `{ "project": ..., "result": ... }`. It prints every candidate's outcome and warnings. The report records the objective, limits, diagnostics, failed and unevaluated candidates, available engine information, selected job, and returned snapshot provenance. The export is checked against the complete normalized input/result pair observed during the chosen job and its server-owned job provenance. The winner is **best among evaluated candidates only**. Failed trials count toward the budget. A tie selects the first candidate in the supplied order.

### Bounded circular-hole example

With that same local API running:

```sh
.venv/bin/python scripts/agent_example.py \
  --example circular_hole_2d --diameters 45 65 85 --max-candidates 3 \
  --output artifacts/circular-best.json --report artifacts/circular-report.json
```

This explicit mode fetches `GET /api/example?example=circular_hole_2d`. It uses
650 nm, s polarization and **Hx=Hy=1 (nine orders)** for a small runnable example.
Only `layers[0].diameter_nm` varies between candidates. The named seed's 150/140 nm
pitches, lower-layer diameters, thicknesses, incidence/azimuth and every material
value/source remain unchanged. Omitting `--diameters` selects 45, 65 and 85 nm;
the default budget remains three. Diameters must be finite, distinct and within
0–140 nm. Invalid lists/budgets and incompatible `--cd`/`--diameters` modes fail
before HTTP. The existing no-flag and `--cd` invocations still use the legacy 1D
example and its unchanged settings/hashes. No arbitrary template is accepted.

The circular path also verifies the normalized candidate's canonical hash,
submitted/polled job ID/kind/hash, exact result wavelength/polarization and input
hash, then the fetched saved ID and provenance hash. The export preserves the
full result and all warnings, not a summary. The report's `diameter_nm` and
`varied_input` identify the top layer; its claim remains **best among evaluated
candidates only**, never a certified optimum or reliable physical ranking.

The materials are **synthetic, not measured or real HBM data**. H1 is deliberately
small and not convergence-tested; a successful calculation does not assess convergence.
Circles use the production 64-midpoint-strip approximation. Spatial and harmonic
refinement are separate; flux balance and geometry area bounds do not certify
optical accuracy. These edited inputs inherit no offline fixture convergence
evidence. These limitations are printed and saved alongside the server warnings.

For a generic tool-capable client, the same sequence is: discover capabilities,
fetch the named seed, make those explicit common settings and one top-diameter
change, validate, submit only the returned normalized input, poll the returned
ID, and select by exact total `spectra.s.R` at 650 nm. Save by the winning job ID
and fetch the returned durable ID. Keep both IDs and the validated hash. Do not
infer tool access from this script; HTTP/OpenAPI and optional MCP are separate
client routes to the same local service.

If saving is uncertain, keep `best.job_id` from the report. **Do not rerun the
experiment or retry POST to discover whether it saved.** Use only
`GET /api/projects?view=index`, match the original `provenance.job_id`, and fetch
that ID's `?view=inputs` and `?view=summary` (or full record for a result import).
Check ID/hash/provenance and retain every warning. Restart removes volatile jobs
but preserves saved records. The latest-100 index is bounded; no match is
unresolved, not permission to resubmit. See [saved-input recovery](#discover-and-reuse-saved-inputs).

### Bounds and failure behavior

- The explicit candidate list must fit the requested budget. The default budget is 3 and hard maximum is 8; duplicate/nonfinite candidates and invalid limits are rejected before any HTTP request.
- The default cooperative work deadline is 180 seconds, configurable up to 600. It is checked between requests and polling waits; each request uses the smaller of the remaining deadline and the socket inactivity timeout (default 10 seconds, maximum 30). This is not a hard client wall-clock limit: a slow, trickled HTTP response can exceed it. Cleanup attempts one cancellation with a socket inactivity timeout of at most 5 seconds. The server separately enforces a hard calculation timeout.
- Polling waits start at 0.1 seconds, grow by a factor of 1.5, and stop growing at 2 seconds. There is no busy loop.
- Numerical failure is recorded and the next supplied candidate may run. Invalid configuration, engine unavailability, HTTP failure, or an unexpected result contract stops the run. HTTP 429 stops immediately; it does not repeatedly compete for a busy server.
- An uncertain POST outcome, including a lost submission response, is never retried automatically. A calculation might have started without the client learning its ID. Do not blindly rerun that POST; inspect the report and server first. The server's hard job timeout still applies.
- Ctrl-C, termination, a polling error, or the work deadline triggers one cancellation attempt for a known active job. The report says whether cancellation was confirmed. Interruption during submission can leave an unknown job ID that the script cannot cancel.
- Only loopback HTTP destinations are accepted. Environment HTTP proxies and redirects are disabled. The client bounds response size at 8 MB.

Exit status is 0 when a best snapshot and both local files were saved, 1 for a stopped/unsuccessful run, and 130 for interruption. A completed run may still contain failed candidates, so inspect the report. Calculation/save failure writes no new export; an export left from an earlier invocation is not evidence of success for the current run.

Each JSON file is replaced atomically using a temporary file in its own directory.
The report/export are not a two-file transaction. An export-write failure returns
1, preserves the earlier file, and records the stop plus durable snapshot/job IDs
in the report when that report can be written. A report-write failure also returns
1 and is printed explicitly; an already written export can still be used.
Obvious destination conflicts and directory targets are rejected before HTTP.

## Open the result in the UI

Start the local frontend with `cd frontend && npm run dev`, then open `http://localhost:5173`.

- Use **Import JSON** to open `artifacts/agent-best.json` and inspect its geometry, selected wavelength/polarization, powers, and warnings.
- Or open **Saved projects** and choose the durable snapshot from this run. Its ID is printed by the script and recorded in `agent-report.json`.
- Editing the input makes the displayed result stale. Recompute before interpreting it as the result of your edited input.

The circular export follows the existing **full result import** route. In
contrast, schema-1.2 **input-only** JSON opens Review imported design and requires
Apply changes; it does not install a result or run a calculation. A compact
summary/receipt is neither an input file nor a full result import.

The JSON export preserves the server-returned project/result pair for compatibility, but importing a file does not establish trusted server provenance. Client-supplied saves are classified as unverified imports, even if a file claims otherwise. To inspect server-owned provenance, fetch the durable ID from the API or use the server's saved-project entry.

The public static preview contains a precomputed result and makes **zero live API requests**. This workflow requires the local API and does not turn the static site into a hosted solver.

## HTTP contract

Explore the running API at `http://127.0.0.1:8000/docs` or fetch `http://127.0.0.1:8000/openapi.json`. Runtime Pydantic models are authoritative; generated OpenAPI describes request and response shapes. Unknown input fields, nonfinite JSON values, unsupported geometry, and cross-field violations are rejected. Browser-side checks are only an early convenience.

| Step | Method and path | Request / response |
| --- | --- | --- |
| Discover | `GET /api/capabilities` | Actual physics, units, observable conventions, limits, engine availability, versions, persistence, and local-only restrictions |
| Seed | `GET /api/example` or `GET /api/example?example=circular_hole_2d` | Unchanged Project 1.0 default or explicit current circular Project 1.2 input; synthetic constants, no result |
| Validate | `POST /api/validate` | Send a Project directly, without a `project` wrapper. Returns `{valid, project, diagnostics, input_hash}` for schema-valid inputs; `project` is normalized. Schema-invalid requests return HTTP 422 with structured diagnostics |
| Preview edits | `POST /api/change-preview` | `{"base_project": Project, "changes": {"cd_nm": 140}}` → a versioned geometry proposal, normalized inputs, hashes, typed diff and candidate preflight diagnostics; no solve, save or apply |
| Preview 2D dimensions | `POST /api/2d-change-preview` | Explicit Project 1.2 base plus shared pitches and indexed existing-layer dimensions → exact-base proposal 1.2; no solve, save or apply |
| Preview stack | `POST /api/stack-change-preview` | `{"base_project": Project, "changes": {"period_nm": 390, "layers": [Layer, ...]}}` → proposal 1.1 with an atomic candidate and bounded summary diff; either change key may be omitted |
| Submit | `POST /api/jobs` | `{"kind":"forward","project":<normalized Project>}` → HTTP 202 job envelope with ID and status |
| Poll | `GET /api/jobs/{job_id}` | Full job by default; `?view=summary` returns bounded `result_summary` totals, status and error information |
| Cancel | `DELETE /api/jobs/{job_id}` | Cancels a known running job; repeated cancellation is safe |
| Save | `POST /api/snapshots` | `{"job_id":"<succeeded forward job ID>"}` → full durable record; `?view=receipt` returns only bounded identity/provenance/totals while storing the same complete pair |
| Fetch | `GET /api/projects/{snapshot_id}` | Exact full saved record; `?view=summary` returns bounded identity/provenance/totals without the full project or order arrays |
| List | `GET /api/projects` | Saved-project entries for the local UI |

Validation performs deterministic schema and preflight checks without launching a process or solving physics. Diagnostics have stable `code`, `severity`, `location`, and readable `message` fields. Schema-valid but inadmissible inputs return `valid: false`; inspect all diagnostics. Schema errors return HTTP 422 with `error.diagnostics`. Warnings are not a certificate of safety or convergence. A valid input may still fail an eigensolve or flux check during computation.

Errors use `{ "detail": "readable explanation", "error": { "code": "...", "message": "...", "diagnostics": [...] } }`. Relevant failures include invalid/unsupported input, unavailable engine, capacity, numerical failure, timeout, cancellation, and missing/expired jobs. An unavailable or wrong-version engine is reported explicitly; there is no approximate or synthetic fallback. Use the returned error code rather than matching human-readable messages.

New HTTP requests require JSON numbers for physical values: booleans and numeric strings are rejected. Each material-table column is limited to 2000 rows. Invalid Unicode scalar values, including unpaired surrogates, are rejected before a job starts or an import is stored. This does not change normalization when reading historical saved inputs and results.

Malformed-request responses contain at most 50 diagnostics, including a final `diagnostics_truncated` marker when further diagnostics were omitted. Each diagnostic message and location is bounded to 512 serialized UTF-8 bytes; shortened text ends with `[truncated]`. A large invalid table or field name therefore cannot produce an unbounded error response.

Job states are `running`, `succeeded`, `failed`, and `cancelled`; this local server does not maintain a durable queue. Forward results include wavelength lists, per-polarization spectra, per-order powers, metadata, and warnings. The synthetic-fit result is distinctly labeled and has a separate shape. A caller must check job status and kind before interpreting `result`.

## Opt-in result summaries and snapshot receipts

Omitting `view`, or choosing `view=full`, preserves the existing full responses.
Summary/receipt queries do not change computation, storage, normalized identity,
provenance or result binding. The same full record is validated before a compact
view is returned. For example:

```text
GET  /api/jobs/{job_id}?view=summary
POST /api/snapshots?view=receipt   body: {"job_id":"..."}
GET  /api/projects/{snapshot_id}?view=summary
```

A job summary retains its ID, kind, status, input hash, timestamps and errors,
and replaces the full `result` member with `result_summary`. A snapshot summary
or receipt retains durable ID, name, timestamps, original provenance, canonical
input hash, `status: "stored"`, and `result_summary`. Neither includes the full
project or material tables. Saving with a receipt still persists the **full**
server-owned pair and remains idempotent by job ID.

The `rcwa-forward-summary/1.0` projection copies every wavelength/polarization's
`R`, `T`, `R_specular`, `T_specular` and `A_balance` unchanged. It excludes order
arrays and full metadata and records its source result version and input hash
when present (required for 1.2). This is not an importable result, full export,
or convergence certification. Synthetic-fit job summaries are separately typed
`rcwa-fit-summary/1.0`; target/prediction totals are available but full optimizer
diagnostics and the fitted project stay in the full result.

Compact envelopes are capped at 128,000 UTF-8 JSON bytes. Each warning list keeps
a prefix of at most 64 whole messages and 16,000 encoded bytes, with an explicit
`warnings_omitted_count`; messages are never shortened. If any were omitted,
inspect the full result's warnings before interpreting it. Unusual legacy data
that cannot provide a bounded projection returns `summary_unavailable` rather
than invented or silently truncated powers. A failure to generate a receipt
after saving returns a 5xx uncertainty error; it must not trigger a new job.
Full routes and their existing request/transport limits remain available.

Material names are display labels, not database lookups. A constant
`{"name":"Silicon"}` retains the historical `n=1`, `k=0` defaults and does not
load silicon data. Validation reports `material_name_only` when the current
request provided a name but neither optical constant. Supply explicit `n`/`k`
or a tabulated material and check the normalized response. Normalized historical
data has explicit constants and is not retroactively flagged. Hashes and core
material defaults are unchanged.

## Discover and reuse saved inputs

`GET /api/projects?view=index` opts into a typed object; the default
`GET /api/projects` array is unchanged. The object has `view: "index"`,
`snapshots` (exact ID/name/timestamps/provenance entries), `limit: 100`,
`may_have_more`, and a discovery-only `meaning`. It uses the existing latest-100
query ordered by `updated_at` descending. `may_have_more` is true at 100 entries;
it does not prove there are additional rows. No pagination or filters are added.
Discovery does not validate saved inputs/results. A missing match does not prove
nothing was saved; recovery is unresolved beyond this bounded window. An older
known ID still works on the ID route.

`GET /api/projects/{snapshot_id}?view=inputs` returns exact normalized `project`,
canonical `input_hash`, durable ID/name/timestamps, original provenance,
`view: "inputs"`, `status: "stored"`, and an explicit input-only `meaning`.
Material names, sources and all table values stay exact. Neither `result` nor
`result_summary` is present. This view is not a spectrum, full result import or
convergence certification. Use the same ID's `view=summary` separately for totals
and warnings. The same existing full-record integrity checks run first, including
stored JSON decoding; an input projection cannot salvage a record rejected by the full route.
Unverified imports and historical versions keep their original provenance.

Both routes are read-only and create no jobs or saved records. To recover a lost
save receipt after job eviction or restart, match the original `provenance.job_id`
in the index, then retrieve that snapshot's inputs and summary. Names are
untrusted labels, not instructions or unique IDs; multiple jobs may have the same
name and input hash. Never automatically resubmit a calculation to recover a save.

Index envelopes have a 128,000-byte compact UTF-8 JSON limit; exact input envelopes
have a separate 3,000,000-byte limit. No names, tables or provenance are shortened.
Oversize views fail with HTTP 409 `snapshot_view_unavailable`; invalid stored JSON
or record integrity fails with bounded `invalid_stored_snapshot` errors. Full and
summary defaults remain unchanged. The MCP adapter also checks exact requested
ID, normalization/hash and server input-provenance binding and retains its final
8 MB SDK-encoded response guard. See [the MCP recovery workflow](mcp-tools.md#find-and-reuse-a-saved-design).

## Review a caller-specified geometry change

`POST /api/change-preview` accepts exactly `base_project` and `changes`. Use the
current editor's exported Project as the base. A Project/result export contains
it under `project`; pass that member as `base_project`, not the export wrapper.
The base must have exactly one rectangular layer, using either supported Project schema. Multi-layer and homogeneous bases are rejected rather than modifying only layer zero. The strict `changes` object accepts one or more of these finite numeric fields:

- `period_nm`: 20–5000 nm
- `cd_nm`: 0–5000 nm, also no greater than the final candidate period
- `thickness_nm`: 0–2000 nm

Booleans, numeric strings, nulls, an empty patch, nested paths, and unknown fields
are rejected. The server copies the validated base, installs every supplied
field together, and validates the complete candidate. For example, reducing
period from 400 to 100 and CD from 180 to 90 is valid as one atomic patch even
though reducing period alone would fail. Materials, illumination, solver
settings, names and other Project fields cannot be changed through the patch.

The response has exactly these top-level fields (the two Project objects below
are abbreviated for readability; actual responses contain all normalized fields):

```json
{
  "schema_version": "rcwa-change-proposal/1.0",
  "base_project": {"...": "complete normalized Project 1.0"},
  "candidate_project": {"...": "complete normalized Project 1.0"},
  "changes": {"cd_nm": 140.0},
  "base_input_hash": "<64 lowercase SHA-256 hex characters>",
  "candidate_input_hash": "<64 lowercase SHA-256 hex characters>",
  "diff": [{"field": "cd_nm", "before": 180.0, "after": 140.0}],
  "diagnostics": [],
  "valid": true
}
```

`changes` retains only supplied keys. Diff entries are ordered `period_nm`,
`cd_nm`, `thickness_nm` and omit equal values. A no-op has `diff: []`, typically
equal hashes, and cannot be applied. `valid` describes candidate admissibility,
not whether the diff is nonempty. Hashes use the same normalized Project
canonicalization as validation and jobs.

Schema errors, including invalid base geometry and the candidate's CD/period
constraint, return structured HTTP 422 errors. Candidate preflight errors return
HTTP 200 with `valid: false`; warnings stay visible in `diagnostics`. Diagnostic
locations are relative to the candidate Project. A schema-valid base with a
preflight error can be repaired by a valid geometry change. This endpoint does
not inspect numerical-engine availability, run a solver, allocate a job, write
storage, or apply inputs on the server. A successful preview predicts no optical
improvement and does not certify numerical convergence.

For the explicit local handoff, save the complete response object as a UTF-8 JSON
file, then use **Import JSON** in the workbench. The proposal is shown for review
before an explicit Apply; cancel changes nothing and applying does not compute.
The proposal response/import file limit is 8 MB; HTTP request bodies remain limited to 2 MB. Imported proposals are
untrusted: the UI reconstructs the candidate and diff from the allowlisted
patch, checks the complete base against the current editor, and rejects stale
or unrelated proposals rather than silently rebasing them. Supplied hashes and
diagnostics cannot establish server provenance. No result or provenance field
is accepted in a proposal. Export the current project again to request a new
proposal when the editor has changed.

The [MCP preview tool](mcp-tools.md#review-geometry-without-running-a-calculation)
uses this same route. There is no built-in language model, live chat link,
proposal database or server-side apply operation. Existing loopback Host,
browser-Origin, finite JSON and 2 MB request boundaries still apply, including
to this read-only POST operation.

## Review an atomic stack change

`POST /api/stack-change-preview` and MCP `rcwa_preview_stack_changes` retain the
same review-only lifecycle as the legacy geometry preview. The request has only
`base_project` and nonempty `changes`; allowed change keys are `period_nm`
(20–5000 nm) and `layers` (a complete ordered list of 1–8 finite layers). Layers
are top to bottom, with no IDs. Rectangles retain name, geometry, thickness, CD,
material and background. Homogeneous layers contain only name, geometry,
thickness and material. Each thickness is 0–2000 nm. Unknown fields, arbitrary
paths, null replacements, numeric strings, booleans and nonfinite numbers are
rejected. Materials follow the same constant/tabulated limits as a Project.

All supplied dimensions and layers are installed together before complete
candidate validation, including every rectangle's CD/period constraint and
material table coverage in every layer. The candidate explicitly uses Project
schema `1.1`; a legacy base is preserved exactly and its promotion appears in
the diff. Illumination, solver, ambient, substrate and project name cannot be
changed by this endpoint.

The response has the same top-level keys as proposal 1.0, but
`schema_version` is `rcwa-change-proposal/1.1` and `changes` is the stack patch.
The exact normalized base, candidate and supplied replacement layers retain all
material table values. Both hashes use the existing SHA-256 Project convention.
`valid` and indexed diagnostics are recomputed from the candidate without
inspecting the numerical engine.

Diffs are deterministic, omit equal values, and contain at most 64 entries:

- Order: `schema_version`, `period_nm`, then ascending layer index. Within an
  unchanged layer type: `name`, `thickness_nm`, `cd_nm`, `material`, `background`;
  homogeneous layers omit `cd_nm` and `background`.
- Every entry has `kind`, `path`, `before`, `after`. Paths are descriptive,
  e.g. `layers[1].material`; they are never executable JSON Patch paths.
- `kind: "value"` carries a string, number or null on either side.
- `kind: "material"` replaces one material atomically with concise summaries.
- Added, removed or type-changed layers emit one `kind: "layer"` entry at
  `layers[i]`, without redundant child entries; an absent side is null.
- A material summary has exactly `name`, `kind`, `n`, `k`, `source`, `table`.
  Constant material tables are null. A tabulated summary contains exactly
  `rows`, `wavelength_min_nm`, `wavelength_max_nm`, `checksum`.
- A layer summary has exactly `name`, `geometry`, `thickness_nm`, `material`,
  `cd_nm`, `background`; the latter two are null for homogeneous slabs.

The table checksum is `fnv1a32-f64be:` followed by eight lowercase hex digits.
Start at 2166136261, process each row's wavelength/n/k as big-endian IEEE-754
float64 bytes, xor each byte and multiply by 16777619 modulo 2^32. It is only an
informational change detector, not a cryptographic signature. Exact data and
full Project comparison determine applicability, not this summary checksum.
Tables never expand into individual row diffs.

HTTP bodies remain capped at 2,000,000 bytes. Proposal responses and imported
proposal files allow 8,000,000 UTF-8 bytes, consistent with the MCP HTTP response
bound. Oversize requests return `body_too_large`; oversize proposal responses
return `proposal_too_large` (HTTP 413). The MCP transport reports
`response_too_large` for an oversized upstream response. None of these failures
creates a job or applies edits. An 8 MB import allowance does not enlarge a
later HTTP computation request.

The UI reconstructs the full candidate and diff, recomputes preflight, checks
that the entire base still matches the editor, and requires explicit Apply.
A no-op cannot be applied. Hashes and imported diagnostics cannot establish
computed provenance. No result/provenance fields, jobs, persistence, automatic
apply, optimizer, LLM, or paid service are introduced.

## Versioned results and historical snapshots

New computations emit result schema `1.1`, adapter `1.1.0`, including
`layer_count`, `active_slab_count`, `total_thickness_nm`, and
`stack_order: "top_to_bottom"`. Current worker and job contracts accept only
current results. Supported schema lists are exposed in capabilities alongside
current project/result versions and the eight-layer limit.

Snapshot readers explicitly accept known result schema `1.0`/adapter `1.0.0`
and current `1.1`/`1.1.0`. They preserve the original Project, result and
server-computed provenance without rewriting, upgrading or downranking a
historical server snapshot. Unknown versions are rejected. No database migration
is needed. Client imports of either known version remain unverified, and legacy
weak-shape result-1.0 files remain importable without becoming server results.

## Identity, lifetime, and provenance

Job IDs are ephemeral. The API runs one worker, accepts at most two concurrent calculation processes, retains at most 100 in-memory job records, and applies a 120-second hard timeout per job. Input JSON is limited to 2 MB and numerical processes use one BLAS thread. Consult capabilities for the running instance's precise limits. Restarting the API loses jobs; old completed jobs may also be evicted. A failed, cancelled, missing, expired, or unfinished job cannot be saved as a successful snapshot.

A saved snapshot has a separate durable ID. Snapshots are append-only, survive API restarts in the configured database, and bind the exact deep-normalized submitted input to its validated result. Saving the same completed forward job is idempotent and returns the existing snapshot rather than creating duplicates. This does not make job submission idempotent. Save a successful job before its temporary record expires.

Server-computed provenance has `source: "server_computed"`, `job_id`, `input_hash`, project/result schema versions, engine/version, adapter version, submitted/completed timestamps, and a canonicalization description. Existing records without server provenance and client-imported saves have `source: "unverified_import"`; they cannot acquire server-computed status from client-supplied metadata. The legacy `POST /api/projects` import/save path remains available, but it does not create a server-verified run.

The input hash is SHA-256 over UTF-8 encoded compact JSON of the server-normalized Project: defaults are filled and numeric types are normalized through the Project model, object keys are sorted, separators are `(',', ':')`, non-ASCII characters are preserved (`ensure_ascii=False`), and nonfinite values are forbidden. It identifies exact canonical input content within this contract. Neither a matching hash nor a server-computed label authenticates an imported file, cryptographically signs a result, or certifies the underlying physics.

## Scientific and deployment limits

`R`/`T` are total retained-order powers; `R_specular`/`T_specular` are zero-order powers. For an absorbing substrate, `T` is flux entering its front face, not backside transmission. `A_balance = 1-R-T` is a flux deficit, not an independently integrated absorption measurement. The example's material values are synthetic. One accepted or successful run does not establish Fourier convergence, a global optimum, manufacturing feasibility, or agreement with measurements. The finite candidate comparison makes none of these claims.

Keep the API loopback-only, with one worker. It is unauthenticated and local-development-only; no public tunnel, production security, paid service, or remote credential feature is provided. Host and browser-Origin checks reduce accidental exposure and cross-origin misuse; they do not make it production-secure. Authorized local scripts without an Origin header remain supported.

## Verification

Run Ruff and the complete backend suite, including the optional MCP dependencies:

```sh
.venv/bin/ruff check backend
OPENBLAS_NUM_THREADS=1 .venv/bin/pytest backend/tests -q
```

The stack regressions include validate/submit/poll/save/read, synthetic-fit scope,
strict schemas, indexed lower-layer coverage, atomic read-only proposals, exact
request binding, and real near-limit material-table payloads producing proposals
larger than 2 MB. Historical compatibility uses an unchanged server snapshot and
SQLite database generated by released baseline `ec9fa014`, not a relabeled new
result. The test copies that database before use.

The official MCP SDK protocol suite covers both legacy initialization and current
discovery, actual single-layer and mixed-stack calculations, snapshot reload,
and read-only stack previews. GitHub Checks must additionally run PostgreSQL and
live/static browser checks for the exact test-branch commit. Local tests do not
substitute for those acceptance gates.

## Explicit schema 1.2

Schema 1.2 supports centered rectangular and circular-hole two-dimensional multilayers through the existing
validate/jobs/snapshot/import routes. It requires explicit `schema_version: "1.2"`,
`period_nm` (x), `period_y_nm` (y), every layer's geometry tag, and separate
`harmonics_x` / `harmonics_y`. Rectangle widths are `cd_x_nm` / `cd_y_nm`;
`circular_hole_2d` uses `diameter_nm`, `material` for hole fill and `background`
for the host. Its diameter cannot exceed either shared period. Diameter zero
is all host; the maximum diameter still retains host in the cell corners.
New clients must check the version-specific geometry capabilities;
illumination adds `azimuth_deg`. Per-order results retain integer `(m,n)` and
outgoing local `R_s`, `R_p`, `T_s`, `T_p` powers. All ordinary results still state
that convergence is not assessed. The synthetic numerical fixture is not a
calibrated or actual HBM device.

Read `project_profiles` in capabilities. The legacy scalar limits remain legacy
limits: 1.2 instead allows 31 wavelengths, Hx/Hy 1–5 (121 orders), eight finite
layers and one active 2D process within two total slots. Harmonics require integer
JSON tokens: runtime rejects `3.0`, although JSON Schema's mathematical integer
type accepts it. Missing project version retains 1.0; 1.2 never appears by guessing
fields or migrating an import. Legacy hashes, saved readers and signed-zero /
Unicode serialization remain unchanged.

The frontend opens the exact synthetic 1.2 example and supports direct 2D editing.
The HTTP `/api/example` route deliberately retains its legacy fixture for existing
clients; `?example=circular_hole_2d` explicitly returns the current circular input. Fitting and the two legacy change-proposal routes remain unavailable for 1.2;
a 1.2 request to those operations fails before worker allocation. Use the separate
`/api/2d-change-preview` route for bounded dimension proposals. See the
[2D editor](ui/2d-editor.md) for browser workflow and input/result identity.

Job inputs are copied and normalized. A validated 2D result, its job and saved
snapshot share one UTF-8 canonical input hash. Snapshot provenance uses the actual
result adapter version. Current 1.2 computations emit adapter `1.3.0`; known
rectangular results from adapter `1.2.0` remain readable. Circles require `1.3.0`
and explicit `circular_geometry` metadata for the fixed 64-strip production
resolution. Offline spatial or Fourier refinements cannot be presented as
ordinary public jobs. Imported files remain unverified even when their powers
and identities are internally consistent. Save by succeeded job ID remains
idempotent; cancelled/failed work cannot be saved as a computed snapshot.

Volatile job history has both a 100-record cap and a 64,000,000-byte estimated
completed-input/result memory budget (`limits.retained_completed_bytes`). The
manager caches recursive Python-object sizes and evicts oldest completed records
with their captured input until both limits hold. Polling an evicted job returns
404; save useful completed results promptly. Persisted snapshots remain available
by snapshot ID after history eviction and API restart. Active jobs and records
still owning cleanup resources are protected; cleanup-pending records block new
admission rather than accumulating more work. An individual successful result
larger than the history budget becomes a `history_limit` failure before acceptance.
The byte bound applies after cleanup to evictable completed history; protected
terminal records can temporarily exceed it while resource ownership remains.
Unreaped children still consume numerical slots, and cleanup-pending records
block all new admission until cleanup succeeds.

The memory budget bounds retained history, not total RSS, concurrent serialization
copies or active solver allocations. The actual normalized maximum-table completed
job and input consume about 8.56 MB under this estimator. A ten-record regression
retains exactly the newest seven (59.89 MB) and evicts the oldest three.
Two active bounded workers plus their API process peaked near 396 MiB in the
local resource probe before retained history. This is evidence of headroom, not
a portable operating-system memory guarantee.

The 2 MB HTTP request cap is unchanged. An exported full-result file may exceed
it, particularly with 31 wavelengths or large material tables. Oversized imports
return structured HTTP 413 (`body_too_large`) before parsing or persistence.
Project-only imports within the cap and ID-only `POST /api/snapshots` remain
available. A full valid snapshot can be retrieved with the existing
`GET /api/projects/{snapshot_id}`. Browser-local file viewing is distinct from
HTTP persistence and does not enlarge the POST cap.


### Exact-base 2D dimension proposals

`POST /api/2d-change-preview` accepts only `base_project` (explicit schema 1.2)
and `changes`. It returns `rcwa-change-proposal/1.2`; legacy preview routes and
proposal 1.0/1.1 behavior are unchanged. Example patch:

```json
{"period_nm": 160, "period_y_nm": 150, "layers": [
  {"index": 0, "geometry": "circular_hole_2d", "diameter_nm": 70, "thickness_nm": 96}
]}
```

Omit unchanged keys. `layers`, when supplied, contains 1–8 uniquely indexed
patches, each with its existing `geometry` tag and at least one dimension.
Indexes are zero-based strict integer JSON tokens. Every geometry permits
`thickness_nm`; circles permit `diameter_nm`, rectangular 2D patterns permit
`cd_x_nm`/`cd_y_nm`, and embedded 1D gratings permit `cd_nm`. Uniform layers
permit thickness only. Shared pitches remain `period_nm`/`period_y_nm`.
Nulls, booleans, numeric strings, nonfinite numbers, unknown/duplicate members,
missing/nonexistent/duplicate indexes and mismatched tags are rejected. All
changes are applied atomically before cross-field checks; no value is clamped.
Names, optical tables/materials, layer order/count/shape, illumination and solver
settings are preserved exactly.

The response includes complete normalized base/candidate projects, the patch,
canonical SHA-256 input hashes, a deterministic numeric `diff` (pitches first,
then ascending layer index, at most 26 entries), existing numerical-preflight
`diagnostics`, and `valid`. Signed float zero is significant to identity and diff.
A successful response is a preview, including when `valid` is false; no engine
lookup, job, calculation, storage, apply or convergence claim occurs. Requests
remain bounded to 2,000,000 UTF-8 bytes; proposals to 8,000,000 bytes. MCP also
checks its complete duplicated JSON-RPC representation against 8 MB.

Import the complete response with **Project → Import JSON**. The browser strictly
reconstructs the allowed candidate and diff, requires every canonical input key,
and verifies both hashes before showing review. Only the exact current base can
Apply; hashes prove consistency, never server provenance. Imported diagnostics
are untrusted and not echoed. An inconsistent `valid`/error-severity combination
rejects the file; a reported failure conservatively blocks Apply with a neutral
message. A reported success does not establish numerical admissibility: the
local server checks it when the user chooses **Run simulation**. Applying valid
input edits makes one undo step and preserves the selected layer and old spectrum
with its original inputs. Cancel, no-op, stale input/review and late file/hash
responses cannot install changes. Apply does not save to the server; existing
tab-local draft recovery still retains the edited inputs. Ordinary schema-1.2 input-only imports retain
their non-base-bound full-input review; result-bearing imports are unchanged.
