from copy import deepcopy
import gzip
import json
import os
from pathlib import Path
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from pydantic import TypeAdapter, ValidationError

from api.contracts import CurrentResult, JobResponse, SavedProject, ServerSnapshot, StoredServerSnapshot
from api.main import SaveRequest, create_app
from rcwa_core.contracts_2d import PublicForwardResult2D
from rcwa_core.project_io import forward_project, normalized_project_and_hash, validate_result_for_project
from rcwa_core.schemas import Project
from test_project_dispatch import PROJECT_CASES, small_2d_project
from test_project_identity import PHYSICAL_PATHS_2D, integral_float_fields, replace_path, table_project


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'public-2d.db'}"), base_url="http://localhost") as client:
        yield client


@pytest.fixture(scope="module")
def solved_2d():
    model, project, digest = normalized_project_and_hash(small_2d_project())
    result = forward_project(model)
    validate_result_for_project("forward", result, model)
    return project, result, digest


def snapshot_for(project, result, digest):
    return {
        "id": str(uuid4()), "name": project["name"], "created_at": "2026-10-10T12:00:00+00:00",
        "updated_at": "2026-10-10T12:00:01+00:00", "project": deepcopy(project), "result": deepcopy(result),
        "provenance": {
            "source": "server_computed", "job_id": str(uuid4()), "input_hash": digest,
            "project_schema_version": project["schema_version"], "result_schema_version": result["schema_version"],
            "engine": result["metadata"]["engine"], "engine_version": result["metadata"]["version"],
            "adapter_version": result["metadata"]["adapter_version"],
        },
    }


def wait_job(client, job_id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        response = client.get(f"/api/jobs/{job_id}")
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] != "running":
            return job
        time.sleep(0.04)
    pytest.fail("Small real 2D HTTP job exceeded its test deadline")


def forbid_submit(client, monkeypatch):
    def fail(*args, **kwargs):
        pytest.fail("Rejected or validation-only input reached process allocation")
    monkeypatch.setattr(client.app.state.jobs, "submit", fail)


def assert_no_work(client):
    assert not client.app.state.jobs.jobs
    assert not client.app.state.jobs.running
    assert client.get("/api/projects").json() == []


def test_2d_capabilities_and_validation_are_version_specific_and_solve_free(client, monkeypatch):
    forbid_submit(client, monkeypatch)
    caps = client.get("/api/capabilities").json()
    assert caps["supported_project_schema_versions"] == ["1.0", "1.1", "1.2"]
    assert caps["supported_result_schema_versions"] == ["1.0", "1.1", "1.2"]
    assert caps["limits"]["wavelength_count"] == 81
    assert caps["limits"]["harmonics_max"] == 20
    profile = caps["project_profiles"]["1.2"]
    assert profile["wavelength_count"] == 31 and profile["basis_size_max"] == 121
    assert profile["harmonics"] == {"x": [1, 5], "y": [1, 5]}
    assert profile["adapter_version"] == "1.4.0" and profile["simultaneous_profile_jobs"] == 1
    assert "3.0" in profile["integer_representation"]
    for operation in ("synthetic_fit", "preview_changes", "preview_stack_changes"):
        assert operation not in profile["operations"]
        assert operation in caps["project_profiles"]["1.1"]["operations"]
    assert client.get("/api/example").json()["schema_version"] in {"1.0", "1.1"}
    model, expected, digest = normalized_project_and_hash(table_project())
    for project in (table_project(), integral_float_fields(table_project())):
        response = client.post("/api/validate", json=project)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["valid"] and result["project"] == expected and result["input_hash"] == digest
    assert model.schema_version == "1.2"
    assert_no_work(client)


@pytest.mark.parametrize("path", PHYSICAL_PATHS_2D)
@pytest.mark.parametrize("value", [True, "1"])
def test_2d_nested_numbers_are_strict_at_all_http_intake_boundaries(client, monkeypatch, path, value):
    forbid_submit(client, monkeypatch)
    project = table_project()
    replace_path(project, path, value)
    for route, body in (("/api/validate", project), ("/api/jobs", {"project": project}),
                        ("/api/projects", {"project": project})):
        response = client.post(route, json=body)
        assert response.status_code == 422, (route, response.text)
        assert response.json()["error"]["code"] == "invalid_input"
        assert response.json()["error"]["diagnostics"]
    assert_no_work(client)


@pytest.mark.parametrize("extra", ["reference_basis", "laurent_diagnostic", "offline_reference_override", "factorization"])
def test_offline_reference_and_diagnostic_controls_are_not_public_request_options(client, monkeypatch, extra):
    forbid_submit(client, monkeypatch)
    value = {"reference_basis": [6, 6], "laurent_diagnostic": True,
             "offline_reference_override": True, "factorization": "diagnostic_laurent"}[extra]
    for location in ("request", "project", "solver"):
        body = {"project": small_2d_project()}
        target = body if location == "request" else body["project"]
        if location == "solver":
            target = target["solver"]
        target[extra] = value
        response = client.post("/api/jobs", json=body)
        assert response.status_code == 422, response.text
    assert_no_work(client)


def test_2d_fit_and_both_proposals_reject_before_process_allocation(client, monkeypatch):
    forbid_submit(client, monkeypatch)
    project = small_2d_project()
    requests = [
        ("/api/jobs", {"kind": "fit", "project": project, "fit": {"target_cd_nm": 180}}),
        ("/api/change-preview", {"base_project": project, "changes": {"cd_nm": 180}}),
        ("/api/stack-change-preview", {"base_project": project, "changes": {"period_nm": 480}}),
    ]
    for path, body in requests:
        response = client.post(path, json=body)
        assert response.status_code == 422, response.text
        assert response.json()["error"]["diagnostics"]
    assert_no_work(client)


@pytest.mark.parametrize("raw", [b'{"period_y_nm":NaN}', b'{"period_y_nm":Infinity}',
                                  b'{"name":"\\ud800"}', b'{"\\udfff":1}'])
def test_2d_nonfinite_or_surrogate_json_cannot_be_stored(client, monkeypatch, raw):
    forbid_submit(client, monkeypatch)
    base = json.dumps(small_2d_project(), ensure_ascii=False).encode()
    # Append invalid members to a real 1.2 body, retaining its explicit dispatch.
    body = base[:-1] + b"," + raw[1:]
    for path, payload in (("/api/validate", body), ("/api/jobs", b'{"project":' + body + b'}'),
                          ("/api/projects", b'{"project":' + body + b'}')):
        response = client.post(path, content=payload, headers={"Content-Type": "application/json"})
        assert response.status_code == 422, response.text
        assert len(response.content) < 64_000
    assert_no_work(client)


def test_real_small_result_uses_public_metadata_channels_and_schema(solved_2d):
    project, result, digest = solved_2d
    assert result["schema_version"] == "1.2"
    meta = result["metadata"]
    assert meta["input_hash"] == digest and meta["adapter_version"] == "1.4.0"
    assert meta["stage"] == "bounded_forward" and not meta["offline_reference_override"]
    assert meta["factorization"] == "directional_inverse_rule" and not meta["convergence_checked"]
    assert meta["retained_orders"] == [[m, n] for n in range(-1, 2) for m in range(-1, 2)]
    assert meta["basis_size"] == 9 and set(result["spectra"]) == {"s", "p"}
    for spectrum in result["spectra"].values():
        assert len(spectrum["orders"]) == 1
        for order in spectrum["orders"][0]:
            assert all(channel in order for channel in ("R_s", "R_p", "T_s", "T_p"))
    for model in (PublicForwardResult2D, TypeAdapter(CurrentResult)):
        schema = model.model_json_schema() if isinstance(model, type) else model.json_schema()
        Draft202012Validator(schema).validate(result)
    assert validate_result_for_project("forward", result, project).model_dump(mode="json") == result


@pytest.mark.parametrize("key,value", [("offline_reference_override", True), ("factorization", "diagnostic_laurent"),
                                       ("harmonics_x", 6), ("harmonics_y", 0), ("adapter_version", "1.2.0-numerical"),
                                       ("stage", "numerical_only")])
def test_public_result_runtime_and_json_schema_reject_reference_or_historical_metadata(solved_2d, key, value):
    _, original, _ = solved_2d
    result = deepcopy(original)
    result["metadata"][key] = value
    assert not Draft202012Validator(PublicForwardResult2D.model_json_schema()).is_valid(result)
    with pytest.raises(ValidationError):
        PublicForwardResult2D.model_validate(result, strict=True)


@pytest.mark.parametrize("path,value", [(("layers", 0, "cd_y_nm"), 181.0),
                                       (("illumination", "azimuth_deg"), 26.0),
                                       (("layers", 0, "material", "n"), 1.66),
                                       (("period_y_nm",), 421.0),
                                       (("illumination", "polarization"), "s"),
                                       (("illumination", "wavelengths_nm", 0), 651.0)])
def test_result_import_and_snapshot_bind_to_exact_y_phi_material_and_full_input(solved_2d, path, value):
    project, result, digest = solved_2d
    changed = deepcopy(project)
    replace_path(changed, path, value)
    with pytest.raises(ValueError):
        validate_result_for_project("forward", result, changed)
    with pytest.raises(ValidationError):
        SaveRequest(project=changed, result=result)
    snapshot = snapshot_for(changed, result, digest)
    for model in (SavedProject, ServerSnapshot, StoredServerSnapshot):
        with pytest.raises(ValidationError):
            model.model_validate(snapshot, strict=True)


@pytest.mark.parametrize("path,value", [
    (("provenance", "source"), "unverified_import"), (("provenance", "input_hash"), "0" * 64),
    (("provenance", "project_schema_version"), "1.1"), (("provenance", "result_schema_version"), "1.1"),
    (("provenance", "engine"), "other"), (("provenance", "engine_version"), "unknown"),
    (("provenance", "adapter_version"), "1.1.0"), (("provenance", "job_id"), None),
    (("result", "metadata", "input_hash"), "0" * 64),
])
def test_server_and_stored_snapshot_reject_mismatched_provenance(solved_2d, path, value):
    snapshot = snapshot_for(*solved_2d)
    for model in (ServerSnapshot, StoredServerSnapshot):
        model.model_validate(snapshot, strict=True)
    replace_path(snapshot, path, value)
    for model in (ServerSnapshot, StoredServerSnapshot):
        with pytest.raises(ValidationError):
            model.model_validate(snapshot, strict=True)


@pytest.mark.parametrize("path,value", [(("input_hash",), "0" * 64), (("kind",), "fit"),
                                       (("status",), "cancelled"), (("status",), "failed"),
                                       (("status",), "running")])
def test_2d_job_response_binds_terminal_kind_and_input_hash(solved_2d, path, value):
    _, result, digest = solved_2d
    job = {"id": "job", "kind": "forward", "status": "succeeded", "created_at": "now", "completed_at": "then",
           "input_hash": digest, "result": result, "error": None, "error_code": None}
    JobResponse.model_validate(job, strict=True)
    replace_path(job, path, value)
    with pytest.raises(ValidationError):
        JobResponse.model_validate(job, strict=True)


def test_explicit_legacy_input_legitimately_emits_current_legacy_result():
    project = Project(schema_version="1.0").model_dump(mode="json")
    project["illumination"]["wavelengths_nm"] = [650.0]
    project["solver"]["harmonics"] = 1
    result = forward_project(project)
    assert result["schema_version"] == "1.1"
    validate_result_for_project("forward", result, project)
    snapshot = snapshot_for(project, result, normalized_project_and_hash(project)[2])
    ServerSnapshot.model_validate(snapshot, strict=True)
    StoredServerSnapshot.model_validate(snapshot, strict=True)


def test_imports_remain_unverified_and_client_provenance_cannot_be_promoted(client, solved_2d):
    project, result, digest = solved_2d
    imported = client.post("/api/projects", json={"project": project, "result": result})
    assert imported.status_code == 201, imported.text
    saved = imported.json()
    assert saved["provenance"]["source"] == "unverified_import"
    assert saved["provenance"]["job_id"] is None
    assert saved["project"] == project and saved["result"] == result
    assert client.get(f"/api/projects/{saved['id']}").json() == saved
    forged = {"project": project, "result": result, "provenance": snapshot_for(*solved_2d)["provenance"]}
    assert client.post("/api/projects", json=forged).status_code == 422
    assert len(client.get("/api/projects").json()) == 1
    assert not client.app.state.jobs.jobs


@pytest.mark.parametrize("source", ["server_computed", "unverified_import"])
@pytest.mark.parametrize("path,value", [(("result", "metadata", "input_hash"), "0" * 64),
                                       (("project", "layers", 0, "cd_y_nm"), 71.0)])
def test_corrupt_stored_2d_input_or_result_returns_bounded_integrity_error(client, solved_2d, monkeypatch,
                                                                        source, path, value):
    snapshot = snapshot_for(*solved_2d)
    if source == "unverified_import":
        snapshot["provenance"] = {"source": source}
    SavedProject.model_validate(snapshot, strict=True)
    replace_path(snapshot, path, value)
    monkeypatch.setattr(client.app.state.store, "get", lambda _: snapshot)
    response = client.get(f"/api/projects/{snapshot['id']}")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "invalid_stored_snapshot"
    assert len(response.content) < 1000
    assert "spectra" not in response.text


@pytest.mark.parametrize("backend", ["sqlite", "postgres"])
def test_real_http_solve_snapshot_idempotency_and_database_restart(tmp_path, backend):
    if backend == "postgres" and not os.getenv("TEST_POSTGRES_URL"):
        pytest.skip("No PostgreSQL test service configured")
    url = os.environ["TEST_POSTGRES_URL"] if backend == "postgres" else f"sqlite:///{tmp_path / 'restart.db'}"
    with TestClient(create_app(url), base_url="http://localhost") as client:
        project = small_2d_project()
        valid = client.post("/api/validate", json=project).json()
        assert valid["valid"]
        started = client.post("/api/jobs", json={"project": integral_float_fields(project)})
        assert started.status_code == 202, started.text
        job = wait_job(client, started.json()["id"])
        assert job["status"] == "succeeded", job
        assert started.json()["input_hash"] == valid["input_hash"] == job["input_hash"]
        assert job["result"]["metadata"]["input_hash"] == valid["input_hash"]
        saved = client.post("/api/snapshots", json={"job_id": job["id"]})
        assert saved.status_code == 201, saved.text
        snapshot = saved.json()
        assert snapshot["project"] == valid["project"] and snapshot["result"] == job["result"]
        assert snapshot["provenance"]["input_hash"] == job["input_hash"]
        assert snapshot["provenance"]["source"] == "server_computed"
        assert snapshot["provenance"]["adapter_version"] == "1.4.0"
        assert snapshot["provenance"]["project_schema_version"] == "1.2"
        assert snapshot["provenance"]["result_schema_version"] == "1.2"
        assert client.post("/api/snapshots", json={"job_id": job["id"]}).json() == snapshot
        for key, value in (("project", project), ("result", job["result"]), ("input_hash", "0" * 64)):
            assert client.post("/api/snapshots", json={"job_id": job["id"], key: value}).status_code == 422
        assert client.get(f"/api/projects/{snapshot['id']}").json() == snapshot
    with TestClient(create_app(url), base_url="http://localhost") as restarted:
        assert restarted.get(f"/api/projects/{snapshot['id']}").json() == snapshot
        listed = next(row for row in restarted.get("/api/projects").json() if row["id"] == snapshot["id"])
        assert listed["provenance"] == snapshot["provenance"]
        assert restarted.get(f"/api/jobs/{job['id']}").status_code == 404
        assert not restarted.app.state.jobs.jobs


def test_real_oversized_export_returns_413_and_project_only_import_remains_usable(client, monkeypatch):
    forbid_submit(client, monkeypatch)
    root = Path(__file__).parent / "fixtures" / "true-2d"
    project = json.loads((root / "default-project.json").read_text(encoding="utf-8"))
    # This is the real archived export's byte-size case, not numerical evidence for
    # the integrated adapter. Its old metadata must not be relabeled or refreshed.
    with gzip.open(root / "default-result-H5.json.gz", "rt", encoding="utf-8") as stream:
        archived = json.load(stream)
    body = json.dumps({"project": project, "result": archived}, indent=2, ensure_ascii=False).encode("utf-8")
    assert len(body) > 2_000_000
    rejected = client.post("/api/projects", content=body, headers={"Content-Type": "application/json"})
    assert rejected.status_code == 413, rejected.text
    assert rejected.json()["error"]["code"] == "body_too_large"
    assert_no_work(client)
    imported = client.post("/api/projects", json={"project": project, "result": None})
    assert imported.status_code == 201, imported.text
    assert imported.json()["result"] is None and imported.json()["provenance"]["source"] == "unverified_import"
    assert client.get(f"/api/projects/{imported.json()['id']}").json() == imported.json()


def test_request_cap_counts_actual_multibyte_utf8_bytes_at_both_edges(client, monkeypatch):
    forbid_submit(client, monkeypatch)
    body = json.dumps(small_2d_project(), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    assert len(body) > len(body.decode("utf-8"))
    for size, status in ((1_999_999, 200), (2_000_000, 200), (2_000_001, 413)):
        padded = body + b" " * (size - len(body))
        response = client.post("/api/validate", content=padded, headers={"Content-Type": "application/json"})
        assert response.status_code == status, response.text
        if status == 200:
            assert response.json()["valid"]
        else:
            assert response.json()["error"]["code"] == "body_too_large"
    assert_no_work(client)


@pytest.mark.parametrize("name,project,accepted", PROJECT_CASES, ids=[case[0] for case in PROJECT_CASES])
def test_all_version_and_geometry_dispatch_cases_at_actual_http_boundaries(client, monkeypatch, name, project, accepted):
    forbid_submit(client, monkeypatch)
    response = client.post("/api/validate", json=project)
    assert response.status_code == (200 if accepted else 422), (name, response.text)
    imported = client.post("/api/projects", json={"project": project})
    assert imported.status_code == (201 if accepted else 422), (name, imported.text)
    if accepted:
        _, normalized, digest = normalized_project_and_hash(project)
        assert response.json()["project"] == imported.json()["project"] == normalized
        assert response.json()["input_hash"] == digest
        assert imported.json()["provenance"]["source"] == "unverified_import"
    else:
        assert client.post("/api/jobs", json={"project": project}).status_code == 422
        assert_no_work(client)
    assert not client.app.state.jobs.jobs


def test_actual_openapi_response_schemas_accept_both_public_result_families(solved_2d):
    schema = create_app().openapi()
    project, result, digest = solved_2d
    snapshot = snapshot_for(project, result, digest)
    job = {"id": "job", "kind": "forward", "status": "succeeded", "created_at": "now", "completed_at": "then",
           "input_hash": digest, "result": result, "error": None, "error_code": None}
    for route, method, status, payload in (("/api/jobs/{job_id}", "get", "200", job),
                                           ("/api/snapshots", "post", "201", snapshot),
                                           ("/api/projects/{project_id}", "get", "200", snapshot)):
        response = schema["paths"][route][method]["responses"][status]["content"]["application/json"]["schema"]
        exported = {**response, "components": schema["components"]}
        Draft202012Validator.check_schema(exported)
        Draft202012Validator(exported).validate(payload)
    # New explicit 2D support must not turn omitted version into an invalid discriminator.
    legacy = Project().model_dump(mode="json")
    legacy["illumination"]["wavelengths_nm"] = [650.0]
    legacy["solver"]["harmonics"] = 1
    old_result = forward_project(legacy)
    job.update(input_hash=normalized_project_and_hash(legacy)[2], result=old_result)
    response = schema["paths"]["/api/jobs/{job_id}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    Draft202012Validator({**response, "components": schema["components"]}).validate(job)


def test_both_snapshot_readers_reject_2d_result_with_a_legacy_project(solved_2d):
    _, result, _ = solved_2d
    legacy = Project(schema_version="1.0").model_dump(mode="json")
    snapshot = snapshot_for(legacy, result, normalized_project_and_hash(legacy)[2])
    for model in (SavedProject, ServerSnapshot, StoredServerSnapshot):
        with pytest.raises(ValidationError):
            model.model_validate(snapshot, strict=True)
    with pytest.raises(ValidationError):
        SaveRequest(project=legacy, result=result)
