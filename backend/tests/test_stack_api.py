"""Versioned stack boundary, historical-reader and read-only proposal proofs."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import time

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError
from sqlalchemy import event

from api.contracts import StackChangePreviewRequest, StackChangeProposal, StoredServerSnapshot
from api.main import create_app
from api.stack_change_preview import (
    MAX_PROPOSAL_BYTES, ProposalTooLarge, bounded_proposal, material_summary, preview_stack_changes,
    validate_stack_proposal_binding,
)
from api.storage import canonical_hash
from rcwa_core.schemas import Material, Project

FIXTURES = Path(__file__).parent / "fixtures"


def stack_project():
    project = Project().model_dump()
    project.update(schema_version="1.1")
    project["layers"].append({"geometry": "homogeneous", "name": "Lower slab", "thickness_nm": 75.0,
                              "material": Material(name="Slab", n=1.8).model_dump()})
    project["illumination"]["wavelengths_nm"] = [650.0]
    project["solver"]["harmonics"] = 3
    return project


def table_material(rows=2000, *, loss=False):
    return Material(kind="tabulated", wavelengths_nm=[200.123456789012 + index * 1.150123456789 for index in range(rows)],
                    n_values=[1.432198765432101 + index * 0.000013579246813 for index in range(rows)],
                    k_values=[0.012398765432101 + index * 0.000001357924681 for index in range(rows)] if loss else [0.0] * rows)


def large_preview_request(rows=2000):
    project = stack_project()
    material = table_material(rows, loss=True).model_dump()
    project["layers"] = [deepcopy(Project().model_dump()["layers"][0]) for _ in range(8)]
    for layer in project["layers"]:
        layer["material"] = deepcopy(material)
        layer["background"] = deepcopy(material)
    project["substrate"] = deepcopy(material)
    project["ambient"] = table_material(rows).model_dump()
    return {"base_project": project, "changes": {"period_nm": 390.0}}


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'stack.db'}"), base_url="http://localhost") as client:
        yield client


def test_stack_validate_submit_poll_snapshot_import_and_restart(tmp_path):
    database = f"sqlite:///{tmp_path / 'stack.db'}"
    with TestClient(create_app(database), base_url="http://localhost") as client:
        project = stack_project()
        original = deepcopy(project)
        assert client.post("/api/validate", json=project).json()["valid"]
        response = client.post("/api/jobs", json={"kind": "forward", "project": project})
        assert response.status_code == 202, response.text
        job_id = response.json()["id"]
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] != "running":
                break
            time.sleep(0.03)
        assert job["status"] == "succeeded", job
        assert job["input_hash"] == canonical_hash(original)
        assert job["result"]["schema_version"] == "1.1"
        assert job["result"]["metadata"]["adapter_version"] == "1.2.0"
        assert job["result"]["metadata"]["layer_count"] == 2
        saved = client.post("/api/snapshots", json={"job_id": job_id}).json()
        assert saved["project"] == original and saved["result"] == job["result"]
        assert saved["provenance"]["project_schema_version"] == "1.1"
        assert saved["provenance"]["result_schema_version"] == "1.1"
        imported = client.post("/api/projects", json={"project": original, "result": saved["result"]})
        assert imported.status_code == 201, imported.text
        assert imported.json()["provenance"]["source"] == "unverified_import"
        for mutate in (lambda r: r.update(schema_version="9.0"), lambda r: r.pop("result_type"),
                       lambda r: r["metadata"].pop("layer_count"), lambda r: r.update(extra=True)):
            invalid = deepcopy(saved["result"])
            mutate(invalid)
            assert client.post("/api/projects", json={"project": original, "result": invalid}).status_code == 422
    with TestClient(create_app(database), base_url="http://localhost") as client:
        assert client.get(f"/api/projects/{saved['id']}").json() == saved


def test_genuine_historical_server_snapshot_reads_unchanged(tmp_path):
    source = FIXTURES / "legacy_server_snapshot.sqlite"
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    target = tmp_path / "historical.db"
    shutil.copyfile(source, target)
    expected = json.loads((FIXTURES / "legacy_server_snapshot.json").read_text())
    with TestClient(create_app(f"sqlite:///{target}"), base_url="http://localhost") as client:
        response = client.get(f"/api/projects/{expected['id']}")
        assert response.status_code == 200, response.text
        assert response.json() == expected
        assert response.json()["provenance"]["source"] == "server_computed"
        StoredServerSnapshot.model_validate(response.json(), strict=True)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash


@pytest.mark.parametrize("mutate", [
    lambda p: p.update(schema_version="1.2"), lambda p: p.update(schema_version="1.0"),
    lambda p: p["layers"][1].update(geometry="triangle"),
    lambda p: p["layers"][1].update(cd_nm=40), lambda p: p["layers"][1].update(background={}),
    lambda p: p["layers"][1].update(id="slab"), lambda p: p.update(layers=[]),
    lambda p: p.update(layers=p["layers"] * 5),
])
def test_stack_invalid_scope_rejected_before_jobs(client, mutate):
    project = stack_project()
    mutate(project)
    for route, body in [("/api/validate", project), ("/api/jobs", {"project": project})]:
        assert client.post(route, json=body).status_code == 422
    assert not client.app.state.jobs.jobs


def test_lower_layer_material_coverage_and_fit_scope(client):
    project = stack_project()
    fit = {"kind": "fit", "project": project, "fit": {"target_cd_nm": 180}}
    assert client.post("/api/jobs", json=fit).status_code == 422
    project["layers"] = project["layers"][1:]
    assert client.post("/api/jobs", json=fit).status_code == 422
    project = stack_project()
    project["layers"][1]["material"].update(kind="tabulated", wavelengths_nm=[400.0, 600.0],
                                           n_values=[1.5, 1.5], k_values=[0.0, 0.0])
    response = client.post("/api/validate", json=project)
    assert response.status_code == 422
    assert any(d["code"] == "material_coverage" and d["location"] == ["layers", 1, "material", "wavelengths_nm"]
               for d in response.json()["error"]["diagnostics"])
    assert not client.app.state.jobs.jobs


def test_stack_preview_atomic_deterministic_readonly_and_bound(client, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Stack previews cannot inspect engine, allocate jobs, or save")
    monkeypatch.setattr("api.main.engine_info", forbidden)
    monkeypatch.setattr("rcwa_core.preflight.engine_info", forbidden)
    monkeypatch.setattr(client.app.state.jobs, "submit", forbidden)
    monkeypatch.setattr(client.app.state.store, "save", forbidden)
    queries = []
    event.listen(client.app.state.store.engine, "before_cursor_execute", lambda *args: queries.append(args))
    base = stack_project()
    layers = deepcopy(base["layers"])
    layers[0]["cd_nm"] = 90
    layers[1]["thickness_nm"] = 95
    body = {"base_project": base, "changes": {"period_nm": 100, "layers": layers}}
    original = deepcopy(body)
    response = client.post("/api/stack-change-preview", json=body)
    assert response.status_code == 200, response.text
    actual = response.json()
    assert body == original
    assert actual == client.post("/api/stack-change-preview", json=body).json()
    assert actual["candidate_project"]["period_nm"] == 100
    assert actual["candidate_project"]["layers"][0]["cd_nm"] == 90
    assert [item["path"] for item in actual["diff"]] == ["period_nm", "layers[0].cd_nm", "layers[1].thickness_nm"]
    request = StackChangePreviewRequest.model_validate(body)
    validate_stack_proposal_binding(actual, request)
    assert not queries and not client.app.state.jobs.jobs and not client.app.state.jobs.inputs
    # A change affecting the whole project must not be silently applied only to layers[0].
    assert client.post("/api/change-preview", json={"base_project": base, "changes": {"cd_nm": 90}}).status_code == 422


def test_stack_promotion_reorder_add_remove_and_material_tables(client):
    legacy = Project().model_dump()
    promoted = client.post("/api/stack-change-preview", json={"base_project": legacy, "changes": {"period_nm": 400}}).json()
    assert promoted["base_project"] == legacy
    assert promoted["candidate_project"]["schema_version"] == "1.1"
    assert promoted["diff"] == [{"kind": "value", "path": "schema_version", "before": "1.0", "after": "1.1"}]
    base = stack_project()
    layers = list(reversed(base["layers"]))
    changed = preview_stack_changes(StackChangePreviewRequest(base_project=base, changes={"layers": layers}))
    assert [d.kind for d in changed.diff] == ["layer", "layer"]
    assert [d.path for d in changed.diff] == ["layers[0]", "layers[1]"]
    layers = deepcopy(base["layers"])
    layers[1]["material"] = table_material().model_dump()
    changed = preview_stack_changes(StackChangePreviewRequest(base_project=base, changes={"layers": layers}))
    assert len(changed.diff) == 1
    entry = changed.diff[0].model_dump()
    assert entry["kind"] == "material" and entry["path"] == "layers[1].material"
    assert entry["after"]["table"]["rows"] == 2000
    assert "n_values" not in json.dumps(entry) and len(compact(entry)) < 1000
    altered = table_material()
    checksum = material_summary(altered).table.checksum
    altered.n_values[-1] += 0.001
    assert material_summary(altered).table.checksum != checksum
    for replacement, expected_index in [(base["layers"][:1], 1), (base["layers"] + [base["layers"][1]], 2)]:
        diff = preview_stack_changes(StackChangePreviewRequest(base_project=base, changes={"layers": replacement})).diff
        assert len(diff) == 1 and diff[0].kind == "layer" and diff[0].path == f"layers[{expected_index}]"


@pytest.mark.parametrize("changes", [{}, None, {"layers": []}, {"layers": None}, {"period_nm": None},
                                     {"period_nm": True}, {"period_nm": "400"}, {"apply": True},
                                     {"layers": [{"geometry": "homogeneous", "thickness_nm": True}]},
                                     {"layers": [{"geometry": "homogeneous", "material": {"n": "2.1"}}]}])
def test_stack_preview_strict_changes(client, changes):
    assert client.post("/api/stack-change-preview", json={"base_project": {}, "changes": changes}).status_code == 422


@pytest.mark.parametrize("mutate", [
    lambda p: p.update(schema_version="rcwa-change-proposal/9"), lambda p: p.pop("valid"),
    lambda p: p.update(extra=True), lambda p: p.update(base_input_hash="0" * 64),
    lambda p: p.update(candidate_input_hash="0" * 64), lambda p: p["candidate_project"].update(name="Injected"),
    lambda p: p["base_project"].update(name="Unrelated"), lambda p: p.update(diff=[]),
    lambda p: p["changes"].update(period_nm=380), lambda p: p["diagnostics"].append(
        {"code": "fake", "severity": "warning", "location": [], "message": "Forged"}),
])
def test_stack_proposal_binding_rejects_forgery(mutate):
    request = StackChangePreviewRequest(base_project=stack_project(), changes={"period_nm": 390})
    payload = preview_stack_changes(request).model_dump()
    mutate(payload)
    with pytest.raises((ValidationError, ValueError)):
        StackChangeProposal.model_validate(payload, strict=True)
        validate_stack_proposal_binding(payload, request)


def test_stack_preview_large_roundtrip_and_exact_byte_limits(client, monkeypatch):
    # Real tabulated inputs close to the request limit produce a >2 MB proposal.
    body = large_preview_request()
    encoded = compact(body)
    assert 1_800_000 < len(encoded) < 2_000_000, len(encoded)
    response = client.post("/api/stack-change-preview", content=encoded)
    assert response.status_code == 200, response.text[:1000]
    assert 2_000_000 < len(response.content) < MAX_PROPOSAL_BYTES
    payload = response.json()
    StackChangeProposal.model_validate(payload, strict=True)
    validate_stack_proposal_binding(payload, StackChangePreviewRequest.model_validate(body))
    assert len(payload["diff"]) == 1
    # The actual limit applies to UTF-8 bytes, including finite valid JSON padding.
    oversized = encoded + b" " * (2_000_001 - len(encoded))
    assert client.post("/api/stack-change-preview", content=oversized).status_code == 413
    monkeypatch.setattr("api.stack_change_preview.MAX_PROPOSAL_BYTES", len(response.content) - 1)
    rejected = client.post("/api/stack-change-preview", content=encoded)
    assert rejected.status_code == 413 and rejected.json()["error"]["code"] == "proposal_too_large"
    monkeypatch.setattr("api.stack_change_preview.MAX_PROPOSAL_BYTES", MAX_PROPOSAL_BYTES)
    class TooLarge:
        def model_dump(self, **kwargs):
            return {"padding": "x" * MAX_PROPOSAL_BYTES}
    with pytest.raises(ProposalTooLarge, match="8 MB"):
        bounded_proposal(TooLarge())


def test_stack_http_security_and_nonfinite(client):
    body = {"base_project": {}, "changes": {"period_nm": 390}}
    assert client.post("/api/stack-change-preview", json=body, headers={"Host": "remote.example"}).status_code == 400
    assert client.post("/api/stack-change-preview", json=body, headers={"Origin": "https://remote.example"}).status_code == 403
    for token in ("NaN", "Infinity", "-Infinity", "1e999"):
        response = client.post("/api/stack-change-preview", content='{"base_project":{},"changes":{"period_nm":'+token+'}}')
        assert response.status_code == 422 and response.json()["error"]["code"] == "invalid_json"


@pytest.mark.parametrize("version", [None, [], {}, True, 1.1, "1.2"])
def test_import_wrong_version_types_are_typed_rejections(client, version):
    historical = json.loads((FIXTURES / "legacy_server_snapshot.json").read_text())
    historical["result"]["schema_version"] = version
    response = client.post("/api/projects", json={"project": historical["project"], "result": historical["result"]})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_input"
