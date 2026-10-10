"""Run with PYTHONPATH=backend python -m mcp_adapter.server. Stdio only."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from typing import Annotated

import anyio
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.shared.exceptions import MCPError
from mcp.types import (
    INVALID_PARAMS, CallToolResult,
    ListToolsResult, TextContent, Tool, ToolAnnotations,
)
from pydantic import Field, TypeAdapter, ValidationError

from api.contracts import (
    Capabilities, ChangePreviewRequest, ChangeProposal, ErrorResponse, JobRequest, JobResponse,
    SavedProject, ServerSnapshot, StoredServerSnapshot, StackChangePreviewRequest, StackChangeProposal,
    ValidationResponse,
)
from api.change_preview import validate_proposal_binding
from api.stack_change_preview import validate_stack_proposal_binding
from rcwa_core.schemas import Project, StrictModel
from .client import AdapterError, ID_PATTERN, LocalAPI, MAX_REQUEST_BYTES



class Empty(StrictModel):
    pass


class ProjectArguments(StrictModel):
    project: Project


class SubmitArguments(StrictModel):
    request: JobRequest


Identifier = Annotated[str, Field(min_length=1, max_length=100, pattern=ID_PATTERN)]


class JobArguments(StrictModel):
    job_id: Identifier


class SnapshotArguments(StrictModel):
    snapshot_id: Identifier


class ToolErrorResponse(ErrorResponse):
    http_status: int | None = None
    outcome_unknown: bool = False


@dataclass(frozen=True)
class Operation:
    name: str
    description: str
    arguments: type[StrictModel]
    response: type[StrictModel]
    method: str
    path: str
    body_field: str | None = None
    read_only: bool = True
    destructive: bool = False
    idempotent: bool = True

    def tool(self):
        output = TypeAdapter(self.response | ToolErrorResponse).json_schema()
        output["type"] = "object"
        return Tool(
            name=self.name, description=self.description,
            input_schema=self.arguments.model_json_schema(), output_schema=output,
            annotations=ToolAnnotations(
                read_only_hint=self.read_only, destructive_hint=self.destructive,
                idempotent_hint=self.idempotent, open_world_hint=False,
            ),
        )


OPERATIONS = [
    Operation("rcwa_capabilities", "Read backend physics, units, limits, engine versions and restrictions. "
              "Backend operations include features beyond this MCP tool subset.", Empty, Capabilities,
              "GET", "/api/capabilities"),
    Operation("rcwa_example", "Read the canonical project. Its optical constants are synthetic.",
              Empty, Project, "GET", "/api/example"),
    Operation("rcwa_validate", "Check project admissibility without solving. Inspect valid and diagnostics; "
              "validation does not certify numerical success or convergence.",
              ProjectArguments, ValidationResponse, "POST", "/api/validate", "project"),
    Operation("rcwa_preview_changes", "Preview a caller-specified bounded geometry change to period, CD or thickness. "
              "Returns a reviewable rcwa-change-proposal/1.0 JSON envelope, deterministic diff and preflight diagnostics. "
              "Read-only: does not generate an AI design, solve physics, predict improvement, store or apply edits. "
              "Inspect valid and diagnostics; an empty diff is a no-op. Save the returned JSON with your own client "
              "and use the workbench Import JSON action to review it before explicitly applying.",
              ChangePreviewRequest, ChangeProposal, "POST", "/api/change-preview"),
    Operation("rcwa_preview_stack_changes", "Preview a bounded atomic change of common period and/or the complete "
              "top-to-bottom finite layer list. Returns rcwa-change-proposal/1.1, exact base/candidate projects, "
              "bounded summarized diff and preflight diagnostics. Candidate uses project schema 1.1. "
              "Read-only: no solve, job, storage, application of edits, or predicted improvement. "
              "Import the returned JSON into the workbench for explicit review and apply; maximum file size 8 MB.",
              StackChangePreviewRequest, StackChangeProposal, "POST", "/api/stack-change-preview"),
    Operation("rcwa_submit", "Start one bounded forward calculation or synthetic CD-recovery fit. "
              "Synthetic fit requires exactly one rectangle; it is not measured-data inversion or design optimization. "
              "Non-idempotent: never blindly repeat a submission with an uncertain outcome. "
              "Use rcwa_get_job to poll; check kind and status before using result.",
              SubmitArguments, JobResponse, "POST", "/api/jobs", "request", read_only=False, idempotent=False),
    Operation("rcwa_get_job", "Read job status and result. Jobs are temporary and disappear on restart or eviction. "
              "A successful tool call can report a failed/cancelled calculation; inspect status and error_code. "
              "Poll with backoff, not a tight loop.", JobArguments, JobResponse, "GET", "/api/jobs/{job_id}"),
    Operation("rcwa_cancel_job", "Cancel a known running API job. Repeated cancellation is safe. "
              "Closing this MCP adapter or cancelling an MCP request does not cancel API jobs.",
              JobArguments, JobResponse, "DELETE", "/api/jobs/{job_id}", read_only=False, destructive=True),
    Operation("rcwa_save_snapshot", "Persist the exact server-owned input/result of a succeeded forward job. "
              "Accepts only its job ID; repeated saves return the same durable snapshot. "
              "Save before the temporary job is lost.", JobArguments, ServerSnapshot,
              "POST", "/api/snapshots", read_only=False),
    Operation("rcwa_get_snapshot", "Read a durable saved project/result and provenance. "
              "Check provenance.source: imports stay unverified_import; known historical server snapshots preserve their versions and provenance. "
              "A local server_computed label is not a cryptographic signature or physics certification.",
              SnapshotArguments, SavedProject, "GET", "/api/projects/{snapshot_id}"),
]
BY_NAME = {operation.name: operation for operation in OPERATIONS}


def result(payload, *, error=False):
    return CallToolResult(
        structured_content=payload, is_error=error,
        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False, allow_nan=False))],
    )


def invalid_arguments(exc):
    diagnostics = []
    for item in exc.errors()[:50]:
        structured = getattr(item.get("ctx", {}).get("error"), "diagnostics", None)
        if structured:
            diagnostics.extend(d.model_dump() for d in structured)
        else:
            diagnostics.append({"code": "invalid_arguments", "severity": "error",
                                "location": list(item["loc"]), "message": item["msg"]})
    message = "Tool arguments do not match the advertised schema"
    return {"detail": message, "error": {"code": "invalid_arguments", "message": message,
                                         "diagnostics": diagnostics}}


def create_server(api: LocalAPI):
    async def list_tools(ctx, params):
        return ListToolsResult(tools=[operation.tool() for operation in OPERATIONS])

    async def call_tool(ctx, params):
        operation = BY_NAME.get(params.name)
        if operation is None:
            raise MCPError(INVALID_PARAMS, "This tool is not exposed by RCWA Workbench")
        try:
            arguments = params.arguments if params.arguments is not None else {}
            encoded = json.dumps(arguments, allow_nan=False, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(encoded) > MAX_REQUEST_BYTES:
                raise AdapterError("request_too_large", "Tool arguments exceed the 2 MB limit")
            try:
                parsed = operation.arguments.model_validate(arguments, strict=True)
            except ValidationError as exc:
                return result(invalid_arguments(exc), error=True)
            values = parsed.model_dump()
            path = operation.path.format(**values)
            body = values[operation.body_field] if operation.body_field else (
                values if operation.name in {"rcwa_save_snapshot", "rcwa_preview_changes", "rcwa_preview_stack_changes"} else None
            )
            payload = await api.request(operation.method, path, body)
            try:
                operation.response.model_validate(payload, strict=True)
                if operation.name == "rcwa_preview_changes":
                    validate_proposal_binding(payload, parsed)
                if operation.name == "rcwa_preview_stack_changes":
                    validate_stack_proposal_binding(payload, parsed)
                if operation.name == "rcwa_submit" and payload["kind"] != values["request"]["kind"]:
                    raise ValueError("API returned the wrong job kind")
                if operation.name == "rcwa_get_snapshot" and payload["provenance"]["source"] == "server_computed":
                    StoredServerSnapshot.model_validate(payload, strict=True)
                if operation.name == "rcwa_save_snapshot" and payload["provenance"]["source"] != "server_computed":
                    raise ValueError("Snapshot save must return server-owned provenance")
                if operation.arguments is JobArguments:
                    actual = payload["provenance"]["job_id"] if operation.name == "rcwa_save_snapshot" else payload["id"]
                    if actual != values["job_id"]:
                        raise ValueError("API returned the wrong job identity")
                if operation.arguments is SnapshotArguments and payload["id"] != values["snapshot_id"]:
                    raise ValueError("API returned the wrong snapshot identity")
            except (ValidationError, ValueError, KeyError) as exc:
                mutation = operation.name in {"rcwa_submit", "rcwa_cancel_job", "rcwa_save_snapshot"}
                raise AdapterError("invalid_api_response", "API returned an incompatible response; do not blindly "
                                   "repeat a mutation", outcome_unknown=mutation) from exc
            return result(payload)
        except AdapterError as exc:
            return result(exc.payload, error=True)
        except (ValueError, TypeError, RecursionError):
            return result(AdapterError("invalid_arguments", "Arguments must be finite JSON").payload, error=True)

    return Server(
        "RCWA Workbench", version="0.1.0", on_list_tools=list_tools, on_call_tool=call_tool,
        instructions="Local RCWA tools backed by one HTTP API. Read rcwa_capabilities first, validate before submit, "
        "and inspect diagnostics, status and warnings. Poll with backoff. Use explicit bounded experiment budgets. "
        "No global-optimum, convergence, calibration or manufacturing claims follow from a successful run. "
        "Ask the user before computations or saves when the host's policy requires it.",
    )


async def run(options):
    api = LocalAPI(options.api_url, options.request_timeout)
    try:
        server = create_server(api)
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())
    finally:
        await api.aclose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    parser.add_argument("--request-timeout", type=float, default=10.0)
    options = parser.parse_args()
    try:
        anyio.run(run, options)
    except ValueError as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
