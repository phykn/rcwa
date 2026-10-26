from copy import deepcopy
import json

import anyio
import httpx
import pytest

pytest.importorskip("mcp")
from mcp import Client

from api.change_preview import preview_changes
from api.contracts import ChangePreviewRequest
from mcp_adapter.client import AdapterError, LocalAPI
from mcp_adapter.server import create_server
from rcwa_core.schemas import Project


@pytest.fixture
def anyio_backend():
    return "asyncio"


def proposal(base=None, changes=None):
    return preview_changes(ChangePreviewRequest(
        base_project={} if base is None else base,
        changes={"cd_nm": 140} if changes is None else changes,
    )).model_dump()


@pytest.mark.anyio
async def test_preview_is_forwarded_normalized_and_returned_unchanged():
    sent = []
    expected = proposal()
    def respond(request):
        sent.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(200, json=expected)
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_preview_changes", {"base_project": {}, "changes": {"cd_nm": 140}})
            assert not response.is_error
            assert response.structured_content == expected == json.loads(response.content[0].text)
        assert sent == [("POST", "/api/change-preview", {
            "base_project": Project().model_dump(), "changes": {"cd_nm": 140.0},
        })]
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_invalid_preview_arguments_never_reach_http():
    calls = []
    api = LocalAPI(transport=httpx.MockTransport(lambda request: calls.append(request)))
    try:
        async with Client(create_server(api)) as client:
            for changes in ({}, None, [], {"cd_nm": None}, {"cd_nm": True}, {"cd_nm": "140"},
                            {"cd_nm": 140, "unknown": 1}, {"period_nm": 19}, {"thickness_nm": 2001}):
                response = await client.call_tool("rcwa_preview_changes", {"base_project": {}, "changes": changes})
                assert response.is_error and response.structured_content["error"]["code"] == "invalid_arguments"
        assert not calls
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("change", [
    lambda p: p.update(schema_version="rcwa-change-proposal/2.0"),
    lambda p: p.update(result={}),
    lambda p: p.update(provenance={"source": "server_computed"}),
    lambda p: p.update(valid="true"),
    lambda p: p.update(valid=False),
    lambda p: p.update(base_input_hash="0" * 64),
    lambda p: p.update(candidate_input_hash="0" * 64),
    lambda p: p.update(base_project={}),
    lambda p: p["candidate_project"].update(name="Extra non-geometry change"),
    lambda p: p["candidate_project"]["substrate"].update(n=1.6),
    lambda p: p["changes"].update(thickness_nm=160),
    lambda p: p["changes"].update(cd_nm=True),
    lambda p: p["changes"].update(cd_nm="140"),
    lambda p: p["diff"][0].update(before="180"),
    lambda p: p["diff"][0].update(after=150),
    lambda p: p["diff"].append(deepcopy(p["diff"][0])),
    lambda p: p["diagnostics"].append({"code": "fake", "severity": "info", "location": [], "message": "Unrequested"}),
    lambda p: p.pop("valid"),
])
async def test_untrusted_preview_semantics_and_schema_are_rejected(change):
    payload = proposal()
    change(payload)
    api = LocalAPI(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_preview_changes", {"base_project": {}, "changes": {"cd_nm": 140}})
            assert response.is_error
            assert response.structured_content["error"]["code"] == "invalid_api_response"
            assert not response.structured_content.get("outcome_unknown", False)
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("payload", [
    proposal(base={"name": "Unrelated canonical base"}),
    proposal(changes={"cd_nm": 120}),
])
async def test_otherwise_valid_preview_for_another_request_is_rejected(payload):
    api = LocalAPI(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_preview_changes", {"base_project": {}, "changes": {"cd_nm": 140}})
            assert response.is_error and response.structured_content["error"]["code"] == "invalid_api_response"
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_candidate_preflight_failure_is_preserved_as_successful_preview():
    arguments = {"base_project": {"solver": {"harmonics": 1}}, "changes": {"period_nm": 5000}}
    payload = proposal(arguments["base_project"], arguments["changes"])
    api = LocalAPI(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_preview_changes", arguments)
            assert not response.is_error
            assert response.structured_content == payload
            assert not payload["valid"] and payload["diagnostics"]
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("failure", ["timeout", "nonjson", "http_503"])
async def test_preview_post_is_readonly_even_when_response_fails(failure):
    calls = []
    async def respond(request):
        calls.append(request)
        if failure == "timeout":
            await anyio.sleep(1)
        if failure == "http_503":
            return httpx.Response(503, json={"detail": "Down", "error": {
                "code": "unavailable", "message": "Down", "diagnostics": [],
            }})
        return httpx.Response(200, content=b"not json")
    api = LocalAPI(timeout=0.03, transport=httpx.MockTransport(respond))
    try:
        with pytest.raises(AdapterError) as caught:
            await api.request("POST", "/api/change-preview", {"base_project": {}, "changes": {"cd_nm": 140}})
        error = caught.value.payload
        assert not error.get("outcome_unknown", False)
        assert error["error"]["code"] == ("unavailable" if failure == "http_503" else "api_unavailable")
        assert len(calls) == 1
    finally:
        await api.aclose()
