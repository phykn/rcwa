"""Official SDK stdio journeys with opt-in bounded results and no HTTP escape."""

from contextlib import contextmanager
from copy import deepcopy
import gzip
import json
from pathlib import Path

import anyio
import httpx
from jsonschema import Draft202012Validator
import pytest

pytest.importorskip("mcp")
from mcp import Client
from mcp.server.runner import ServerRunner
from types import SimpleNamespace

from api.result_summary import MAX_SUMMARY_BYTES, summarize_snapshot
from mcp_adapter.client import AdapterError, LocalAPI
from mcp_adapter.server import create_server, OPERATIONS, MAX_STDIO_RESPONSE_BYTES, result, stdio_response_bytes
import test_mcp_protocol as protocol
import test_2d_mcp_transport as transport
import test_agent_summaries as summary_tests

circular_snapshot = summary_tests.circular_snapshot
anyio_backend = protocol.anyio_backend
real_api = protocol.real_api


@pytest.fixture(params=["rectangle", "circle"])
def preloaded_api(request, tmp_path, monkeypatch):
    fixture = Path(__file__).parent / "fixtures/true-2d" / (
        "circular-max-resource-snapshot.json.gz" if request.param == "circle" else "max-resource-snapshot.json.gz"
    )
    saved = json.loads(gzip.decompress(fixture.read_bytes()))
    monkeypatch.setattr(transport, "FIXTURE", fixture)
    with contextmanager(transport.preloaded_resource_api.__wrapped__)(tmp_path, saved) as details:
        yield details, saved


async def call(client, name, args=None, *, error=False):
    response = await client.call_tool(name, args or {})
    assert response.is_error == error, response
    payload = response.structured_content
    assert json.loads(response.content[0].text) == payload
    # Exact version-specific duplicated JSON-RPC encoding, worst permitted ID.
    runner = ServerRunner(create_server(SimpleNamespace(url="http://127.0.0.1:8000")), None, None)
    wire = runner._serialize("tools/call", client.protocol_version, result(payload))
    assert len(stdio_response_bytes(wire, transport.protocol_id("unicode", 1024))) < MAX_STDIO_RESPONSE_BYTES
    return payload


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_real_stdio_circle_example_run_inspect_receipt_reload_without_http(real_api, mode):
    async with Client(protocol.parameters(real_api), mode=mode, read_timeout_seconds=30) as client:
        tools = {tool.name: tool for tool in (await client.list_tools()).tools}
        for tool in tools.values():
            Draft202012Validator.check_schema(tool.input_schema)
            Draft202012Validator.check_schema(tool.output_schema)
        assert "labels" in tools["rcwa_example"].description and "database" in tools["rcwa_validate"].description
        assert (await call(client, "rcwa_example"))["schema_version"] == "1.0"
        project = await call(client, "rcwa_example", {"example": "circular_hole_2d"})
        assert project["schema_version"] == "1.2"
        # A small live contract exercise, not convergence evidence for this input.
        project["layers"] = [project["layers"][0], {"geometry": "homogeneous", "name": "Uniform synthetic spacer",
                                                    "thickness_nm": 40.0, "material": {"n": 1.4, "k": 0.0}}]
        project["illumination"]["wavelengths_nm"] = [650.0]
        project["solver"] = {"harmonics_x": 1, "harmonics_y": 1}
        named = deepcopy(project)
        named["layers"][0]["background"] = {"name": "Silicon"}
        warned = await call(client, "rcwa_validate", {"project": named})
        assert warned["valid"] and [d["code"] for d in warned["diagnostics"]].count("material_name_only") == 1
        renormalized = await call(client, "rcwa_validate", {"project": warned["project"]})
        assert not any(d["code"] == "material_name_only" for d in renormalized["diagnostics"])
        checked = await call(client, "rcwa_validate", {"project": project})
        job = await call(client, "rcwa_submit", {"request": {"project": checked["project"]}})
        job_id = job["id"]
        with anyio.fail_after(30):
            while True:
                job = await call(client, "rcwa_get_job", {"job_id": job_id, "view": "summary"})
                if job["status"] != "running":
                    break
                await anyio.sleep(0.1)
        assert job["status"] == "succeeded" and job["kind"] == "forward"
        assert job["input_hash"] == checked["input_hash"]
        assert job["result_summary"]["warnings_omitted_count"] == 0
        assert "result" not in job and "orders" not in json.dumps(job)
        receipt = await call(client, "rcwa_save_snapshot", {"job_id": job_id, "view": "receipt"})
        assert receipt["input_hash"] == job["input_hash"]
        assert receipt["result_summary"] == job["result_summary"]
        assert receipt["provenance"]["job_id"] == job_id
        repeated = await call(client, "rcwa_save_snapshot", {"job_id": job_id, "view": "receipt"})
        assert repeated == receipt
        loaded = await call(client, "rcwa_get_snapshot", {"snapshot_id": receipt["id"], "view": "summary"})
        assert loaded == {**receipt, "view": "summary"}
        full = await call(client, "rcwa_get_snapshot", {"snapshot_id": receipt["id"]})
        assert full["project"] == checked["project"]
        assert full["result"]["spectra"]["s"]["R"] == loaded["result_summary"]["spectra"]["s"]["R"]
        assert "orders" in full["result"]["spectra"]["s"]
        assert full == await call(client, "rcwa_save_snapshot", {"job_id": job_id})


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_real_max_snapshot_can_be_saved_and_reloaded_only_with_tools(preloaded_api, mode):
    (url, job_id, submit_marker), original = preloaded_api
    async with Client(protocol.parameters(url), mode=mode, read_timeout_seconds=30) as client:
        job = await call(client, "rcwa_get_job", {"job_id": job_id, "view": "summary"})
        assert job["status"] == "succeeded"
        receipt = await call(client, "rcwa_save_snapshot", {"job_id": job_id, "view": "receipt"})
        assert receipt["result_summary"] == job["result_summary"]
        assert receipt["input_hash"] == original["provenance"]["input_hash"]
        assert receipt["result_summary"]["spectra"]["p"]["T"] == original["result"]["spectra"]["p"]["T"]
        loaded = await call(client, "rcwa_get_snapshot", {"snapshot_id": receipt["id"], "view": "summary"})
        assert loaded == {**receipt, "view": "summary"}
        assert receipt == await call(client, "rcwa_save_snapshot", {"job_id": job_id, "view": "receipt"})
        for payload in (job, receipt, loaded):
            assert len(json.dumps(payload, ensure_ascii=False).encode()) <= MAX_SUMMARY_BYTES
            assert payload["result_summary"]["warnings_omitted_count"] == 0
        # Existing full overflow remains explicit and the mutation stays uncertain.
        full_error = await call(client, "rcwa_save_snapshot", {"job_id": job_id}, error=True)
        assert full_error["error"]["code"] == "response_too_large" and full_error["outcome_unknown"]
        assert "view=receipt" in full_error["error"]["message"]
        assert receipt == await call(client, "rcwa_save_snapshot", {"job_id": job_id, "view": "receipt"})
    assert not submit_marker.exists()
    # This read-only test assertion is not needed by the tool-only journey above.
    with httpx.Client(trust_env=False, timeout=30) as http:
        records = http.get(url + "/api/projects").json()
        assert len(records) == 1
        full = http.get(url + "/api/projects/" + receipt["id"]).json()
        assert full["project"] == original["project"] and full["result"] == original["result"]


@pytest.mark.anyio
async def test_new_view_and_example_routes_do_not_expand_arbitrary_transport():
    calls = []
    async def response(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(response))
    try:
        for method, path in [
            ("GET", "/api/example?example=rectangle"), ("GET", "/api/example?example=circular_hole_2d&url=x"),
            ("GET", "/api/jobs/job?view=receipt"), ("DELETE", "/api/jobs/job?view=summary"),
            ("GET", "/api/projects/job?view=summary&other=1"), ("POST", "/api/snapshots?view=summary"),
        ]:
            with pytest.raises(AdapterError, match="not exposed"):
                await api.request(method, path)
        assert not calls
        async with Client(create_server(api)) as client:
            for name, args in [
                ("rcwa_example", {"example": "1.2"}), ("rcwa_example", {"example": "circular_hole_2d", "view": "summary"}),
                ("rcwa_get_job", {"job_id": "job", "view": True}),
                ("rcwa_get_snapshot", {"snapshot_id": "job", "view": "receipt"}),
                ("rcwa_save_snapshot", {"job_id": "job", "view": "summary"}),
                ("rcwa_cancel_job", {"job_id": "job", "view": "summary"}),
            ]:
                error = await protocol.call(client, name, args, error=True)
                assert error["error"]["code"] == "invalid_arguments"
            error = await protocol.call(client, "rcwa_example", {"example": "x" * 2_000_001}, error=True)
            assert error["error"]["code"] == "request_too_large"
        assert not calls
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("tamper", ["id", "hash", "result_hash", "source", "unexpected_full", "null_result"])
async def test_receipt_rejects_identity_provenance_and_view_substitution(circular_snapshot, tamper):
    original = circular_snapshot
    payload = summarize_snapshot(original, receipt=True)
    if tamper == "id":
        payload["provenance"]["job_id"] = "another-job"
    elif tamper == "hash":
        payload["input_hash"] = "0" * 64
    elif tamper == "result_hash":
        payload["result_summary"]["input_hash"] = "0" * 64
    elif tamper == "source":
        payload["provenance"]["source"] = "unverified_import"
    elif tamper == "unexpected_full":
        payload = deepcopy(original)
    elif tamper == "null_result":
        payload["result_summary"] = None
    api = LocalAPI(transport=httpx.MockTransport(lambda _: httpx.Response(201, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            error = await protocol.call(client, "rcwa_save_snapshot", {
                "job_id": original["provenance"]["job_id"], "view": "receipt",
            }, error=True)
            assert error["error"]["code"] == "invalid_api_response" and error["outcome_unknown"]
    finally:
        await api.aclose()


def test_additive_view_schemas_forbid_fields_and_advertise_enums():
    operations = {operation.name: operation for operation in OPERATIONS}
    for name, field, valid, invalid in [
        ("rcwa_example", "example", "circular_hole_2d", "1.2"),
        ("rcwa_get_job", "view", "summary", "receipt"),
        ("rcwa_get_snapshot", "view", "summary", "receipt"),
        ("rcwa_save_snapshot", "view", "receipt", "summary"),
    ]:
        schema = operations[name].tool().input_schema
        assert schema["properties"][field]["enum"] == (
            ["legacy_1d", valid] if field == "example" else ["full", valid]
        )
        assert invalid not in schema["properties"][field]["enum"]


@pytest.mark.anyio
async def test_server_snapshot_summary_cannot_omit_totals_and_warnings(circular_snapshot):
    payload = summarize_snapshot(circular_snapshot)
    payload["result_summary"] = None
    api = LocalAPI(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            error = await protocol.call(client, "rcwa_get_snapshot", {
                "snapshot_id": circular_snapshot["id"], "view": "summary",
            }, error=True)
            assert error["error"]["code"] == "invalid_api_response"
            assert not error.get("outcome_unknown", False)
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_succeeded_job_summary_cannot_omit_its_result(circular_snapshot):
    provenance = circular_snapshot["provenance"]
    payload = {
        "view": "summary", "id": provenance["job_id"], "kind": "forward", "status": "succeeded",
        "created_at": provenance["submitted_at"], "completed_at": provenance["completed_at"],
        "input_hash": provenance["input_hash"], "result_summary": None, "error": None, "error_code": None,
    }
    api = LocalAPI(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            error = await protocol.call(client, "rcwa_get_job", {
                "job_id": provenance["job_id"], "view": "summary",
            }, error=True)
            assert error["error"]["code"] == "invalid_api_response"
            assert not error.get("outcome_unknown", False)
    finally:
        await api.aclose()
