# Use RCWA from an AI tool client

RCWA Workbench has two local interfaces to the same solver: [HTTP/OpenAPI](agent-api.md)
and this optional Model Context Protocol (MCP) adapter. A general AI application
with local stdio MCP support can discover the tools and their schemas and call
them. An application without MCP support can use the HTTP contract instead.
No particular AI model, vendor account, API key, or paid service is required.

This does not put an AI model in the workbench or make every AI website able to
reach your computer. The AI application's tool runner must be able to launch a
local Python process and reach your local API. Remote-only clients need their own
supported local execution route. There is no hosted MCP endpoint, public tunnel,
authentication service, or automatic client setup here.

## Start the API and connect a client

Use Python 3.12 and the repository virtual environment. From the repository root:

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements-mcp-lock.txt
PYTHONPATH=backend uvicorn api.main:app --host 127.0.0.1 --port 8000 --workers 1
```

The optional MCP lock includes the unchanged backend lock. The ordinary UI and
HTTP example still work without installing MCP. The adapter uses official Python
SDK `mcp==2.3.0`; its dependencies are pinned separately, without upgrading the
existing FastAPI, Starlette, or Pydantic pins.

Configure your MCP host to start this command in another process:

```sh
/path/to/rcwa/.venv/bin/python -m mcp_adapter.server --api-url http://127.0.0.1:8000
```

Set `PYTHONPATH` to `/path/to/rcwa/backend`. Use actual absolute paths. Many hosts
accept a configuration like this; the surrounding settings format varies:

```json
{
  "mcpServers": {
    "rcwa-workbench": {
      "command": "/path/to/rcwa/.venv/bin/python",
      "args": ["-m", "mcp_adapter.server", "--api-url", "http://127.0.0.1:8000"],
      "env": {"PYTHONPATH": "/path/to/rcwa/backend"}
    }
  }
}
```

The launcher uses the official SDK’s cross-platform stdio implementation.
Linux subprocess operation is tested locally. A dedicated Windows CI job checks
a real SDK client, adapter subprocess and HTTP API; Windows verification is
pending until that job passes. Individual AI applications are not certified. Do not run the
adapter as a web server. Stdin/stdout are its protocol connection, so it waits
quietly when started directly in a terminal. Diagnostics go to stderr.

### Windows PowerShell

From the repository root, start the same local API with:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-mcp-lock.txt
$env:PYTHONPATH = (Resolve-Path backend).Path
.\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000 --workers 1
```

For the MCP host, use the Windows executable and escaped absolute paths:

```json
{
  "mcpServers": {
    "rcwa-workbench": {
      "command": "C:\\path\\rcwa\\.venv\\Scripts\\python.exe",
      "args": ["-m", "mcp_adapter.server", "--api-url", "http://127.0.0.1:8000"],
      "env": {"PYTHONPATH": "C:\\path\\rcwa\\backend"}
    }
  }
}
```

Replace these example paths; no software is installed on your PC by this guide.
The optional lock pins the SDK's Windows-only `pywin32` dependency too.

## Available tools

| Tool | Arguments | What it returns or does |
| --- | --- | --- |
| `rcwa_capabilities` | `{}` | Backend physics, engine availability/version, units, limits and restrictions |
| `rcwa_example` | `{}` or `{"example":"circular_hole_2d"}` | Legacy 1D default or explicit current circular 1.2 input; synthetic constants, no spectra |
| `rcwa_validate` | `{"project": Project}` | Normalized project, input hash, admissibility and diagnostics; no numerical job |
| `rcwa_preview_changes` | `{"base_project": Project, "changes": {"cd_nm": 140}}` | Versioned geometry proposal, typed diff and candidate preflight diagnostics; read-only, no solve, storage or apply |
| `rcwa_preview_stack_changes` | `{"base_project": Project, "changes": {"layers": [Layer, ...]}}` | Read-only atomic stack proposal 1.1; common period and/or complete 1–8 layer replacement, bounded summary diff |
| `rcwa_submit` | `{"request": {"kind": "forward", "project": Project}}` | Starts one bounded job; returns a temporary job ID and status |
| `rcwa_get_job` | `{"job_id": "...", "view":"summary"}` | Bounded status/totals/warnings; omit `view` for the unchanged full result |
| `rcwa_cancel_job` | `{"job_id": "..."}` | Cancels that running API job; safe to repeat |
| `rcwa_save_snapshot` | `{"job_id": "...", "view":"receipt"}` | Saves the exact full server-owned input/result and returns a bounded durable receipt; omit `view` for the full snapshot |
| `rcwa_get_snapshot` | `{"snapshot_id": "...", "view":"summary"}` | Bounded durable identity/provenance/totals; omit `view` for the full saved project/result |

`tools/list` publishes nested JSON Schemas generated from the same runtime
Pydantic models used by the API. Unknown fields are forbidden. Tool arguments do
not accept URLs, headers, paths, code, replacement results, or claimed provenance.
Job and snapshot IDs accept only 1–100 ASCII letters, digits, underscores or
hyphens. The backend capability response describes the whole backend, including
operations beyond these ten tools; the MCP list is the exposed subset.

`rcwa_submit` also accepts the existing synthetic-fit request:

```json
{
  "request": {
    "kind": "fit",
    "project": {},
    "fit": {"target_cd_nm": 180, "lower_cd_nm": 40, "upper_cd_nm": 360}
  }
}
```

An empty Project uses the API model's defaults. For an actual study, start from
`rcwa_example` and inspect its settings rather than relying on defaults. Synthetic
fit requires exactly one rectangular layer and is a distinct CD-recovery demonstration, not a general design optimizer or
measured-data inversion. Its result has its own type and cannot be saved with
`rcwa_save_snapshot`. The forward workflow is the durable-snapshot workflow.

## A bounded workflow for any tool-capable AI

1. Read capabilities and an explicit example. Use `rcwa_example` with
   `{"example":"circular_hole_2d"}` for the current circular 1.2 input. The
   no-argument call still returns legacy 1D. Explain the supported physical model
   and agree an objective, a finite candidate budget, and a stopping condition.
2. Validate each project. Check `valid` and every diagnostic before submission.
3. Submit one job. Record its returned ID. Poll `rcwa_get_job` with
   `{"job_id":"...","view":"summary"}` and backoff, for
   example 0.1, 0.2, 0.5, then 1–2 seconds, within your own overall deadline.
4. Check `kind` and `status`. Only a `succeeded` forward job contains the forward
   `result_summary` to compare. Report failures and warnings; inspect the full
   warnings first if `warnings_omitted_count` is nonzero. Use `rcwa_cancel_job` to
   stop known jobs that are no longer wanted.
5. Save with `rcwa_save_snapshot({"job_id":"...","view":"receipt"})`.
   Keep its durable `id` and `input_hash`, then reload using
   `rcwa_get_snapshot({"snapshot_id":"...","view":"summary"})`.
   Repeated saves return the same ID and the full input/result remains stored.

The [HTTP example](agent-api.md) provides a complete finite-candidate experiment
with reports and an export. MCP adds no hidden loop, optimizer, or unlimited
trial policy. The calling application owns approval UI, budgets, polling,
interpretation, and any model usage costs. Tool annotations describe side effects;
they do not authorize a client to run a calculation or save without its user's
required approval. Submission is explicitly non-idempotent; cancellation is
marked destructive, and snapshot save is an idempotent write.

The workbench UI's **Saved projects** list can open these same snapshots. The
public static preview is still precomputed and makes no live API requests.

## Compact results and material labels

The forward `result_summary` is explicitly tagged
`summary_schema_version: "rcwa-forward-summary/1.0"`. It copies **every** wavelength
and polarization's total `R`, `T`, `R_specular`, `T_specular`, and `A_balance`
without rounding, interpolation, sampling or recomputation. It retains the
source result version and the result's input hash when present (required for
1.2). It omits order arrays, the complete input and full result metadata.
A synthetic-fit job has a separate `rcwa-fit-summary/1.0` projection, with fit
status, CD/RMSE and target/prediction totals; full optimizer diagnostics remain
in the full result. A summary is not a full result or an importable project file.

Each summary/receipt envelope is bounded to 128,000 UTF-8 JSON bytes before MCP's
version-specific encoding. Warnings preserve complete messages in order, up to
64 entries and 16,000 UTF-8 JSON bytes per warning list. No warning is shortened.
`warnings_omitted_count` explicitly counts remaining messages; if it is nonzero,
read all original warnings from the full result before interpreting the totals.
All normal computed warnings fit. Unusual legacy records that cannot form a
supported bounded projection fail explicitly with `summary_unavailable` instead
of returning invented or silently truncated powers. Snapshot provenance is
unchanged: an unverified import stays unverified. Hashes identify inputs; they
do not certify physics or sign a snapshot.

For a lightweight tool-connection test, copy the explicit circular example,
set wavelengths to `[650.0]` and both integer harmonic settings to `1`, and run
one forward job. This changes the input and is only a contract smoke test; it
is not the archived H5 spectrum or a convergence test. A full circle example
retains its approved H5 settings. Every actual calculation remains explicit.

Material `name` is a display label, never a database lookup. For example,
`{"name":"Silicon"}` is accepted for compatibility but defaults to `n=1`, `k=0`;
it is **not** silicon optical data. `rcwa_validate` returns an actionable
`material_name_only` warning when the current request supplied a constant
material name and omitted both `n` and `k`. Supply explicit optical constants or
a supported tabulated material and inspect the returned normalized project.
Already normalized historical inputs have explicit constants and are not
retroactively flagged. This diagnostic changes neither normalization nor hashes.

## Review geometry without running a calculation

`rcwa_preview_changes` previews an explicit caller-specified change; it does not
generate an AI design or predict an improvement. It is marked read-only and
idempotent even though the shared HTTP route uses POST.

1. Export the current workbench input. Give its Project object (the `project`
   member of a Project/result export) to the tool as `base_project`.
2. Supply a bounded `changes` object with one or more finite numeric
   `period_nm`, `cd_nm`, or `thickness_nm` values. No materials, illumination,
   solver settings, generic paths, code, nulls, booleans or numeric strings are
   accepted. All provided dimensions are applied atomically before validating
   the candidate, including the CD-at-most-period constraint.
3. Inspect the returned `rcwa-change-proposal/1.0` envelope, complete before/after
   Projects, deterministic `diff`, `valid`, and all diagnostics. The diff uses
   `field`, `before`, `after`, in period/CD/thickness order, with no equal-value
   entries. `diff: []` is a no-op. `valid: false` is a completed preview with
   candidate preflight errors, not a successful calculation.
4. Have your tool client save only the returned JSON envelope
   (`structuredContent`, or the identical JSON text content) as a UTF-8 `.json`
   file. Do not include the MCP `content`/`isError` wrapper. The MCP adapter itself
   has no file-writing tool. Proposal files imported into the workbench are limited to
   8 MB; HTTP requests remain limited to 2 MB.
5. Use **Import JSON** to review that file in the workbench, then explicitly
   Apply or cancel. Apply is available only for a nonempty applicable proposal
   whose complete base still matches the editor; neither action launches a
   calculation. A stale proposal needs a new preview from the current export.

For example, the default geometry permits this combined change:

```json
{
  "base_project": {},
  "changes": {"period_nm": 100, "cd_nm": 90}
}
```

`{}` in this example means default Project values, not the user's current editor
state. The [HTTP preview contract](agent-api.md#review-a-caller-specified-geometry-change)
documents the exact envelope and bounds. Preview does not require a working
numerical engine. It creates no job, persistent proposal, result or provenance.
The browser revalidates imported files, reconstructs their geometry and diff,
and treats supplied hashes as informational. A file cannot assert a trusted
server origin. This explicit tool-result-to-file-to-import workflow does not
imply a universal AI-client integration or a live chat connection.

## Review a stack without running a calculation

`rcwa_preview_stack_changes` calls only `/api/stack-change-preview`. Its strict
request is `{ "base_project": Project, "changes": { "period_nm": 390,
"layers": [...] } }`; either change key may be omitted, but at least one is
required. `layers` replaces the complete top-to-bottom 1–8 layer list atomically.
The candidate uses Project schema 1.1, with any legacy promotion shown explicitly.
There are no arbitrary paths, IDs, hidden edits or automatic application.

The returned `rcwa-change-proposal/1.1` envelope includes exact base/candidate
Projects, both hashes, a deterministic bounded typed diff, indexed preflight
diagnostics and `valid`. Material table diffs use count/range/source/checksum
summaries instead of thousands of row edits. Exact table arrays remain in the
Project data. See [the precise HTTP stack contract](agent-api.md#review-an-atomic-stack-change)
for field names, order and checksum encoding.

The adapter reconstructs the entire expected response, including candidate,
hashes, diff and diagnostics, and rejects unrelated or altered responses.
Neither tool preview inspects the engine, submits jobs, saves data or applies
inputs. Use the same explicit tool-result-to-JSON-file-to-import review flow as
legacy proposals. Proposal responses/import files allow 8 MB; tool arguments
and HTTP request bodies still allow only 2 MB. Oversize errors are explicit.

## Results, errors and provenance

Successful tool results contain API JSON in `structuredContent` and the same
JSON in a text content block for compatible clients. Validation also uses the
shared request-only material diagnostic before omitted fields lose their meaning
in the adapter's normalized HTTP request. Response shapes
are checked strictly against shared API models before success is reported.
Tool inputs also use strict types; numeric strings and booleans are not numbers. Returned job
and snapshot identities are checked against requested IDs. The adapter does not
compute physics or write a database directly.
Preview responses are additionally bound to the exact requested normalized base
and patch: the adapter reconstructs the candidate, hashes, diff and deterministic
diagnostics. An unrelated but schema-valid preview, missing canonical Project
fields, extra edits, or altered diagnostics is rejected with
`invalid_api_response`.

An HTTP/API failure is a tool result with `isError: true`, the original API error
code/message/diagnostics, and `http_status`. Adapter errors use stable codes such
as `invalid_arguments`, `request_too_large`, `adapter_capacity`,
`api_unavailable`, `invalid_api_response`, `response_too_large`, or `outcome_unknown`. An unknown tool
name is a JSON-RPC invalid-parameters error (`-32602`). The official SDK owns protocol parsing and lifecycle. Malformed raw stdio is
outside the supported trusted-host contract; no custom parser is provided.

A successful poll can truthfully report `status: "failed"` or `"cancelled"`;
that is a successful status lookup, not a successful calculation. Similarly,
`valid: false` is a completed admissibility check. Do not infer physics success
from MCP's `isError: false`. Preserve `error_code`, diagnostics and warnings.

There are no automatic HTTP retries. If a write loses its response, times out,
or returns an untrustworthy response, the tool reports `outcome_unknown: true`.
The write may already have happened. Do not blindly resubmit a calculation.
A returned HTTP 5xx on a mutation is conservatively treated as uncertain too.
An MCP request cancellation or broken stdio connection may prevent even this
error from reaching the client; treat an interrupted submission as uncertain.
Validation, geometry-preview and stack-preview POSTs are read-only. Transport failure for them
does not claim an unknown mutation outcome; the adapter still performs no
automatic retry.

Only the API can create server-computed provenance. The save tool accepts a job
ID, never a replacement project/result. Imported records and old records without server provenance keep
`source: "unverified_import"`. Known historical server-computed snapshots keep
their original version and server-computed provenance; they are not downgraded. Server provenance binds the exact submitted input
and result but is not a cryptographic signature or proof of convergence. Read
[the HTTP provenance contract](agent-api.md#identity-lifetime-and-provenance) and
[the physical conventions](physics.md) before interpreting a result.

## Local safety and lifetime

- No listener is opened by MCP. The separately started API must remain loopback
  only, unauthenticated, local, and single-worker.
- `--api-url` is startup-only and accepts HTTP on `127.0.0.1`, `::1`, or `localhost`.
  `localhost` is pinned to `127.0.0.1` without DNS. Userinfo, non-root paths,
  queries, fragments, whitespace, and invalid ports are rejected.
- Environment proxies and redirects are disabled. Only fixed API routes can be
  called. Compressed HTTP responses are rejected. There are no shell, filesystem,
  arbitrary-code, or arbitrary-network tools.
- The local MCP host is trusted to generate valid protocol messages, bound its
  requests, consume responses, and manage the adapter process. This is not a
  sandbox against a hostile local host or a public MCP service.
- Tool arguments are capped at 2 MB after SDK parsing, HTTP bodies at 2 MB, and
  HTTP responses at 8 MB. Nonfinite values are rejected. These are per-tool/HTTP
  bounds, not raw stdio frame, response-backlog, or process-memory limits.
- At most four HTTP calls may be active per adapter. Excess calls fail immediately
  with `adapter_capacity`, with no waiting queue. The backend separately limits
  active numerical jobs to two, retained jobs to 100, and each job to 120 seconds.
- `--request-timeout` defaults to 10 seconds and must be greater than zero and no
  more than 30. It bounds each asynchronous HTTP exchange with a wall-clock cancel
  scope, as well as socket inactivity. This is not a hard process-wide real-time
  guarantee: local scheduling and bounded synchronous JSON/schema work add time.
- The host owns standard stdio shutdown: close stdin, wait for exit, and terminate
  the adapter process if necessary. The official client manages this lifecycle.
  There is no hard graceful-shutdown guarantee for blocked or abandoned pipes.
  Adapter exit or MCP request cancellation does not stop the separately started
  API or its jobs. Use the explicit cancel tool for a known job ID; otherwise the
  API's own calculation timeout remains the limit.

## Verification

Install the optional lock, then run:

```sh
.venv/bin/ruff check backend
OPENBLAS_NUM_THREADS=1 .venv/bin/pytest backend/tests/test_change_preview.py backend/tests/test_mcp_adapter.py backend/tests/test_mcp_change_preview.py backend/tests/test_mcp_protocol.py -q
```

Tests use the official SDK Client over a real stdio subprocess, then real HTTP
against an isolated local API and SQLite database. The Windows CI job runs
discovery, example, validation, API-down and normal process-teardown checks;
Linux CI additionally runs the full numerical solve/snapshot workflow and the
compact circle H1 run → inspect → receipt → reload journey. Archived rectangular
and circular max-resource snapshots exercise compact transport without an H5
recalculation; their original generation evidence is unchanged. They cover legacy
initialize/list/call (`2025-11-25`) and current SDK discovery (`2026-07-28`), a real
single-layer and mixed-stack forward solves, exact snapshot reload, idempotence, cancellation, API-down
errors, and real read-only geometry/stack previews. Genuine historical snapshot fixtures verify preserved result-1.0 provenance while current jobs and saves require result-1.1. Preview boundary coverage includes
strict finite patches, atomic cross-field validation, shared browser/server cases,
engine independence, no storage or job effects, and complete response binding. Boundary tests cover generated schemas, unsafe targets/IDs, extra fields,
finite JSON, per-tool/HTTP byte limits, deadlines, HTTP admission limits,
failed/cancelled status, provenance preservation and ordinary SDK process cleanup. The normal backend CI installs the
optional lock so these tests cannot silently skip there. Without MCP installed,
the optional MCP test modules are explicitly skipped by the ordinary backend suite.

This is protocol integration evidence, not a claim that every vendor's AI host
has been tested. References: [official Python SDK](https://github.com/modelcontextprotocol/python-sdk),
[SDK client lifecycle](https://py.sdk.modelcontextprotocol.io/client/), and
[MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## Explicit 1.2 and bounded stdio output

The existing forward/validate/job/snapshot tools share the API's explicit 1.2
contracts, including the explicit `circular_hole_2d` geometry and its
`diameter_nm`, hole-fill `material`, and host `background`. They do not implement
another solver. Read the geometry list in the version-specific capability
profile before submitting a circle. The no-argument example remains legacy;
`example="circular_hole_2d"` explicitly selects the current 1.2 input. Fitting
and change-preview tools remain legacy-only; inspect version-specific capability
profiles before using an operation. Harmonics use
strict integer JSON tokens, so `3.0` is rejected even though JSON Schema's integer
semantics treat it as integral.

The stdio adapter accepts protocol IDs of at most 1024 serialized UTF-8 JSON
bytes, including quoting/escaping and integer digit count. Unsupported IDs close
the stdio connection before a handler or HTTP operation runs; they are never
rewritten or truncated. Start a fresh client with an ordinary ID afterward.

The output cap is 8,000,000 bytes for the actual UTF-8 JSON-RPC line, including
the real request ID, the SDK's version-specific fields/metadata, duplicate text
and structured result data, escape expansion and the trailing newline. The
post-serialization check returns a small structured `response_too_large` error,
not truncated physics data. For a mutation it sets `outcome_unknown` and says not
to resubmit blindly. The tool cannot return the blocked complete payload.

A large snapshot can be about 4.23 MB as HTTP JSON but about 8.98 MB as the MCP
line, so these limits intentionally differ. Routine MCP-only workflows use the
opt-in summary/receipt views and do not need an HTTP escape. After an oversized
full snapshot-save response, call `rcwa_save_snapshot` with the **same job ID**
and `view="receipt"` to recover its durable ID and totals; do not launch a new
calculation. Alternatively, the existing HTTP `POST /api/snapshots` with that
job ID retrieves the idempotently saved full snapshot. Known snapshots/jobs can
be read through `view="summary"`, or in full through the HTTP GET route in the
error. No compact view claims to contain the omitted full data.
That ID-only save recovery requires the volatile job to remain retained. After
eviction or restart, inspect existing `GET /api/projects` summaries (latest 100),
match `provenance.job_id`, and read the saved snapshot ID with
`GET /api/projects/{id}`. Retain snapshot IDs for older records. These are HTTP
recovery instructions for discovering a lost ID. An MCP-only client cannot fetch
a full payload that its response cap blocks; it can read its explicit summary
when it retained the snapshot ID.
No new pagination/export service or automatic retry is introduced. The 2 MB
request, 8 MB full-response and 1024-byte protocol-ID limits are unchanged.

The pinned SDK's standard input reader shields blocking reads, which can stall
connection closure while a client leaves stdin open. A small input wrapper makes
that read cancellable while retaining the SDK's private descriptor ownership and
diversion helpers, JSON/MCP parser and writer. This dependency is covered by real
process tests and must be rechecked when upgrading the SDK; no alternate protocol
or numerical pipeline is used.

Local MCP argument errors use the same 50-diagnostic and 512-byte message/location
policy as HTTP, including structured preflight expansion. The error JSON payload
is below 64 KB; MCP's duplicated text/structured representation can be larger
(about 98 KB in the adversarial fixture) and is still checked against the complete
8 MB line cap. Large input text is not echoed without bounds.
