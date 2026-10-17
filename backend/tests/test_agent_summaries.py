"""Opt-in bounded agent views share full validation, storage and numerical values."""

from copy import deepcopy
import gzip
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from api.contracts import SnapshotSummary, StoredServerSnapshot
from api.main import create_app
from api.result_summary import (
    MAX_SUMMARY_BYTES, MAX_SUMMARY_WARNING_BYTES, SummaryUnavailable,
    forward_summary, summarize_job, summarize_snapshot,
)
from rcwa_core.schemas import Project
from rcwa_core.identity import canonical_hash

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'summaries.db'}"), base_url="http://localhost") as value:
        yield value


@pytest.fixture(scope="module")
def circular_snapshot():
    # Replay transport/storage only; never recompute the expensive H5 fixture.
    path = Path(__file__).parent / "fixtures/true-2d/circular-max-resource-snapshot.json.gz"
    payload = json.loads(gzip.decompress(path.read_bytes()))
    StoredServerSnapshot.model_validate(payload, strict=True)
    return payload


def preload(client, saved):
    provenance = saved["provenance"]
    job = {
        "id": provenance["job_id"], "kind": "forward", "status": "succeeded",
        "created_at": provenance["submitted_at"], "completed_at": provenance["completed_at"],
        "input_hash": provenance["input_hash"], "result": deepcopy(saved["result"]), "error": None, "error_code": None,
    }
    client.app.state.jobs.jobs[job["id"]] = job
    client.app.state.jobs.inputs[job["id"]] = {"project": deepcopy(saved["project"]), "fit": None}
    return job


def test_explicit_circular_example_matches_approved_input_and_legacy_default(client):
    original = Project().model_dump(mode="json")
    assert client.get("/api/example").json() == original
    assert client.get("/api/example?example=legacy_1d").json() == original
    example = client.get("/api/example?example=circular_hole_2d").json()
    assert example == json.loads((ROOT / "frontend/src/core/fixtures/default-project-circular.json").read_text())
    assert client.post("/api/validate", json=example).json()["valid"]
    assert "result" not in example and not client.app.state.jobs.jobs
    assert client.get("/api/example?example=unknown").status_code == 422


@pytest.mark.parametrize("path", [["ambient"], ["substrate"], ["layers", 0, "material"], ["layers", 0, "background"]])
def test_name_only_material_diagnostic_is_request_specific_and_hash_preserving(client, path):
    project = Project().model_dump(mode="json")
    target = project
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = {"name": "Silicon"}
    checked = client.post("/api/validate", json=project).json()
    warnings = [d for d in checked["diagnostics"] if d["code"] == "material_name_only"]
    assert len(warnings) == 1 and warnings[0]["location"] == path and warnings[0]["severity"] == "warning"
    assert "n=1 and k=0" in warnings[0]["message"]
    assert checked["valid"] and checked["input_hash"] == canonical_hash(checked["project"])
    again = client.post("/api/validate", json=checked["project"]).json()
    assert again["input_hash"] == checked["input_hash"]
    assert not any(d["code"] == "material_name_only" for d in again["diagnostics"])


def test_max_circle_summary_save_receipt_and_reload_keep_exact_full_record(client, circular_snapshot):
    job = preload(client, circular_snapshot)
    original = deepcopy(job)
    summary_response = client.get(f'/api/jobs/{job["id"]}?view=summary')
    assert summary_response.status_code == 200, summary_response.text
    compact = summary_response.json()
    assert compact["view"] == "summary" and compact["status"] == "succeeded"
    assert compact["input_hash"] == job["input_hash"]
    assert compact["result_summary"] == forward_summary(job["result"])
    assert client.get(f'/api/jobs/{job["id"]}').json() == original
    response = client.post("/api/snapshots?view=receipt", json={"job_id": job["id"]})
    assert response.status_code == 201, response.text
    receipt = response.json()
    assert receipt["status"] == "stored" and receipt["view"] == "receipt"
    assert receipt["provenance"]["source"] == "server_computed"
    assert receipt["input_hash"] == job["input_hash"]
    repeated = client.post("/api/snapshots?view=receipt", json={"job_id": job["id"]})
    assert repeated.json() == receipt
    loaded = client.get(f'/api/projects/{receipt["id"]}?view=summary').json()
    assert loaded == {**receipt, "view": "summary"}
    full = client.get(f'/api/projects/{receipt["id"]}').json()
    assert full["project"] == circular_snapshot["project"] and full["result"] == original["result"]
    assert client.post("/api/snapshots", json={"job_id": job["id"]}).json() == full
    assert len(client.get("/api/projects").json()) == 1
    for payload in (compact, receipt, loaded):
        serialized = json.dumps(payload, ensure_ascii=False).encode()
        assert len(serialized) <= MAX_SUMMARY_BYTES
        assert b'"orders"' not in serialized and b'"project"' not in serialized
        assert b'"n_values"' not in serialized and b'"metadata"' not in serialized
        totals = payload["result_summary"]
        assert totals["warnings"] == original["result"]["warnings"] and totals["warnings_omitted_count"] == 0
        for pol in ("s", "p"):
            assert totals["spectra"][pol] == {key: original["result"]["spectra"][pol][key]
                                             for key in ("R", "T", "R_specular", "T_specular", "A_balance")}


@pytest.mark.parametrize("warnings", [["a" * (MAX_SUMMARY_WARNING_BYTES + 1)], ["界🧪\n\"" * 30] * 500, ["short"] * 65])
def test_warnings_omit_only_complete_entries_with_explicit_count(circular_snapshot, warnings):
    data = deepcopy(circular_snapshot["result"])
    data["warnings"] = warnings
    summary = forward_summary(data)
    kept = summary["warnings"]
    assert kept == warnings[:len(kept)]
    assert summary["warnings_omitted_count"] == len(warnings) - len(kept) > 0
    assert len(json.dumps(kept, ensure_ascii=False).encode()) <= MAX_SUMMARY_WARNING_BYTES
    assert "inspect all warnings" in summary["meaning"]
    assert data["warnings"] == warnings


def test_huge_import_metadata_is_omitted_and_large_envelope_fails_without_truncation(circular_snapshot):
    imported = deepcopy(circular_snapshot)
    imported["result"]["metadata"]["ignored_unknown"] = "x" * 2_000_000
    summary = summarize_snapshot(imported)
    assert len(json.dumps(summary).encode()) < MAX_SUMMARY_BYTES
    imported["name"] = "x" * MAX_SUMMARY_BYTES
    with pytest.raises(SummaryUnavailable, match="128 KB"):
        summarize_snapshot(imported)


def test_unverified_and_project_only_snapshots_remain_unverified(client):
    saved = client.post("/api/projects", json={"project": {}, "result": None}).json()
    summary = client.get(f'/api/projects/{saved["id"]}?view=summary').json()
    SnapshotSummary.model_validate(summary, strict=True)
    assert summary["provenance"] == saved["provenance"]
    assert summary["provenance"]["source"] == "unverified_import"
    assert summary["input_hash"] == canonical_hash(saved["project"])
    assert summary["result_summary"] is None


@pytest.mark.parametrize("status", ["running", "failed", "cancelled"])
def test_summary_preserves_non_success_status_and_errors(status):
    job = {"id": "job", "kind": "forward", "status": status, "created_at": "now", "completed_at": None,
           "input_hash": "hash", "result": None, "error": "failed" if status == "failed" else None,
           "error_code": "failure" if status == "failed" else None}
    assert summarize_job(job) == {**{key: value for key, value in job.items() if key != "result"},
                                  "view": "summary", "result_summary": None}


@pytest.mark.parametrize("route,method,body", [
    ("/api/jobs/job?view=receipt", "get", None),
    ("/api/projects/id?view=receipt", "get", None),
    ("/api/snapshots?view=summary", "post", {"job_id": "job"}),
])
def test_invalid_views_rejected_before_store_or_jobs(client, route, method, body):
    response = getattr(client, method)(route, **({"json": body} if body else {}))
    assert response.status_code == 422
    assert not client.app.state.jobs.jobs and client.get("/api/projects").json() == []


def test_corrupted_2d_snapshot_cannot_bypass_integrity_via_summary(client, circular_snapshot, monkeypatch):
    saved = deepcopy(circular_snapshot)
    saved["project"]["layers"][0]["diameter_nm"] += 1
    monkeypatch.setattr(client.app.state.store, "get", lambda _: saved)
    for suffix in ("", "?view=summary"):
        response = client.get("/api/projects/saved" + suffix)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "invalid_stored_snapshot"


def test_known_historical_server_snapshot_summary_preserves_provenance(client, monkeypatch):
    saved = json.loads((Path(__file__).parent / "fixtures/legacy_server_snapshot.json").read_text())
    monkeypatch.setattr(client.app.state.store, "get", lambda _: saved)
    response = client.get(f'/api/projects/{saved["id"]}?view=summary')
    assert response.status_code == 200, response.text
    summary = response.json()
    assert summary["provenance"] == saved["provenance"]
    assert summary["result_summary"]["source_result_schema_version"] == "1.0"
    assert summary["result_summary"]["input_hash"] is None
    assert client.get(f'/api/projects/{saved["id"]}').json() == saved


def test_import_summary_uses_normalized_identity_without_altering_stored_fields(client, monkeypatch):
    raw = {"id": "legacy", "name": "Legacy import", "created_at": "then", "updated_at": "then",
           "provenance": {"source": "unverified_import"}, "project": {}, "result": None}
    monkeypatch.setattr(client.app.state.store, "get", lambda _: deepcopy(raw))
    summary = client.get("/api/projects/legacy?view=summary").json()
    full = client.get("/api/projects/legacy").json()
    assert summary["input_hash"] == canonical_hash(full["project"])
    assert raw["project"] == {}


@pytest.mark.parametrize("bad_field,bad_value", [("metadata", []), ("spectra", []), ("warnings", "not a list")])
def test_weak_historical_imports_have_explicit_summary_failure_and_full_access(client, monkeypatch, bad_field, bad_value):
    saved = json.loads((Path(__file__).parent / "fixtures/legacy_server_snapshot.json").read_text())
    saved["provenance"] = {"source": "unverified_import"}
    saved["result"][bad_field] = bad_value
    monkeypatch.setattr(client.app.state.store, "get", lambda _: deepcopy(saved))
    assert client.get(f'/api/projects/{saved["id"]}').status_code == 200
    response = client.get(f'/api/projects/{saved["id"]}?view=summary')
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "summary_unavailable"


def test_receipt_failure_after_save_keeps_mutation_uncertain(client, circular_snapshot, monkeypatch):
    job = preload(client, circular_snapshot)
    def unavailable(*args, **kwargs):
        raise SummaryUnavailable("injected projection failure")
    monkeypatch.setattr("api.main.summarize_snapshot", unavailable)
    response = client.post("/api/snapshots?view=receipt", json={"job_id": job["id"]})
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "snapshot_receipt_unavailable"
    assert len(client.get("/api/projects").json()) == 1
    full = client.post("/api/snapshots", json={"job_id": job["id"]})
    assert full.status_code == 201 and full.json()["result"] == job["result"]


def test_summary_survives_job_eviction_and_database_restart(tmp_path):
    saved = json.loads((Path(__file__).parent / "fixtures/legacy_server_snapshot.json").read_text())
    url = f"sqlite:///{tmp_path / 'restart.db'}"
    with TestClient(create_app(url), base_url="http://localhost") as first:
        stored = first.app.state.store.save(saved["project"], saved["result"], provenance=saved["provenance"])
        before = first.get(f'/api/projects/{stored["id"]}?view=summary').json()
    with TestClient(create_app(url), base_url="http://localhost") as second:
        assert not second.app.state.jobs.jobs
        after = second.get(f'/api/projects/{stored["id"]}?view=summary').json()
        assert after == before


def test_fit_summary_preserves_separate_type_scalar_status_and_prediction_target(circular_snapshot):
    # Projection contract only; deliberately not evidence of a fitting run.
    source = circular_snapshot["result"]
    result = {"result_type": "synthetic_fit", "status": "not_converged", "fit_cd_nm": 100.0,
              "target_cd_nm": 110.0, "rmse": 0.001, "nfev": 3, "prediction": source, "target": source,
              "warnings": ["Synthetic contract fixture; no numerical fit was performed."]}
    job = {"id": "fit", "kind": "fit", "status": "succeeded", "created_at": "now", "completed_at": "now",
           "input_hash": "hash", "result": result, "error": None, "error_code": None}
    compact = summarize_job(job)["result_summary"]
    assert compact["summary_schema_version"] == "rcwa-fit-summary/1.0"
    assert compact["status"] == "not_converged" and compact["rmse"] == result["rmse"]
    assert compact["prediction"] == compact["target"] == forward_summary(source)
    assert compact["warnings"] == result["warnings"] and compact["warnings_omitted_count"] == 0
