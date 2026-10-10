"""Agent boundary proofs: no-job checks, lifecycle and durable input binding."""

import json
import time
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from api.main import create_app
from api.jobs import JobManager, Running
from api.storage import canonical_hash
from rcwa_core.schemas import Project


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'agent.db'}"), base_url="http://localhost") as client:
        yield client


def small_project():
    project = Project().model_dump()
    project["illumination"]["wavelengths_nm"] = [650.0]
    project["solver"]["harmonics"] = 3
    return project


def wait_job(client, job_id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] != "running":
            return job
        time.sleep(0.03)
    pytest.fail("Real numerical job exceeded test deadline")


def test_contract_and_no_process_validation(client, monkeypatch):
    def no_submit(*args, **kwargs):
        pytest.fail("Validation must not allocate a numerical process")

    monkeypatch.setattr(client.app.state.jobs, "submit", no_submit)
    project = small_project()
    response = client.post("/api/validate", json=project)
    assert response.status_code == 200
    assert response.json()["valid"]
    assert response.json()["input_hash"] == canonical_hash(project)
    assert not client.app.state.jobs.jobs
    caps = client.get("/api/capabilities").json()
    assert caps["engine"]["available"]
    assert caps["limits"]["layers"] == 8
    assert caps["limits"]["request_bytes"] == 2_000_000
    schema = client.get("/openapi.json").json()
    assert schema["paths"]["/api/jobs/{job_id}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("JobResponse")
    assert schema["paths"]["/api/snapshots"]["post"]["responses"]["201"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("ServerSnapshot")
    assert schema["components"]["schemas"]["Project-Input"]["properties"]["layers"]["maxItems"] == 8
    assert "ForwardResult" in schema["components"]["schemas"]
    assert "SyntheticFitResult" in schema["components"]["schemas"]


@pytest.mark.parametrize(
    "change",
    [
        lambda p: p.update(unknown=True),
        lambda p: p["layers"][0].update(geometry="triangle_2d"),
        lambda p: p["layers"].append(deepcopy(p["layers"][0])),
        lambda p: p["substrate"].update(
            kind="tabulated", wavelengths_nm=[400, 600], n_values=[1.5, 1.5], k_values=[0, 0]
        ),
    ],
)
def test_rejection_before_process(client, change):
    project = small_project()
    change(project)
    for route, body in [("/api/validate", project), ("/api/jobs", {"project": project})]:
        response = client.post(route, json=body)
        assert response.status_code == 422, response.text
        assert response.json()["error"]["diagnostics"]
    assert not client.app.state.jobs.jobs


def test_preflight_basis_and_cutoff(client):
    project = small_project()
    project["period_nm"] = 5000
    project["solver"]["harmonics"] = 1
    result = client.post("/api/validate", json=project).json()
    assert not result["valid"]
    assert any("harmonic" in d["message"].lower() for d in result["diagnostics"])
    assert client.post("/api/jobs", json={"project": project}).status_code == 422
    project = small_project()
    project["period_nm"] = 650
    project["illumination"]["angle_deg"] = 0
    result = client.post("/api/validate", json=project).json()
    assert not result["valid"]
    assert any("cutoff" in d["message"].lower() for d in result["diagnostics"])
    assert not client.app.state.jobs.jobs


def test_origins_host_and_finite_json(client):
    project = small_project()
    assert (
        client.post("/api/jobs", json={"project": project}, headers={"Origin": "https://evil.example"}).status_code
        == 403
    )
    assert client.delete("/api/jobs/missing", headers={"Origin": "null"}).status_code == 403
    assert client.get("/api/capabilities", headers={"Host": "evil.example"}).status_code == 400
    assert client.post("/api/validate", json=project, headers={"Origin": "http://localhost:5173"}).status_code == 200
    for token in ["NaN", "Infinity", "1e999"]:
        body = json.dumps(project).replace("400.0", token)
        response = client.post("/api/validate", content=body)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "invalid_json"
    assert not client.app.state.jobs.jobs


def test_unavailable_engine(client, monkeypatch):
    from rcwa_core.preflight import engine_info

    unavailable = engine_info().model_copy(update={"available": False, "message": "Required engine is unavailable"})
    monkeypatch.setattr("api.main.engine_info", lambda: unavailable)
    assert not client.get("/api/capabilities").json()["engine"]["available"]
    assert not client.post("/api/validate", json=small_project()).json()["valid"]
    response = client.post("/api/jobs", json={"project": small_project()})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "engine_unavailable"
    assert not client.app.state.jobs.jobs


def test_snapshot_binding_idempotence_spoofing_and_restart(tmp_path):
    database = f"sqlite:///{tmp_path / 'persist.db'}"
    with TestClient(create_app(database), base_url="http://localhost") as client:
        project = small_project()
        original = deepcopy(project)
        job = client.post("/api/jobs", json={"project": project}).json()
        project["layers"][0]["cd_nm"] = 3
        complete = wait_job(client, job["id"])
        assert complete["status"] == "succeeded", complete
        saved = client.post("/api/snapshots", json={"job_id": job["id"]})
        assert saved.status_code == 201, saved.text
        saved = saved.json()
        assert saved["project"] == original
        assert saved["result"] == complete["result"]
        assert saved["provenance"]["source"] == "server_computed"
        assert saved["provenance"]["input_hash"] == canonical_hash(original)
        assert client.post("/api/snapshots", json={"job_id": job["id"]}).json()["id"] == saved["id"]
        assert client.post("/api/snapshots", json={"job_id": job["id"], "project": project}).status_code == 422
        assert (
            client.post(
                "/api/projects",
                json={"project": original, "result": complete["result"], "provenance": saved["provenance"]},
            ).status_code
            == 422
        )
        imported = client.post("/api/projects", json={"project": original, "result": complete["result"]}).json()
        assert imported["provenance"]["source"] == "unverified_import"
        assert imported["id"] != saved["id"]
        assert client.get(f"/api/projects/{saved['id']}").json() == saved
    with TestClient(create_app(database), base_url="http://localhost") as client:
        assert client.get(f"/api/projects/{saved['id']}").json() == saved
        assert client.get(f"/api/jobs/{job['id']}").status_code == 404
        assert client.post("/api/snapshots", json={"job_id": job["id"]}).status_code == 404


def test_unsuccessful_jobs_cannot_save(client):
    job = client.post("/api/jobs", json={"project": Project().model_dump()}).json()
    assert client.post("/api/snapshots", json={"job_id": job["id"]}).status_code == 409
    client.delete(f"/api/jobs/{job['id']}")
    assert client.post("/api/snapshots", json={"job_id": job["id"]}).status_code == 409
    client.app.state.jobs.jobs[job["id"]]["status"] = "failed"
    assert client.post("/api/snapshots", json={"job_id": job["id"]}).status_code == 409
    assert client.post("/api/snapshots", json={"job_id": "missing"}).status_code == 404


class DeadProcess:
    def is_alive(self):
        return False

    def join(self, **kwargs):
        pass

    def close(self):
        pass


@pytest.mark.parametrize(
    "payload",
    [[], {"result": {}, "error": None, "error_code": None}, {"result": None, "error": 13, "error_code": "failure"}],
)
def test_malformed_worker_never_succeeds(tmp_path, payload):
    manager = JobManager()
    try:
        output = tmp_path / "worker.json"
        output.write_text(json.dumps(payload))
        manager.jobs["bad"] = {"kind": "forward", "status": "running"}
        manager.inputs["bad"] = {"project": small_project(), "fit": None}
        manager.running["bad"] = Running(DeadProcess(), time.monotonic(), output)
        manager.poll()
        assert manager.jobs["bad"]["status"] == "failed"
        assert manager.jobs["bad"]["error_code"] == "invalid_worker_output"
        assert not manager.running
    finally:
        manager.close()


def test_original_database_is_preserved(tmp_path):
    path = tmp_path / "legacy.db"
    engine = create_engine(f"sqlite:///{path}")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE projects (id VARCHAR(36) PRIMARY KEY, name VARCHAR(160) NOT NULL, created_at VARCHAR(40) NOT NULL, updated_at VARCHAR(40) NOT NULL, project TEXT NOT NULL, result TEXT)"
            )
        )
        connection.execute(
            text("INSERT INTO projects VALUES (:id,:name,:created,:updated,:project,NULL)"),
            {
                "id": "old",
                "name": "Original",
                "created": "2020-01-01",
                "updated": "2020-01-01",
                "project": json.dumps(small_project()),
            },
        )
    engine.dispose()
    with TestClient(create_app(f"sqlite:///{path}"), base_url="http://localhost") as client:
        old = client.get("/api/projects/old").json()
        assert old["project"] == small_project()
        assert old["provenance"]["source"] == "unverified_import"
        assert client.get("/api/projects").json()[0]["id"] == "old"


class IdleProcess:
    def __init__(self, *args, **kwargs):
        pass

    def start(self):
        pass

    def is_alive(self):
        return True

    def terminate(self):
        pass

    def join(self, **kwargs):
        pass

    def kill(self):
        pass

    def close(self):
        pass


def test_history_eviction_and_deep_input_capture():
    manager = JobManager()
    manager.context = type("FakeContext", (), {"Process": IdleProcess})
    try:
        for index in range(100):
            manager.jobs[str(index)] = {"status": "succeeded"}
            manager.inputs[str(index)] = {"project": {"old": True}}
        project = small_project()
        original = deepcopy(project)
        job = manager.submit("forward", project, None)
        project["layers"][0]["cd_nm"] = 1
        assert len(manager.jobs) == 100
        assert "0" not in manager.jobs and "0" not in manager.inputs
        assert manager.inputs[job["id"]]["project"] == original
        job["status"] = "forged"
        assert manager.jobs[job["id"]]["status"] == "running"
    finally:
        manager.close()


def test_numerical_failure_is_structured(tmp_path):
    manager = JobManager()
    try:
        output = tmp_path / "numerical.json"
        output.write_text(
            json.dumps({"result": None, "error": "Passive flux check failed", "error_code": "numerical_failure"})
        )
        manager.jobs["bad"] = {"kind": "forward", "status": "running"}
        manager.running["bad"] = Running(DeadProcess(), time.monotonic(), output)
        manager.poll()
        assert manager.jobs["bad"]["status"] == "failed"
        assert manager.jobs["bad"]["error_code"] == "numerical_failure"
        assert manager.jobs["bad"]["completed_at"]
    finally:
        manager.close()


def test_material_diagnostics_have_stable_field_location(client):
    project = small_project()
    project["substrate"].update(kind="tabulated", wavelengths_nm=[400, 600], n_values=[1.5, 1.5], k_values=[0, 0])
    response = client.post("/api/validate", json=project)
    assert response.status_code == 422
    diagnostic = response.json()["error"]["diagnostics"][0]
    assert diagnostic["code"] == "material_coverage"
    assert diagnostic["location"] == ["substrate", "wavelengths_nm"]


def test_legacy_result_without_discriminator_remains_importable(client):
    historical = json.loads((Path(__file__).parent / "fixtures" / "legacy_server_snapshot.json").read_text())
    project = historical["project"]
    result = historical["result"]
    result.pop("result_type")
    result["metadata"].pop("adapter_version")
    response = client.post("/api/projects", json={"project": project, "result": result})
    assert response.status_code == 201, response.text
    assert response.json()["result"] == result
    assert response.json()["provenance"]["source"] == "unverified_import"


@pytest.mark.parametrize(
    "host",
    [
        "[",
        "localhost:bad",
        "localhost:65536",
        "localhost:0",
        "user@localhost",
        "localhost:",
        "localhost:8000:9000",
        "localhost/evil",
        "localhost ",
        "evil.example",
        "::1",
    ],
)
def test_malformed_host_is_typed_rejection(client, host):
    response = client.get("/api/capabilities", headers={"Host": host})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "disallowed_host"


@pytest.mark.parametrize("host", ["localhost", "LOCALHOST:8000", "127.0.0.1:5173", "[::1]", "[::1]:8000"])
def test_loopback_authorities_are_accepted(client, host):
    assert client.get("/api/capabilities", headers={"Host": host}).status_code == 200
