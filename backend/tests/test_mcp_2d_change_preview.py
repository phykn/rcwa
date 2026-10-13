"""MCP discovery, raw proposal binding and bounded 2D dimension transport."""

from copy import deepcopy
import json
from types import SimpleNamespace

import httpx
import pytest

pytest.importorskip("mcp")
from mcp import Client
from mcp.types.methods import serialize_server_result

from api.dimension_change_preview import DimensionChangePreviewRequest, preview_2d_changes
from mcp_adapter.client import AdapterError, LocalAPI, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES
from mcp_adapter.server import (
    MAX_STDIO_RESPONSE_BYTES, OPERATIONS, create_server, result, stdio_response_bytes,
)
from test_2d_change_preview import compact, dense_dimension_arguments, dimension_arguments
import test_mcp_protocol as protocol_tests

real_api = protocol_tests.real_api
call = protocol_tests.call
parameters = protocol_tests.parameters

TOOL = "rcwa_preview_2d_changes"
ROUTE = "/api/2d-change-preview"
VERSIONS = ["2025-11-25", "2026-07-28"]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def proposal(args):
    return preview_2d_changes(DimensionChangePreviewRequest.model_validate(args, strict=True)).model_dump()


def test_dimension_tool_advertises_strict_bounded_readonly_scope():
    tool = next(operation.tool() for operation in OPERATIONS if operation.name == TOOL)
    assert tool.annotations.read_only_hint and tool.annotations.idempotent_hint
    assert not tool.annotations.destructive_hint and not tool.annotations.open_world_hint
    assert "rcwa-change-proposal/1.2" in tool.description
    definitions = tool.input_schema["$defs"]
    patch = definitions["DimensionChanges"]
    assert patch["additionalProperties"] is False
    assert set(patch["properties"]) == {"period_nm", "period_y_nm", "layers"}
    assert patch["properties"]["layers"]["minItems"] == 1
    assert patch["properties"]["layers"]["maxItems"] == 8
    assert patch["properties"]["layers"]["items"]["minProperties"] == 3
    assert tool.input_schema["properties"]["changes"]["minProperties"] == 1
    assert definitions["Project2D"]["properties"]["schema_version"]["const"] == "1.2"
    for name in ("UniformDimensions", "GratingDimensions", "RectangleDimensions", "CircleDimensions"):
        layer = definitions[name]
        assert layer["additionalProperties"] is False
        assert set(layer["required"]) == {"index", "geometry"}
        assert layer["properties"]["index"]["minimum"] == 0
        assert layer["properties"]["index"]["maximum"] == 7
        assert "material" not in layer["properties"] and "background" not in layer["properties"]


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_dimension_tool_roundtrips_normalized_request_and_exact_proposal(mode, monkeypatch):
    args = dimension_arguments()
    args["changes"] = {"period_nm": 610, "layers": [{"index": 1, "geometry": "rectangle_2d", "cd_y_nm": 110}]}
    original = compact(args)
    expected = proposal(args)
    sent = []

    def forbidden(*args, **kwargs):
        pytest.fail("MCP dimension preview must not inspect engines or calculate")

    monkeypatch.setattr("rcwa_core.preflight.engine_info", forbidden)
    monkeypatch.setattr("rcwa_core.project_io.forward_project", forbidden)

    def respond(request):
        sent.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(200, json=expected)

    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api), mode=mode) as client:
            tools = await client.list_tools()
            assert sum(tool.name == TOOL for tool in tools.tools) == 1
            response = await client.call_tool(TOOL, args)
            assert not response.is_error, response
            assert response.structured_content == expected == json.loads(response.content[0].text)
        assert compact(args) == original
        assert sent == [("POST", ROUTE, DimensionChangePreviewRequest.model_validate(args, strict=True).model_dump())]
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("tamper", [
    lambda p: p.update(schema_version="rcwa-change-proposal/1.1"), lambda p: p.pop("candidate_input_hash"),
    lambda p: p.update(extra=True), lambda p: p.update(valid=False),
    lambda p: p.update(base_input_hash="0" * 64), lambda p: p.update(candidate_input_hash="0" * 64),
    lambda p: p["base_project"].update(name="Unrelated normalized input"),
    lambda p: p["base_project"]["ambient"].pop("source"),
    lambda p: p["candidate_project"]["layers"][0].update(diameter_nm=99.0),
    lambda p: p["candidate_project"]["layers"][0].pop("name"),
    lambda p: p["candidate_project"]["ambient"].pop("k"),
    lambda p: p["candidate_project"]["solver"].pop("harmonics_x"),
    lambda p: p["base_project"].update(period_nm=600),
    lambda p: p["candidate_project"].update(period_nm=610),
    lambda p: p["changes"].update(period_nm=610),
    lambda p: p["diff"].pop(), lambda p: p["diff"][0].update(after=610),
    lambda p: p["diagnostics"].append({"code": "fake", "severity": "error", "location": [], "message": "Forged"}),
])
async def test_raw_response_forgery_is_not_a_success(tamper):
    args = dimension_arguments()
    payload = proposal(args)
    tamper(payload)
    api = LocalAPI(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool(TOOL, args)
            assert response.is_error and response.structured_content["error"]["code"] == "invalid_api_response"
            assert not response.structured_content.get("outcome_unknown", False)
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_signed_zero_survives_transport_and_cannot_be_tampered():
    args = dimension_arguments()
    args["base_project"]["layers"][0]["diameter_nm"] = 0.0
    args["changes"] = {"layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": -0.0}]}
    expected = proposal(args)
    payload = deepcopy(expected)
    api = LocalAPI(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=compact(payload))))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool(TOOL, args)
            assert not response.is_error
            assert compact(response.structured_content) == compact(expected)
            payload["candidate_project"]["layers"][0]["diameter_nm"] = 0.0
            assert payload == expected and compact(payload) != compact(expected)
            response = await client.call_tool(TOOL, args)
            assert response.is_error and response.structured_content["error"]["code"] == "invalid_api_response"
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_invalid_changes_and_oversized_requests_never_reach_http():
    calls = []
    api = LocalAPI(transport=httpx.MockTransport(lambda request: calls.append(request)))
    changes = [
        {}, {"period_y_nm": "400"}, {"period_nm": True}, {"layers": []}, {"layers": None},
        {"layers": [{"index": 0, "geometry": "circular_hole_2d"}]},
        {"layers": [{"index": 0.0, "geometry": "circular_hole_2d", "diameter_nm": 40}]},
        {"layers": [{"index": True, "geometry": "circular_hole_2d", "diameter_nm": 40}]},
        {"layers": [{"index": 4, "geometry": "circular_hole_2d", "diameter_nm": 40}]},
        {"layers": [{"index": 0, "geometry": "rectangle_2d", "cd_x_nm": 40}]},
        {"layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": 40}] * 2},
        {"layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": 40, "material": {"n": 2}}]},
        {"solver": {"harmonics_x": 1}},
    ]
    try:
        async with Client(create_server(api)) as client:
            for change in changes:
                args = dimension_arguments()
                args["changes"] = change
                response = await client.call_tool(TOOL, args)
                assert response.is_error and response.structured_content["error"]["code"] == "invalid_arguments"
            args = dimension_arguments()
            args["padding"] = "界" * (MAX_REQUEST_BYTES // 3)
            response = await client.call_tool(TOOL, args)
            assert response.is_error and response.structured_content["error"]["code"] == "request_too_large"
        assert not calls
        with pytest.raises(AdapterError) as caught:
            await api.request("POST", ROUTE, args)
        assert caught.value.payload["error"]["code"] == "request_too_large"
        assert not calls
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["timeout", "unavailable", "oversize"])
async def test_readonly_transport_failures_never_claim_mutation_or_retry(mode):
    calls = []

    def respond(request):
        calls.append(request)
        if mode == "timeout":
            raise httpx.ReadTimeout("No response", request=request)
        if mode == "unavailable":
            return httpx.Response(503, json={"detail": "Down", "error": {
                "code": "unavailable", "message": "Down", "diagnostics": []}})
        return httpx.Response(200, content=b" " * (MAX_RESPONSE_BYTES + 1))

    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool(TOOL, dimension_arguments())
            assert response.is_error
            assert response.structured_content["error"]["code"] == {
                "timeout": "api_unavailable", "unavailable": "unavailable", "oversize": "response_too_large",
            }[mode]
            assert not response.structured_content.get("outcome_unknown", False)
        assert len(calls) == 1
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("delta", [0, 1])
async def test_http_response_limit_accepts_exact_eight_mb_and_rejects_one_byte_over(delta):
    args = dimension_arguments()
    expected = proposal(args)
    encoded = compact(expected)
    content = encoded + b" " * (MAX_RESPONSE_BYTES + delta - len(encoded))
    api = LocalAPI(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=content)))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool(TOOL, args)
            if delta:
                assert response.is_error and response.structured_content["error"]["code"] == "response_too_large"
            else:
                assert not response.is_error and response.structured_content == expected
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_dense_eight_layer_two_thousand_row_proposal_roundtrips_without_truncation(mode):
    args = dense_dimension_arguments()
    expected = proposal(args)
    assert 1_800_000 < len(compact(args)) < MAX_REQUEST_BYTES
    assert 2_000_000 < len(compact(expected)) < MAX_RESPONSE_BYTES
    sent = []

    def respond(request):
        sent.append(request.content)
        return httpx.Response(200, content=compact(expected))

    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api), mode=mode) as client:
            response = await client.call_tool(TOOL, args)
            assert not response.is_error, response
            assert response.structured_content == expected == json.loads(response.content[0].text)
            assert len(response.structured_content["candidate_project"]["layers"][7]["background"]["k_values"]) == 2000
        assert len(sent) == 1 and len(sent[0]) < MAX_REQUEST_BYTES
        assert json.loads(sent[0]) == DimensionChangePreviewRequest.model_validate(args, strict=True).model_dump()
        for version in VERSIONS:
            serialized = serialize_server_result(
                "tools/call", version, response.model_dump(by_alias=True, exclude_none=True))
            assert 7_900_000 < len(stdio_response_bytes(serialized, 37)) < MAX_STDIO_RESPONSE_BYTES
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_real_dense_unicode_proposal_exceeds_only_mcp_serialization_bound(mode):
    args = dense_dimension_arguments()
    project = args["base_project"]
    materials = [project["ambient"], project["substrate"]]
    materials += [layer[field] for layer in project["layers"] for field in ("material", "background")]
    for material in materials:
        material["source"] = "🧪" * 500
    expected = proposal(args)
    assert len(compact(args)) < MAX_REQUEST_BYTES
    assert len(compact(expected)) < MAX_RESPONSE_BYTES
    for version in VERSIONS:
        serialized = serialize_server_result(
            "tools/call", version, result(expected).model_dump(by_alias=True, exclude_none=True))
        assert len(stdio_response_bytes(serialized, 37)) > MAX_STDIO_RESPONSE_BYTES
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(200, content=compact(expected))

    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api), mode=mode) as client:
            response = await client.call_tool(TOOL, args)
            assert response.is_error
            assert response.structured_content["error"]["code"] == "response_too_large"
            assert not response.structured_content.get("outcome_unknown", False)
            assert len(compact(response.structured_content)) < 5000
            assert "candidate_project" not in response.content[0].text
        assert len(calls) == 1  # No automatic retry or truncation of the domain payload.
        recovered = await api.request("POST", ROUTE, args)
        assert compact(recovered) == compact(expected)  # The documented HTTP route can carry the full proposal.
        assert len(calls) == 2
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("delta", [0, 1])
async def test_serialized_dimension_result_limit_counts_rpc_utf8_and_duplication(version, delta):
    expected = proposal(dimension_arguments())
    api = LocalAPI()
    try:
        middleware = create_server(api).middleware[-1]
        request_id = 'dimension-"\\\n界🧪'
        payload = serialize_server_result(
            "tools/call", version, result(expected).model_dump(by_alias=True, exclude_none=True))
        payload["_meta"] = {"serverInfo": {"name": "RCWA Workbench", "version": "0.1.0"}}
        padding = MAX_STDIO_RESPONSE_BYTES + delta - len(stdio_response_bytes(payload, request_id))
        payload["content"][0]["text"] += "a" * padding
        assert len(stdio_response_bytes(payload, request_id)) == 8_000_000 + delta
        context = SimpleNamespace(method="tools/call", request_id=request_id, protocol_version=version,
                                  params={"name": TOOL, "arguments": dimension_arguments()})
        calls = []

        async def call_next(ctx):
            calls.append(ctx)
            return payload

        bounded = await middleware(context, call_next)
        assert calls == [context]
        if delta == 0:
            assert bounded is payload
        else:
            error = json.loads(bounded["content"][0]["text"])
            assert error["error"]["code"] == "response_too_large"
            assert not error.get("outcome_unknown", False)
            assert "HTTP" in error["error"]["message"]
            assert bounded["_meta"] == payload["_meta"]
            assert len(stdio_response_bytes(bounded, request_id)) < 5000
            assert "candidate_project" not in json.dumps(bounded)
            assert "a" * 100 not in json.dumps(bounded)
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_real_stdio_dimension_preview_and_rejection(real_api, mode):
    """Official client, subprocess adapter and actual HTTP boundary; no solve."""
    args = dimension_arguments()
    expected = proposal(args)
    async with Client(parameters(real_api), mode=mode, read_timeout_seconds=15) as client:
        discovered = {tool.name: tool for tool in (await client.list_tools()).tools}
        assert discovered[TOOL].annotations.read_only_hint
        actual = await call(client, TOOL, args)
        assert compact(actual) == compact(expected)
        # A schema-valid dimension still fails atomic cross-field validation.
        args["changes"] = {"layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": 5000}]}
        invalid = await call(client, TOOL, args, error=True)
        assert invalid["error"]["code"] == "invalid_input"
        assert not invalid.get("outcome_unknown", False)
        args["changes"] = {"period_nm": args["base_project"]["period_nm"] + 1}
        recovered = await call(client, TOOL, args)
        assert compact(recovered) == compact(proposal(args))
