"""Adapter boundary tests. Install requirements-mcp-lock.txt to run this module."""

import json
from copy import deepcopy

import anyio
import httpx
import pytest

pytest.importorskip("mcp")
from mcp import Client
from mcp.shared.exceptions import MCPError
from jsonschema import Draft202012Validator

from api.contracts import JobResponse
from api.storage import canonical_hash
from mcp_adapter.client import AdapterError, LocalAPI, MAX_ACTIVE_CALLS, local_url
from mcp_adapter.server import create_server, OPERATIONS
from rcwa_core.schemas import Project


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.parametrize("url", [
    "https://127.0.0.1", "http://example.com", "http://127.0.0.2", "http://0.0.0.0",
    "http://169.254.169.254", "http://127.0.0.1.evil.test", "http://user@localhost",
    "http://localhost/path", "http://localhost?x=1", "http://localhost#x", "http://localhost:0",
    "http://localhost:65536", "http://localhost:", "http://localhost\n", " http://localhost",
    "http://local\thost", "http://[::ffff:127.0.0.1]", "ftp://localhost", "file:///tmp/x",
])
def test_remote_and_ambiguous_targets_are_rejected(url):
    with pytest.raises(ValueError):
        local_url(url)


@pytest.mark.parametrize("url,expected", [
    ("http://localhost:8000/", "http://127.0.0.1:8000"),
    ("http://127.0.0.1", "http://127.0.0.1"), ("http://[::1]:8000", "http://[::1]:8000"),
])
def test_loopback_is_pinned_without_dns(url, expected):
    assert local_url(url) == expected


@pytest.mark.parametrize("timeout", [0, -1, 31, float("inf"), float("nan")])
def test_timeout_is_bounded(timeout):
    with pytest.raises(ValueError):
        LocalAPI(timeout=timeout)


def test_tool_schemas_come_from_shared_models():
    tools = {operation.name: operation.tool() for operation in OPERATIONS}
    assert len(tools) == 12
    for tool in tools.values():
        Draft202012Validator.check_schema(tool.input_schema)
        Draft202012Validator.check_schema(tool.output_schema)
        assert tool.input_schema["additionalProperties"] is False
    project = tools["rcwa_validate"].input_schema["$defs"]["Project"]
    assert project["properties"]["layers"]["maxItems"] == 8
    submit = tools["rcwa_submit"].input_schema
    assert submit["$defs"]["JobRequest"]["properties"]["kind"]["enum"] == ["forward", "fit"]
    assert "FitOptions" in submit["$defs"]
    assert not tools["rcwa_submit"].annotations.idempotent_hint
    assert tools["rcwa_save_snapshot"].annotations.idempotent_hint
    assert tools["rcwa_cancel_job"].annotations.destructive_hint
    assert not tools["rcwa_save_snapshot"].annotations.read_only_hint
    assert tools["rcwa_validate"].annotations.read_only_hint
    preview = tools["rcwa_preview_changes"]
    assert preview.annotations.read_only_hint and preview.annotations.idempotent_hint
    assert not preview.annotations.destructive_hint and not preview.annotations.open_world_hint
    validator = Draft202012Validator(preview.input_schema)
    assert validator.is_valid({"base_project": {}, "changes": {"cd_nm": 140}})
    for changes in ({}, None, {"cd_nm": None}, {"cd_nm": True}, {"cd_nm": "140"}, {"path": "layers"}):
        assert not validator.is_valid({"base_project": {}, "changes": changes})


@pytest.mark.anyio
async def test_fixed_routes_and_request_bound(monkeypatch):
    calls = []
    async def respond(request):
        calls.append(request)
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        for method, path in [("GET", "http://example.com"), ("GET", "/api/jobs/../health"),
                             ("POST", "/api/projects"), ("DELETE", "/api/projects/id")]:
            with pytest.raises(AdapterError, match="not exposed"):
                await api.request(method, path)
        monkeypatch.setattr("mcp_adapter.client.MAX_REQUEST_BYTES", 30)
        for body in [{"x": "a" * 31}, {"x": float("nan")}]:
            with pytest.raises(AdapterError):
                await api.request("POST", "/api/jobs", body)
        assert not calls
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("status,code", [(422, "invalid_input"), (429, "capacity"), (500, "invalid_input"),
                                         (503, "engine_unavailable"), (503, "cleanup_pending"), (404, "job_missing")])
async def test_http_errors_preserve_payload_and_never_retry(status, code):
    payload = {"detail": "Readable error", "error": {"code": code, "message": "Readable error", "diagnostics": [
        {"code": code, "message": "Exact diagnostic", "severity": "error", "location": ["layers", 0]},
    ]}}
    count = 0
    def respond(request):
        nonlocal count
        count += 1
        return httpx.Response(status, json=payload)
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        with pytest.raises(AdapterError) as caught:
            await api.request("POST", "/api/jobs", {})
        actual = caught.value.payload
        assert actual["error"] == payload["error"] and actual["detail"] == payload["detail"]
        assert actual["http_status"] == status
        # A 503 is returned only before admission, so the operation certainly did not run.
        assert actual.get("outcome_unknown", False) == (status >= 500 and status != 503)
        assert count == 1
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("raw", [b"not json", b"[]", b'{"x":NaN}', b'{"x":Infinity}', b'{"x":1e999}', b'\xff'])
async def test_untrusted_mutation_response_is_uncertain(raw):
    count = 0
    def respond(request):
        nonlocal count
        count += 1
        return httpx.Response(200, content=raw)
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        with pytest.raises(AdapterError) as caught:
            await api.request("POST", "/api/jobs", {})
        assert caught.value.payload["outcome_unknown"] is True
        assert count == 1
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_redirect_compression_and_response_bound(monkeypatch):
    calls = []
    def respond(request):
        calls.append(str(request.url))
        return httpx.Response(302, headers={"Location": "http://example.com"})
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        with pytest.raises(AdapterError):
            await api.request("GET", "/api/example")
        assert calls == ["http://127.0.0.1:8000/api/example"]
    finally:
        await api.aclose()
    monkeypatch.setattr("mcp_adapter.client.MAX_RESPONSE_BYTES", 20)
    api = LocalAPI(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"x": "a" * 40})))
    try:
        with pytest.raises(AdapterError):
            await api.request("GET", "/api/example")
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_hard_deadline_and_no_post_retry():
    count = 0
    async def stall(request):
        nonlocal count
        count += 1
        await anyio.sleep(1)
        return httpx.Response(200, json={})
    api = LocalAPI(timeout=0.03, transport=httpx.MockTransport(stall))
    started = anyio.current_time()
    try:
        with pytest.raises(AdapterError) as caught:
            await api.request("POST", "/api/jobs", {})
        assert caught.value.payload["outcome_unknown"]
        assert anyio.current_time() - started < 0.5
        assert count == 1
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_four_calls_then_fail_fast_without_queue():
    entered, release = anyio.Event(), anyio.Event()
    count = 0
    async def wait(request):
        nonlocal count
        count += 1
        if count == MAX_ACTIVE_CALLS:
            entered.set()
        await release.wait()
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(wait))
    try:
        async with anyio.create_task_group() as group:
            for _ in range(MAX_ACTIVE_CALLS):
                group.start_soon(api.request, "GET", "/api/example")
            await entered.wait()
            with pytest.raises(AdapterError) as caught:
                await api.request("GET", "/api/example")
            assert caught.value.payload["error"]["code"] == "adapter_capacity"
            assert count == MAX_ACTIVE_CALLS
            release.set()
        assert await api.request("GET", "/api/example") == {}
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_unknown_and_invalid_tool_calls_never_reach_api():
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            cases = [
                ("rcwa_capabilities", {"api_url": "http://elsewhere"}),
                ("rcwa_get_job", {"job_id": "../health"}), ("rcwa_get_snapshot", {"snapshot_id": "x?z"}),
                ("rcwa_save_snapshot", {"job_id": "abc", "provenance": {"source": "server_computed"}}),
                ("rcwa_validate", {"project": {"unknown": 1}}),
                ("rcwa_submit", {"request": {"kind": "fit", "project": {}}}),
                ("rcwa_submit", {"request": {"kind": "forward", "project": {}, "fit": {"target_cd_nm": 180}}}),
            ]
            with pytest.raises(MCPError) as caught:
                await client.call_tool("not_a_tool", {})
            assert caught.value.code == -32602
            for name, arguments in cases:
                response = await client.call_tool(name, arguments)
                assert response.is_error, (name, response)
                assert json.loads(response.content[0].text) == response.structured_content
            assert not calls
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("status", ["running", "failed", "cancelled"])
async def test_job_status_is_preserved_not_reinterpreted(status):
    job = JobResponse(id="job-123", kind="forward", status=status, created_at="now", completed_at=None,
                      input_hash="hash", result=None, error="Numerical failure" if status == "failed" else None,
                      error_code="numerical_failure" if status == "failed" else None).model_dump()
    api = LocalAPI(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=job)))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_get_job", {"job_id": "job-123"})
            assert not response.is_error
            assert response.structured_content == job
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_unverified_import_stays_unverified_and_bad_response_rejected():
    saved = {"id": "saved-1", "name": "Old import", "created_at": "now", "updated_at": "now",
             "project": Project().model_dump(), "result": None, "provenance": {"source": "unverified_import"}}
    payload = deepcopy(saved)
    api = LocalAPI(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_get_snapshot", {"snapshot_id": "saved-1"})
            assert not response.is_error and response.structured_content == saved
            payload["provenance"]["source"] = "server_computed"
            response = await client.call_tool("rcwa_get_snapshot", {"snapshot_id": "saved-1"})
            assert response.is_error and response.structured_content["error"]["code"] == "invalid_api_response"
            response = await client.call_tool("rcwa_submit", {"request": {"project": Project().model_dump()}})
            assert response.is_error and response.structured_content["outcome_unknown"]
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_synthetic_fit_is_forwarded_with_its_distinct_kind():
    job = JobResponse(id="fit-job", kind="fit", status="running", created_at="now", completed_at=None,
                      input_hash=canonical_hash(Project().model_dump()), result=None, error=None, error_code=None).model_dump()
    sent = []
    def respond(request):
        sent.append(json.loads(request.content))
        return httpx.Response(202, json=job)
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_submit", {"request": {
                "kind": "fit", "project": {}, "fit": {"target_cd_nm": 180},
            }})
            assert not response.is_error and response.structured_content["kind"] == "fit"
            assert sent[0]["fit"] == {"target_cd_nm": 180.0, "lower_cd_nm": 40.0, "upper_cd_nm": 360.0}
            assert sent[0]["project"] == Project().model_dump()
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_environment_proxy_is_ignored(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("NO_PROXY", "")
    api = LocalAPI()
    try:
        assert not api.http._trust_env
        assert not api.http._mounts  # no proxy transports were constructed
        assert not api.http.follow_redirects
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_coercible_wrong_api_types_are_not_success():
    payload = {"valid": "false", "project": None, "input_hash": None, "diagnostics": []}
    api = LocalAPI(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_validate", {"project": {}})
            assert response.is_error
            assert response.structured_content["error"]["code"] == "invalid_api_response"
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_coercible_wrong_tool_types_do_not_reach_api():
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            for project in [{"period_nm": "400"}, {"illumination": {"angle_deg": True}}]:
                response = await client.call_tool("rcwa_validate", {"project": project})
                assert response.is_error and response.structured_content["error"]["code"] == "invalid_arguments"
        assert not calls
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_submit_response_must_match_requested_kind():
    job = JobResponse(id="job", kind="fit", status="running", created_at="now", completed_at=None,
                      input_hash="hash", result=None, error=None, error_code=None).model_dump()
    api = LocalAPI(transport=httpx.MockTransport(lambda r: httpx.Response(202, json=job)))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_submit", {"request": {"project": {}}})
            assert response.is_error and response.structured_content["outcome_unknown"]
    finally:
        await api.aclose()
