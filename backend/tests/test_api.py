import time

import pytest
from fastapi.testclient import TestClient

from api.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'test.db'}"), base_url="http://localhost") as client:
        yield client


def test_health_example_and_validation(client):
    assert client.get("/api/health").json()["storage"] == "sqlite-demo"
    project = client.get("/api/example").json()
    project["layers"].append(project["layers"][0])
    assert client.post("/api/jobs", json={"project": project}).status_code == 422
    assert client.get("/api/jobs/missing").status_code == 404
    assert client.delete("/api/jobs/missing").status_code == 404


def test_save_reload(client):
    project = client.get("/api/example").json()
    from rcwa_core.schemas import Project
    from rcwa_core.solver import forward

    result = forward(Project.model_validate(project))
    saved = client.post("/api/projects", json={"project": project, "result": result})
    assert saved.status_code == 201
    project_id = saved.json()["id"]
    assert client.get(f"/api/projects/{project_id}").json()["project"] == project
    assert client.get(f"/api/projects/{project_id}").json()["result"] == result
    assert client.get("/api/projects").json()[0]["id"] == project_id
    assert client.get("/api/projects/missing").status_code == 404


def test_forward_process(client):
    project = client.get("/api/example").json()
    project["illumination"]["wavelengths_nm"] = [550.0]
    project["solver"]["harmonics"] = 3
    response = client.post("/api/jobs", json={"project": project})
    assert response.status_code == 202
    job_id = response.json()["id"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] not in {"running", "queued"}:
            break
        time.sleep(0.05)
    assert job["status"] == "succeeded", job
    assert job["result"]["wavelengths_nm"] == [550.0]


def test_admission_that_is_not_capacity_is_a_distinct_503(client, monkeypatch):
    project = client.get("/api/example").json()
    jobs = client.app.state.jobs
    monkeypatch.setattr(jobs, "poll", lambda: None)  # keep the injected stuck cleanup in place
    monkeypatch.setitem(jobs.cleanup_pending, "stuck", object())
    response = client.post("/api/jobs", json={"project": project})
    assert response.status_code == 503 and response.json()["error"]["code"] == "cleanup_pending"
    jobs.cleanup_pending.clear()
    monkeypatch.setattr(jobs, "_closed", True)
    response = client.post("/api/jobs", json={"project": project})
    assert response.status_code == 503 and response.json()["error"]["code"] == "manager_closed"
    monkeypatch.setattr(jobs, "_closed", False)


def test_cancel_and_capacity(client):
    project = client.get("/api/example").json()
    first = client.post("/api/jobs", json={"project": project}).json()
    second = client.post("/api/jobs", json={"project": project}).json()
    assert client.post("/api/jobs", json={"project": project}).status_code == 429
    for job in [first, second]:
        response = client.delete(f"/api/jobs/{job['id']}")
        assert response.json()["status"] == "cancelled"
        assert client.delete(f"/api/jobs/{job['id']}").json()["status"] == "cancelled"


def test_body_limit(client):
    assert client.post("/api/projects", content=b"x" * 2_000_001).status_code == 413


def test_invalid_fit_is_rejected_before_launch(client):
    project = client.get("/api/example").json()
    response = client.post(
        "/api/jobs",
        json={"kind": "fit", "project": project, "fit": {"target_cd_nm": 999, "lower_cd_nm": 40, "upper_cd_nm": 300}},
    )
    assert response.status_code == 422
    response = client.post("/api/jobs", json={"kind": "fit", "project": project, "fit": {"project": {}}})
    assert response.status_code == 422


def test_hard_timeout(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'timeout.db'}", job_timeout=0), base_url="http://localhost") as client:
        project = client.get("/api/example").json()
        job = client.post("/api/jobs", json={"project": project}).json()
        completed = client.get(f"/api/jobs/{job['id']}").json()
        assert completed["status"] == "failed"
        assert "time limit" in completed["error"]
        assert not client.app.state.jobs.running


def test_projects_survive_restart(tmp_path):
    database_url = f"sqlite:///{tmp_path / 'restart.db'}"
    with TestClient(create_app(database_url), base_url="http://localhost") as client:
        project = client.get("/api/example").json()
        saved = client.post("/api/projects", json={"project": project}).json()
    with TestClient(create_app(database_url), base_url="http://localhost") as client:
        assert client.get(f"/api/projects/{saved['id']}").json()["project"] == project


def test_malformed_saved_results_rejected(client):
    project = client.get("/api/example").json()
    assert client.post("/api/projects", json={"project": project, "result": {"test": 1}}).status_code == 422
    import json

    body = json.dumps({"project": project, "result": {"value": float("nan")}})
    assert client.post("/api/projects", content=body, headers={"Content-Type": "application/json"}).status_code == 422


def test_overflowing_json_number_rejected(client):
    import json

    project = client.get("/api/example").json()
    body = json.dumps({"project": project}).replace('"period_nm": 400.0', '"period_nm": 1e999')
    assert client.post("/api/jobs", content=body, headers={"Content-Type": "application/json"}).status_code == 422


def test_synthetic_fit_process(client):
    project = client.get("/api/example").json()
    project["illumination"]["wavelengths_nm"] = [450, 530, 610, 690, 770]
    project["solver"]["harmonics"] = 3
    response = client.post(
        "/api/jobs",
        json={"kind": "fit", "project": project, "fit": {"target_cd_nm": 207, "lower_cd_nm": 100, "upper_cd_nm": 300}},
    )
    assert response.status_code == 202
    job_id = response.json()["id"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] not in {"running", "queued"}:
            break
        time.sleep(0.05)
    assert job["status"] == "succeeded", job
    assert job["result"]["status"] == "converged"
    assert abs(job["result"]["fit_cd_nm"] - 207) < 0.01


def test_deeply_nested_import_is_rejected_before_it_is_stored(client):
    project = client.get("/api/example").json()
    project["illumination"]["wavelengths_nm"] = [550.0]
    project["solver"]["harmonics"] = 3
    job = client.post("/api/jobs", json={"project": project}).json()
    deadline = time.monotonic() + 30
    while (job := client.get(f"/api/jobs/{job['id']}").json())["status"] == "running" and time.monotonic() < deadline:
        time.sleep(0.05)
    result = job["result"]
    result["schema_version"] = "1.0"
    nested = level = {}
    for _ in range(300):
        level["a"] = level = {}
    result["metadata"]["x"] = nested
    response = client.post("/api/projects", json={"project": project, "result": result})
    assert response.status_code == 422 and "nest deeper" in response.text
    assert client.get("/api/projects").json() == []
