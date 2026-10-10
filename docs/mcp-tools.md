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
| `rcwa_example` | `{}` | Canonical project with synthetic optical constants |
| `rcwa_validate` | `{"project": Project}` | Normalized project, input hash, admissibility and diagnostics; no numerical job |
| `rcwa_submit` | `{"request": {"kind": "forward", "project": Project}}` | Starts one bounded job; returns a temporary job ID and status |
| `rcwa_get_job` | `{"job_id": "..."}` | Job status, typed result, warnings or failure information |
| `rcwa_cancel_job` | `{"job_id": "..."}` | Cancels that running API job; safe to repeat |
| `rcwa_save_snapshot` | `{"job_id": "..."}` | Saves the exact server-owned input/result of a succeeded forward job |
| `rcwa_get_snapshot` | `{"snapshot_id": "..."}` | Reads a durable saved project/result, including its provenance |

`tools/list` publishes nested JSON Schemas generated from the same runtime
Pydantic models used by the API. Unknown fields are forbidden. Tool arguments do
not accept URLs, headers, paths, code, replacement results, or claimed provenance.
Job and snapshot IDs accept only 1–100 ASCII letters, digits, underscores or
hyphens. The backend capability response describes the whole backend, including
operations beyond these eight tools; the MCP list is the exposed subset.

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
fit is a distinct CD-recovery demonstration, not a general design optimizer or
measured-data inversion. Its result has its own type and cannot be saved with
`rcwa_save_snapshot`. The forward workflow is the durable-snapshot workflow.

## A bounded workflow for any tool-capable AI

1. Read capabilities and example. Explain the supported physical model and agree
   an objective, an explicit finite candidate budget, and a stopping condition.
2. Validate each project. Check `valid` and every diagnostic before submission.
3. Submit one job. Record its returned ID. Poll `rcwa_get_job` with backoff, for
   example 0.1, 0.2, 0.5, then 1–2 seconds, within your own overall deadline.
4. Check `kind` and `status`. Only a `succeeded` forward job contains the forward
   result to compare. Report failures and all warnings. Use `rcwa_cancel_job` to
   stop known jobs that are no longer wanted.
5. Save the selected successful forward job and fetch its durable snapshot.
   Repeated saves of the same successful job return the same snapshot ID.

The [HTTP example](agent-api.md) provides a complete finite-candidate experiment
with reports and an export. MCP adds no hidden loop, optimizer, or unlimited
trial policy. The calling application owns approval UI, budgets, polling,
interpretation, and any model usage costs. Tool annotations describe side effects;
they do not authorize a client to run a calculation or save without its user's
required approval. Submission is explicitly non-idempotent; cancellation is
marked destructive, and snapshot save is an idempotent write.

The workbench UI's **Saved projects** list can open these same snapshots. The
public static preview is still precomputed and makes no live API requests.

## Results, errors and provenance

Successful tool results contain unchanged API JSON in `structuredContent` and
the same JSON in a text content block for compatible clients. Response shapes
are checked strictly against shared API models before success is reported.
Tool inputs also use strict types; numeric strings and booleans are not numbers. Returned job
and snapshot identities are checked against requested IDs. The adapter does not
compute physics or write a database directly.

An HTTP/API failure is a tool result with `isError: true`, the original API error
code/message/diagnostics, and `http_status`. Adapter errors use stable codes such
as `invalid_arguments`, `request_too_large`, `adapter_capacity`,
`api_unavailable`, `invalid_api_response`, or `outcome_unknown`. An unknown tool
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

Only the API can create server-computed provenance. The save tool accepts a job
ID, never a replacement project/result. A fetched legacy or imported record keeps
`source: "unverified_import"`. Server provenance binds the exact submitted input
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
OPENBLAS_NUM_THREADS=1 .venv/bin/pytest backend/tests/test_mcp_adapter.py backend/tests/test_mcp_protocol.py -q
```

Tests use the official SDK Client over a real stdio subprocess, then real HTTP
against an isolated local API and SQLite database. The Windows CI job runs
discovery, example, validation, API-down and normal process-teardown checks;
Linux CI additionally runs the full numerical solve/snapshot workflow. They cover legacy
initialize/list/call (`2025-11-25`) and current SDK discovery (`2026-07-28`), a real
forward solve, exact snapshot reload, idempotence, cancellation, and API-down
errors. Boundary tests cover generated schemas, unsafe targets/IDs, extra fields,
finite JSON, per-tool/HTTP byte limits, deadlines, HTTP admission limits,
failed/cancelled status, provenance preservation and ordinary SDK process cleanup. The normal backend CI installs the
optional lock so these tests cannot silently skip there. Without MCP installed,
these two optional modules are explicitly skipped by the ordinary backend suite.

This is protocol integration evidence, not a claim that every vendor's AI host
has been tested. References: [official Python SDK](https://github.com/modelcontextprotocol/python-sdk),
[SDK client lifecycle](https://py.sdk.modelcontextprotocol.io/client/), and
[MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
