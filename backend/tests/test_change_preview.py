"""Structural proposals are strict, deterministic and independent of computation."""

import builtins
from copy import deepcopy
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError
from sqlalchemy import event

from api.change_preview import preview_changes
from api.contracts import ChangePreviewRequest, ChangeProposal
from api.main import create_app
from api.storage import canonical_hash
from rcwa_core.schemas import Project

CASES = json.loads((Path(__file__).parent / "fixtures" / "geometry-preview-cases.json").read_text())


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'preview.db'}"), base_url="http://localhost") as client:
        yield client


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_shared_geometry_cases(client, case):
    base = Project().model_dump()
    original = deepcopy(base)
    response = client.post("/api/change-preview", json={"base_project": base, "changes": case["changes"]})
    assert base == original
    if not case["accepted"]:
        assert response.status_code == 422, response.text
        assert response.json()["error"]["diagnostics"]
        return
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diff"] == case["diff"]
    assert body["changes"] == case["changes"]
    assert body["base_project"] == original
    expected = deepcopy(original)
    for field, value in case["changes"].items():
        (expected if field == "period_nm" else expected["layers"][0])[field] = value
    assert body["candidate_project"] == expected
    assert body["base_input_hash"] == canonical_hash(original)
    assert body["candidate_input_hash"] == canonical_hash(Project.model_validate(expected).model_dump())
    assert body["valid"] == (not any(d["severity"] == "error" for d in body["diagnostics"]))
    assert not client.app.state.jobs.jobs
    ChangeProposal.model_validate(body, strict=True)


def test_normalization_determinism_noop_and_input_isolation(client):
    sparse = {"period_nm": 400}
    first = client.post("/api/change-preview", json={"base_project": sparse, "changes": {"cd_nm": 180}}).json()
    normalized = Project().model_dump()
    second = client.post("/api/change-preview", json={"changes": {"cd_nm": 180.0}, "base_project": normalized}).json()
    assert first == second
    assert first["base_project"] == first["candidate_project"] == normalized
    assert first["base_input_hash"] == first["candidate_input_hash"] == canonical_hash(normalized)
    assert first["diff"] == [] and first["valid"]
    request = ChangePreviewRequest(base_project={}, changes={"cd_nm": 140})
    before = request.model_dump()
    proposal = preview_changes(request)
    proposal.candidate_project.layers[0].cd_nm = 50
    proposal.base_project.name = "Mutated return"
    assert request.model_dump() == before


@pytest.mark.parametrize("field", ["period_nm", "cd_nm", "thickness_nm"])
@pytest.mark.parametrize("value", [True, False, "1", "", None, [], {}, float("inf"), float("-inf"), float("nan")])
def test_every_geometry_field_rejects_coercion_and_nonfinite(field, value):
    with pytest.raises(ValidationError):
        ChangePreviewRequest(base_project={}, changes={field: value})


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_nonfinite_json_is_rejected_at_http_boundary(client, token):
    response = client.post("/api/change-preview", content='{"base_project":{},"changes":{"cd_nm":' + token + '}}')
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_json"


@pytest.mark.parametrize("base", [
    {"unknown": True}, {"layers": []}, {"layers": [{"geometry": "triangle"}]},
    {"layers": [{"cd_nm": 401}]}, {"substrate": {"n": 0}},
    {"ambient": {"k": 0.1}}, {"illumination": {"wavelengths_nm": [650, 640]}},
    {"solver": {"harmonics": 21}},
    {"substrate": {"kind": "tabulated", "wavelengths_nm": [500, 600], "n_values": [1.5, 1.5], "k_values": [0, 0]}},
])
def test_full_base_validation_cannot_be_bypassed_by_patch(client, base):
    response = client.post("/api/change-preview", json={"base_project": base, "changes": {"cd_nm": 140}})
    assert response.status_code == 422
    assert response.json()["error"]["diagnostics"]


def test_preflight_errors_warnings_and_repair_are_visible(client):
    base = Project(illumination={"wavelengths_nm": [650], "angle_deg": 0}).model_dump()
    exact = client.post("/api/change-preview", json={"base_project": base, "changes": {"period_nm": 650}}).json()
    assert not exact["valid"]
    assert any(d["code"] == "rayleigh_cutoff" for d in exact["diagnostics"])
    near = client.post("/api/change-preview", json={"base_project": base, "changes": {"period_nm": 650.01}}).json()
    assert near["valid"]
    assert any(d["code"] == "near_rayleigh_cutoff" and d["severity"] == "warning" for d in near["diagnostics"])
    base["solver"]["harmonics"] = 1
    broad = client.post("/api/change-preview", json={"base_project": base, "changes": {"period_nm": 5000}}).json()
    assert not broad["valid"]
    assert any(d["code"] == "insufficient_harmonics" for d in broad["diagnostics"])
    repaired = client.post("/api/change-preview", json={
        "base_project": broad["candidate_project"], "changes": {"period_nm": 400},
    }).json()
    assert repaired["valid"]


def test_preview_does_not_inspect_engine_start_job_or_touch_storage(client, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Structural preview must not access engine, jobs or storage")

    monkeypatch.setattr("api.main.engine_info", forbidden)
    monkeypatch.setattr("rcwa_core.preflight.engine_info", forbidden)
    monkeypatch.setattr(client.app.state.jobs, "submit", forbidden)
    monkeypatch.setattr(client.app.state.jobs.context, "Process", forbidden)
    monkeypatch.setattr(client.app.state.store, "save", forbidden)
    queries = []
    def record(connection, cursor, statement, parameters, context, many):
        queries.append(statement)
    event.listen(client.app.state.store.engine, "before_cursor_execute", record)
    original_import = builtins.__import__
    def guarded_import(name, *args, **kwargs):
        if name.startswith("meent") or name in {"rcwa_core.solver", "rcwa_core.fitting"}:
            forbidden()
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guarded_import)
    response = client.post("/api/change-preview", json={"base_project": {}, "changes": {"cd_nm": 140}})
    assert response.status_code == 200 and response.json()["valid"]
    assert not queries
    assert not client.app.state.jobs.jobs
    assert not client.app.state.jobs.inputs
    assert not client.app.state.jobs.running


def test_security_and_request_size_bound_are_unchanged(client):
    body = {"base_project": {}, "changes": {"cd_nm": 140}}
    assert client.post("/api/change-preview", json=body, headers={"Host": "remote.example"}).status_code == 400
    assert client.post("/api/change-preview", json=body, headers={"Origin": "https://remote.example"}).status_code == 403
    assert client.post("/api/change-preview", json=body, headers={"Origin": "http://localhost:5173"}).status_code == 200
    assert client.post("/api/change-preview", content=b" " * 2_000_001).status_code == 413
    for extra in ({"result": {}}, {"provenance": {}}, {"apply": True}, {"changes": {"cd_nm": 140, "path": "name"}}):
        assert client.post("/api/change-preview", json={**body, **extra}).status_code == 422


def test_openapi_exposes_exact_preview_contract(client):
    schema = client.get("/openapi.json").json()
    route = schema["paths"]["/api/change-preview"]["post"]
    assert route["requestBody"]["content"]["application/json"]["schema"]["$ref"].endswith("ChangePreviewRequest")
    assert route["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith("ChangeProposal")
    request = ChangePreviewRequest.model_json_schema()
    response = ChangeProposal.model_json_schema()
    for contract in (request, response):
        assert contract["additionalProperties"] is False
        patch = contract["$defs"]["GeometryChanges"]
        assert patch["additionalProperties"] is False
        assert set(patch["properties"]) == {"period_nm", "cd_nm", "thickness_nm"}
        assert contract["properties"]["changes"]["minProperties"] == 1
        assert all(field["type"] == "number" for field in patch["properties"].values())
    assert set(response["required"]) == {
        "schema_version", "base_project", "candidate_project", "changes", "base_input_hash",
        "candidate_input_hash", "diff", "diagnostics", "valid",
    }
    assert response["properties"]["schema_version"]["const"] == "rcwa-change-proposal/1.0"
    assert "preview_changes" in client.get("/api/capabilities").json()["operations"]
