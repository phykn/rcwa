from contextlib import contextmanager
from copy import deepcopy
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import pytest

from test_agent_example import agent


ROOT = Path(__file__).resolve().parents[2]


@contextmanager
def real_api(directory, label):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {**os.environ, "PYTHONPATH": str(ROOT / "backend"),
           "DATABASE_URL": f"sqlite:///{directory / 'circular-example.db'}",
           "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
    client = agent.LocalHTTP(f"http://127.0.0.1:{port}")
    with (directory / f"{label}.log").open("w+") as log:
        process = subprocess.Popen([sys.executable, "-m", "uvicorn", "api.main:app", "--host", "127.0.0.1",
                                    "--port", str(port), "--workers", "1"], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            for _ in range(200):
                if process.poll() is not None:
                    log.seek(0)
                    pytest.fail(log.read())
                try:
                    if client.request("GET", "/api/health", timeout=0.3)["status"] == "ok":
                        break
                except agent.ExampleError:
                    pass
                time.sleep(0.05)
            else:
                pytest.fail("Isolated circular example API failed to start")
            yield client
        finally:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def get(client, path):
    return client.request("GET", path, timeout=10)


def test_three_candidate_cli_export_and_get_only_recovery_after_api_restart(tmp_path):
    output, report_path = tmp_path / "circular-best.json", tmp_path / "circular-report.json"
    with real_api(tmp_path, "initial-api") as client:
        seed = get(client, "/api/example?example=circular_hole_2d")
        completed = subprocess.run(
            [sys.executable, str(ROOT / "scripts/agent_example.py"), "--base-url", client.base_url,
             "--example", "circular_hole_2d", "--diameters", "45", "65", "85", "--max-candidates", "3",
             "--output", str(output), "--report", str(report_path)],
            cwd=ROOT, env={**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"},
            capture_output=True, text=True, timeout=45,
        )
        (tmp_path / "cli-output.txt").write_text(completed.stdout + completed.stderr)
        assert completed.returncode == 0, completed.stdout + completed.stderr
        report, exported = json.loads(report_path.read_text()), json.loads(output.read_text())
        assert report["status"] == "completed" and report["attempted_count"] == report["evaluated_count"] == 3
        assert len({record["job_id"] for record in report["candidates"]}) == 3
        best = max(report["candidates"], key=lambda record: record["score"])
        assert report["best"]["job_id"] == best["job_id"]
        for record in report["candidates"]:
            job = get(client, f"/api/jobs/{record['job_id']}")
            result = job["result"]
            expected = deepcopy(seed)
            expected["layers"][0]["diameter_nm"] = record["diameter_nm"]
            expected["illumination"].update(wavelengths_nm=[650.0], polarization="s")
            expected["solver"] = {"harmonics_x": 1, "harmonics_y": 1}
            validation = client.request("POST", "/api/validate", expected, timeout=10)
            assert validation["valid"] and validation["project"] == expected
            assert validation["input_hash"] == record["input_hash"] == job["input_hash"] == result["metadata"]["input_hash"]
            assert result["wavelengths_nm"] == [650.0] and set(result["spectra"]) == {"s"}
            assert record["score"] == result["spectra"]["s"]["R"][0]
            assert result["warnings"] and all(warning in record["warnings"] for warning in result["warnings"])
            assert result["metadata"]["convergence_checked"] is False
            assert result["metadata"]["circular_geometry"]["strips"] == 64
        snapshot_id, job_id = report["snapshot"]["id"], report["best"]["job_id"]
        stored = get(client, f"/api/projects/{snapshot_id}")
        summary = get(client, f"/api/projects/{snapshot_id}?view=summary")
        assert exported == {"project": stored["project"], "result": stored["result"]}
        assert stored["provenance"] == report["snapshot"]["provenance"]
        assert stored["provenance"]["source"] == "server_computed"
        assert stored["provenance"]["job_id"] == job_id
        assert summary["result_summary"]["warnings_omitted_count"] == 0
        assert summary["result_summary"]["warnings"] == exported["result"]["warnings"]
    # Restart loses volatile jobs. Every recovery call below is GET; no save/solve retry.
    with real_api(tmp_path, "restarted-api") as client:
        with pytest.raises(agent.ApiError) as error:
            get(client, f"/api/jobs/{job_id}")
        assert error.value.status == 404 and error.value.code == "job_missing"
        index = get(client, "/api/projects?view=index")
        matches = [entry for entry in index["snapshots"] if entry["provenance"].get("job_id") == job_id]
        assert len(matches) == len(index["snapshots"]) == 1 and not index["may_have_more"]
        assert matches[0]["id"] == snapshot_id
        inputs = get(client, f"/api/projects/{snapshot_id}?view=inputs")
        assert inputs["project"] == exported["project"]
        assert inputs["input_hash"] == best["input_hash"] == inputs["provenance"]["input_hash"]
        assert "result" not in inputs and "result_summary" not in inputs
        assert get(client, f"/api/projects/{snapshot_id}?view=summary") == summary
        assert get(client, f"/api/projects/{snapshot_id}") == stored
        (tmp_path / "recovered-inputs.json").write_text(json.dumps(inputs, indent=2))
        (tmp_path / "recovered-summary.json").write_text(json.dumps(summary, indent=2))
    initial_log = (tmp_path / "initial-api.log").read_text()
    restarted_log = (tmp_path / "restarted-api.log").read_text()
    assert initial_log.count('"POST /api/jobs HTTP') == 3
    assert initial_log.count('"POST /api/snapshots HTTP') == 1
    assert '"POST ' not in restarted_log


def test_real_uncertain_save_and_known_job_cancellation(tmp_path):
    with real_api(tmp_path, "failure-api") as client:
        original = client.request
        calls = []

        def lose_receipt(method, path, body=None, *, timeout):
            calls.append((method, path))
            response = original(method, path, body, timeout=timeout)
            if path == "/api/snapshots":
                raise agent.UnknownPostOutcome("Simulated lost receipt after actual persistence")
            return response

        client.request = lose_receipt
        report, export = agent.Experiment(client, example="circular_hole_2d", candidates=[65.0], budget=1).run()
        assert report["status"] == "stopped" and report["unknown_post_outcome"] and export is None
        assert calls.count(("POST", "/api/jobs")) == calls.count(("POST", "/api/snapshots")) == 1
        before_recovery = len(calls)
        index = get(client, "/api/projects?view=index")
        matched = [entry for entry in index["snapshots"] if entry["provenance"]["job_id"] == report["best"]["job_id"]]
        assert len(matched) == 1
        stored = get(client, f"/api/projects/{matched[0]['id']}")
        assert stored["provenance"]["input_hash"] == report["candidates"][0]["input_hash"]
        assert all(method == "GET" for method, _ in calls[before_recovery:])
        # Inject an interruption after the client has learned a real new job ID.
        client.request = original
        run = agent.Experiment(client, example="circular_hole_2d", candidates=[45.0], budget=1,
                               sleep=lambda _: (_ for _ in ()).throw(KeyboardInterrupt()))
        cancelled, export = run.run()
        assert cancelled["status"] == "interrupted" and export is None
        assert cancelled["cancellation"]["status"] == "cancelled"
        job_id = cancelled["cancellation"]["job_id"]
        assert get(client, f"/api/jobs/{job_id}")["status"] == "cancelled"
        # Public validation rejects an impossible diameter without submitting it.
        invalid = get(client, "/api/example?example=circular_hole_2d")
        invalid["layers"][0]["diameter_nm"] = 141.0
        with pytest.raises(agent.ApiError) as error:
            client.request("POST", "/api/validate", invalid, timeout=10)
        assert error.value.status == 422 and error.value.code == "invalid_input"
    log = (tmp_path / "failure-api.log").read_text()
    assert log.count('"POST /api/jobs HTTP') == 2
    assert log.count('"POST /api/snapshots HTTP') == 1
    assert log.count('"DELETE /api/jobs/') == 1
