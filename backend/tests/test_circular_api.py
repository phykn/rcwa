"""Circle application discovery, validation, bounded real job and persisted snapshot."""
from copy import deepcopy
import json
import time

from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
import pytest

from api.main import create_app
from rcwa_core.schemas_2d import Project2D
from test_circular_geometry import circle_project


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'circle.db'}"), base_url="http://localhost") as client:
        yield client


def test_circle_capabilities_openapi_and_json_schema(client):
    profile = client.get("/api/capabilities").json()["project_profiles"]["1.2"]
    assert "circular_hole_2d" in profile["geometry"]
    assert profile["adapter_version"] == "1.4.0"
    schema = Project2D.model_json_schema()
    p = circle_project()
    Draft202012Validator(schema).validate(p)
    assert "CircularHole2D" in client.get("/openapi.json").json()["components"]["schemas"]
    del p["layers"][0]["geometry"]
    assert not Draft202012Validator(schema).is_valid(p)


@pytest.mark.parametrize("diameter", [True, "65", None, -1, 140.01])
def test_circle_invalid_dimensions_rejected_before_job_or_save(client, monkeypatch, diameter):
    def never(*args, **kwargs):
        pytest.fail("Rejected circle reached worker allocation")
    monkeypatch.setattr(client.app.state.jobs, "submit", never)
    p = circle_project()
    p["layers"][0]["diameter_nm"] = diameter
    for route, body in (("/api/validate", p), ("/api/jobs", {"project": p}), ("/api/projects", {"project": p})):
        assert client.post(route, json=body).status_code == 422
    assert client.get("/api/projects").json() == []


@pytest.mark.parametrize("key", ["reference_circle_strips", "circle_strips", "circular_geometry"])
def test_circle_offline_spatial_controls_never_public(client, key):
    p = circle_project()
    p["solver"][key] = 128
    assert client.post("/api/jobs", json={"project": p}).status_code == 422


def test_circle_real_job_snapshot_load_exact_input_and_diameter_binding(client):
    p = circle_project()
    response = client.post("/api/jobs", json={"project": p})
    assert response.status_code == 202, response.text
    job = response.json()
    deadline = time.monotonic() + 20
    while job["status"] == "running" and time.monotonic() < deadline:
        time.sleep(0.02)
        job = client.get(f'/api/jobs/{job["id"]}').json()
    assert job["status"] == "succeeded", job
    assert job["result"]["metadata"]["circular_geometry"]["strips"] == 64
    response = client.post("/api/snapshots", json={"job_id": job["id"]})
    assert response.status_code == 201, response.text
    snapshot = response.json()
    assert snapshot["project"] == p
    assert snapshot["provenance"]["adapter_version"] == "1.4.0"
    assert client.get(f'/api/projects/{snapshot["id"]}').json() == snapshot
    changed = deepcopy(p)
    changed["layers"][0]["diameter_nm"] += 1
    response = client.post("/api/projects", json={"project": changed, "result": job["result"]})
    assert response.status_code == 422
    # Disallow stripping circle approximation provenance even if all powers remain.
    changed_result = deepcopy(job["result"])
    del changed_result["metadata"]["circular_geometry"]
    response = client.post("/api/projects", json={"project": p, "result": changed_result})
    assert response.status_code == 422
    assert json.loads(json.dumps(snapshot))["project"]["layers"][0]["diameter_nm"] == 65


def test_circle_mcp_discovery_schema_supports_exact_new_shape():
    pytest.importorskip("mcp")
    from mcp_adapter.server import OPERATIONS

    by_name = {operation.name: operation for operation in OPERATIONS}
    p = circle_project()
    for name, arguments in (("rcwa_validate", {"project": p}), ("rcwa_submit", {"request": {"project": p}})):
        operation = by_name[name]
        Draft202012Validator(operation.tool().input_schema).validate(arguments)
        operation.arguments.model_validate(arguments, strict=True)
        assert "circular_hole_2d" in json.dumps(operation.tool().input_schema)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_real_circle_mcp_compute_snapshot_and_reload(client):
    pytest.importorskip("mcp")
    import anyio
    import httpx
    from mcp import Client
    from mcp_adapter.client import LocalAPI
    from mcp_adapter.server import create_server
    from test_mcp_protocol import call

    api = LocalAPI(transport=httpx.ASGITransport(app=client.app))
    try:
        async with Client(create_server(api)) as mcp:
            project = circle_project()
            checked = await call(mcp, "rcwa_validate", {"project": project})
            assert checked["project"] == project
            submitted = await call(mcp, "rcwa_submit", {"request": {"project": project}})
            deadline = time.monotonic() + 20
            job = submitted
            while job["status"] == "running" and time.monotonic() < deadline:
                await anyio.sleep(0.02)
                job = await call(mcp, "rcwa_get_job", {"job_id": submitted["id"]})
            assert job["status"] == "succeeded", job
            saved = await call(mcp, "rcwa_save_snapshot", {"job_id": submitted["id"]})
            assert saved["project"] == project
            assert saved["result"]["metadata"]["circular_geometry"]["strips"] == 64
            loaded = await call(mcp, "rcwa_get_snapshot", {"snapshot_id": saved["id"]})
            assert loaded == saved
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("version", ["2025-11-25", "2026-07-28"])
async def test_real_max_circle_snapshot_uses_bounded_mcp_recovery(version):
    pytest.importorskip("mcp")
    import gzip
    import hashlib
    from pathlib import Path
    from types import SimpleNamespace

    from api.contracts import StoredServerSnapshot
    from mcp_adapter.client import LocalAPI
    from mcp_adapter.server import create_server, stdio_response_bytes
    from test_2d_mcp_transport import serialize_tool

    root = Path(__file__).resolve().parents[2]
    raw = gzip.decompress((Path(__file__).parent / "fixtures/true-2d/circular-max-resource-snapshot.json.gz").read_bytes())
    report = json.loads((root / "docs/true-2d/circular-worker-resources.json").read_text())
    assert hashlib.sha256(raw).hexdigest() == report["snapshot_sha256"]
    snapshot = json.loads(raw)
    StoredServerSnapshot.model_validate(snapshot, strict=True)
    assert all(layer["geometry"] == "circular_hole_2d" for layer in snapshot["project"]["layers"])
    payload = serialize_tool(snapshot, version)
    assert len(stdio_response_bytes(payload, 101)) > 8_000_000
    api = LocalAPI()
    try:
        middleware = create_server(api).middleware[-1]
        context = SimpleNamespace(method="tools/call", request_id=101, protocol_version=version,
                                  params={"name": "rcwa_save_snapshot", "arguments": {
                                      "job_id": snapshot["provenance"]["job_id"]}})
        async def call_next(ctx):
            return payload
        bounded = await middleware(context, call_next)
        error = json.loads(bounded["content"][0]["text"])
        assert error["error"]["code"] == "response_too_large" and error["outcome_unknown"]
        assert "same job_id" in error["error"]["message"]
        assert "do not start a new calculation" in error["error"]["message"]
        assert len(stdio_response_bytes(bounded, 101)) < 5000
        assert "retained_orders" not in json.dumps(bounded)
    finally:
        await api.aclose()
