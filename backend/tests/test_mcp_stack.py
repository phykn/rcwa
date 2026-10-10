"""MCP stack discovery, input/response binding, historical readers and byte bounds."""

from copy import deepcopy
import json
from pathlib import Path

import httpx
import pytest

pytest.importorskip("mcp")
from mcp import Client

from api.contracts import StackChangePreviewRequest
from api.stack_change_preview import preview_stack_changes
from mcp_adapter.client import AdapterError, LocalAPI, MAX_RESPONSE_BYTES
from mcp_adapter.server import create_server, OPERATIONS
from rcwa_core.schemas import Project

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def arguments():
    project = Project().model_dump()
    return {"base_project": project, "changes": {"layers": [project["layers"][0], {
        "geometry": "homogeneous", "name": "Lower slab", "thickness_nm": 100.0, "material": {"n": 1.8},
    }]}}


def proposal(args):
    return preview_stack_changes(StackChangePreviewRequest.model_validate(args)).model_dump()


def test_stack_tool_is_strict_bounded_readonly():
    tool = next(operation.tool() for operation in OPERATIONS if operation.name == "rcwa_preview_stack_changes")
    assert tool.annotations.read_only_hint and tool.annotations.idempotent_hint
    assert not tool.annotations.destructive_hint and not tool.annotations.open_world_hint
    patch = tool.input_schema["$defs"]["StackChanges"]
    assert patch["additionalProperties"] is False
    assert set(patch["properties"]) == {"layers", "period_nm"}
    assert patch["properties"]["layers"]["maxItems"] == 8
    assert tool.input_schema["properties"]["changes"]["minProperties"] == 1


@pytest.mark.anyio
async def test_stack_forwarded_normalized_and_unchanged():
    args = arguments()
    expected = proposal(args)
    sent = []
    def respond(request):
        sent.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(200, json=expected)
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_preview_stack_changes", args)
            assert not response.is_error
            assert response.structured_content == expected == json.loads(response.content[0].text)
        assert sent == [("POST", "/api/stack-change-preview", StackChangePreviewRequest.model_validate(args).model_dump())]
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("change", [
    lambda p: p.update(schema_version="rcwa-change-proposal/1.0"), lambda p: p.pop("candidate_input_hash"),
    lambda p: p.update(extra=True), lambda p: p.update(valid=False),
    lambda p: p.update(base_input_hash="0" * 64), lambda p: p.update(candidate_input_hash="0" * 64),
    lambda p: p["base_project"].update(name="Unrelated canonical input"),
    lambda p: p["candidate_project"]["layers"][1].update(thickness_nm=101.0),
    lambda p: p["candidate_project"]["layers"][1].pop("name"),
    lambda p: p["candidate_project"]["layers"][1].update(cd_nm=1),
    lambda p: p["changes"].update(period_nm=390.0), lambda p: p["diff"].pop(),
    lambda p: p["diff"][-1]["after"]["material"].update(n=2.5),
    lambda p: p["diagnostics"].append({"code": "fake", "severity": "error", "location": [], "message": "Forged"}),
])
async def test_stack_response_forgery_is_not_success(change):
    args = arguments()
    payload = proposal(args)
    change(payload)
    api = LocalAPI(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_preview_stack_changes", args)
            assert response.is_error and response.structured_content["error"]["code"] == "invalid_api_response"
            assert not response.structured_content.get("outcome_unknown", False)
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_invalid_stack_arguments_never_reach_http():
    calls = []
    api = LocalAPI(transport=httpx.MockTransport(lambda r: calls.append(r)))
    try:
        async with Client(create_server(api)) as client:
            for change in ({}, {"layers": []}, {"layers": None}, {"period_nm": True}, {"period_nm": "400"},
                           {"layers": [{"geometry": "unknown"}]}, {"layers": [{"geometry": "homogeneous", "cd_nm": 1}]},
                           {"layers": [{"geometry": "homogeneous", "material": {"n": "2"}}]}, {"path": "layers"}):
                response = await client.call_tool("rcwa_preview_stack_changes", {"base_project": {}, "changes": change})
                assert response.is_error and response.structured_content["error"]["code"] == "invalid_arguments"
            huge = {"base_project": {}, "changes": {"period_nm": 400}, "padding": "x" * 2_000_000}
            response = await client.call_tool("rcwa_preview_stack_changes", huge)
            assert response.is_error and response.structured_content["error"]["code"] == "request_too_large"
        assert not calls
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_known_historical_snapshot_read_but_never_current_worker_or_save_result():
    old = json.loads((FIXTURES / "legacy_server_snapshot.json").read_text())
    payload = deepcopy(old)
    api = LocalAPI(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_get_snapshot", {"snapshot_id": old["id"]})
            assert not response.is_error and response.structured_content == old
            for mutate in (lambda p: p["result"].update(schema_version="9.0"),
                           lambda p: p["result"]["metadata"].pop("adapter_version"),
                           lambda p: p["result"]["metadata"].update(layer_count=1)):
                payload = deepcopy(old)
                mutate(payload)
                response = await client.call_tool("rcwa_get_snapshot", {"snapshot_id": old["id"]})
                assert response.is_error and response.structured_content["error"]["code"] == "invalid_api_response"
            payload = deepcopy(old)
            response = await client.call_tool("rcwa_save_snapshot", {"job_id": old["provenance"]["job_id"]})
            assert response.is_error and response.structured_content["outcome_unknown"]
            payload = {"id": "current", "kind": "forward", "status": "succeeded", "created_at": "now",
                       "completed_at": "now", "input_hash": old["provenance"]["input_hash"], "result": old["result"],
                       "error": None, "error_code": None}
            response = await client.call_tool("rcwa_get_job", {"job_id": "current"})
            assert response.is_error and response.structured_content["error"]["code"] == "invalid_api_response"
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["oversize", "unavailable"])
async def test_stack_transport_error_is_explicit_and_not_a_mutation(mode):
    if mode == "oversize":
        response = httpx.Response(200, content=b'{"padding":"' + b'x' * MAX_RESPONSE_BYTES + b'"}')
    else:
        response = httpx.Response(503, json={"detail": "Down", "error": {"code": "unavailable", "message": "Down", "diagnostics": []}})
    calls = []
    def respond(request):
        calls.append(request)
        return response
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        with pytest.raises(AdapterError) as caught:
            await api.request("POST", "/api/stack-change-preview", arguments())
        assert caught.value.payload["error"]["code"] == ("response_too_large" if mode == "oversize" else "unavailable")
        assert not caught.value.payload.get("outcome_unknown", False)
        assert len(calls) == 1
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_near_limit_real_stack_proposal_roundtrips_through_mcp():
    from test_stack_api import compact, large_preview_request

    args = large_preview_request()
    expected = proposal(args)
    assert 1_800_000 < len(compact(args)) < 2_000_000
    assert 2_000_000 < len(compact(expected)) < MAX_RESPONSE_BYTES
    sent = []
    def respond(request):
        sent.append(request.content)
        return httpx.Response(200, content=compact(expected))
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_preview_stack_changes", args)
            assert not response.is_error, response
            assert response.structured_content == expected == json.loads(response.content[0].text)
        assert len(sent) == 1 and len(sent[0]) <= 2_000_000
        assert json.loads(sent[0]) == StackChangePreviewRequest.model_validate(args).model_dump()
    finally:
        await api.aclose()
