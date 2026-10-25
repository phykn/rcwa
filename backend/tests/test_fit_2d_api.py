"""Measured-spectrum dimension fits run as server jobs for schema 1.2 projects."""

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.main import create_app
from rcwa_core.project_io import forward_project, parse_project

EXAMPLE = Path(__file__).parents[1] / "api/examples/circular-hole-2d.json"


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'fit.db'}"), base_url="http://localhost") as client:
        yield client


def project():
    data = json.loads(EXAMPLE.read_text())
    data["solver"] = {"harmonics_x": 1, "harmonics_y": 1}
    return data


def spec(data, diameter=90.0):
    target = json.loads(json.dumps(data))
    target["layers"][0]["diameter_nm"] = diameter
    target["illumination"]["wavelengths_nm"] = [450.0, 550.0, 650.0, 750.0, 850.0]
    values = forward_project(parse_project(target))["spectra"]["s"]["R"]
    return {
        "parameters": [{"path": ["layers", 0, "diameter_nm"], "lower": 40, "upper": 120}],
        "wavelengths_nm": target["illumination"]["wavelengths_nm"],
        "values": values,
        "quantity": "R",
        "polarization": "s",
    }


def wait(client, job_id):
    for _ in range(300):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] != "running":
            return job
        time.sleep(0.1)
    raise AssertionError("fit job did not finish")


def test_dimension_fit_job_recovers_target_and_summarizes(client):
    data = project()
    response = client.post("/api/jobs", json={"kind": "fit", "project": data, "fit_2d": spec(data)})
    assert response.status_code == 202, response.text
    job = wait(client, response.json()["id"])
    assert job["status"] == "succeeded", job
    assert job["result"]["result_type"] == "dimension_fit"
    assert job["result"]["values"][0] == pytest.approx(90.0, abs=0.1)
    summary = client.get(f"/api/jobs/{job['id']}?view=summary").json()
    assert summary["result_summary"]["result_type"] == "dimension_fit"
    # The fitted design's forward warnings survive the fit and its summary.
    assert any("Convergence not assessed" in w for w in job["result"]["warnings"])
    assert summary["result_summary"]["warnings"] == job["result"]["warnings"]
    assert summary["result_summary"]["warnings_omitted_count"] == 0
    caps = client.get("/api/capabilities").json()
    assert "dimension_fit" in caps["project_profiles"]["1.2"]["operations"]


def test_fit_options_must_match_the_project_schema(client):
    data = project()
    legacy_options = {"target_cd_nm": 200.0}
    assert client.post("/api/jobs", json={"kind": "fit", "project": data, "fit": legacy_options}).status_code == 422
    assert client.post("/api/jobs", json={"kind": "fit", "project": data}).status_code == 422
    assert client.post("/api/jobs", json={"kind": "forward", "project": data, "fit_2d": spec(data)}).status_code == 422
    legacy = client.get("/api/example").json()
    assert client.post("/api/jobs", json={"kind": "fit", "project": legacy, "fit_2d": spec(data)}).status_code == 422
