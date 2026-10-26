from copy import deepcopy
import json
from pathlib import Path

import pytest

from test_agent_example import Clock, FakeHTTP, agent


ROOT = Path(__file__).resolve().parents[2]
SEED = json.loads((ROOT / "backend/api/examples/circular-hole-2d.json").read_text())
WARNINGS = ["Convergence not assessed.", "Circles use 64 midpoint strips; area bounds are not optical-error bounds."]


class CircularHTTP(FakeHTTP):
    def __init__(self):
        super().__init__()
        self.project = deepcopy(SEED)
        self.snapshots = {}

    def envelope(self, job_id, status="running"):
        project = self.jobs[job_id]
        diameter = project["layers"][0]["diameter_nm"]
        return {
            "id": job_id, "kind": "forward", "status": status, "input_hash": agent.input_hash(project),
            "result": {
                "schema_version": "1.2", "result_type": "forward", "wavelengths_nm": [650.0],
                # p and specular are deliberately higher in scoring's legacy unit test.
                "spectra": {"s": {"R": [1 / (diameter + 1)], "R_specular": [0.001]}},
                "metadata": {"input_hash": agent.input_hash(project)}, "warnings": list(WARNINGS),
            } if status == "succeeded" else None,
        }

    def request(self, method, path, body=None, *, timeout):
        self.calls.append((method, path, deepcopy(body), timeout))
        if path == "/api/capabilities":
            return {"engine": {"available": True}}
        if path == "/api/example?example=circular_hole_2d":
            return deepcopy(self.project)
        if path == "/api/validate":
            if self.validation_error:
                raise self.validation_error
            return {"valid": self.validation_valid, "project": deepcopy(body), "input_hash": agent.input_hash(body),
                    "diagnostics": [{"severity": "warning", "code": "preflight", "message": "Preflight warning"}]}
        if method == "POST" and path == "/api/jobs":
            if self.submit_error:
                raise self.submit_error
            job_id = f"job-{len(self.jobs)}"
            self.jobs[job_id] = deepcopy(body["project"])
            return self.envelope(job_id)
        if method == "DELETE":
            return {"status": "cancelled"}
        if path.startswith("/api/jobs/"):
            if self.interrupt_poll:
                raise KeyboardInterrupt
            if self.poll_error:
                raise self.poll_error
            job_id = path.rsplit("/", 1)[1]
            if self.always_running:
                return self.envelope(job_id)
            if self.jobs[job_id]["layers"][0]["diameter_nm"] == self.failed_cd:
                return {**self.envelope(job_id, "failed"), "error_code": "numerical_failure", "error": "No result"}
            return self.envelope(job_id, "succeeded")
        if path == "/api/snapshots":
            job_id = body["job_id"]
            self.snapshots["saved-1"] = {
                "id": "saved-1", "project": self.jobs[job_id], "result": self.envelope(job_id, "succeeded")["result"],
                "provenance": {"source": "server_computed", "job_id": job_id,
                               "input_hash": agent.input_hash(self.jobs[job_id])},
            }
            return deepcopy(self.snapshots["saved-1"])
        if path == "/api/projects/saved-1":
            return deepcopy(self.snapshots["saved-1"])
        raise AssertionError((method, path, body))


def experiment(http=None, **kwargs):
    clock = Clock()
    return agent.Experiment(http or CircularHTTP(), candidates=kwargs.pop("candidates", [45.0, 65.0, 85.0]),
                            example=agent.CIRCULAR_EXAMPLE, clock=clock, sleep=clock.sleep, **kwargs)


def test_circular_named_seed_exact_inputs_warnings_and_persistence():
    http = CircularHTTP()
    report, export = experiment(http).run()
    assert report["status"] == "completed"
    assert report["attempted_count"] == report["evaluated_count"] == 3
    assert report["best"]["diameter_nm"] == 45
    assert report["best"]["description"] == "Best among evaluated candidates"
    assert report["varied_input"] == "layers[0].diameter_nm"
    assert report["objective"] == {"direction": "maximize", "observable": "R", "polarization": "s", "wavelength_nm": 650.0}
    assert report["solver"] == {"harmonics_x": 1, "harmonics_y": 1}
    assert "not real HBM" in report["limitations"] and "64 midpoint" in report["limitations"]
    assert http.project == SEED
    for diameter, project in zip([45.0, 65.0, 85.0], http.jobs.values(), strict=True):
        expected = deepcopy(SEED)
        expected["layers"][0]["diameter_nm"] = diameter
        expected["illumination"].update(wavelengths_nm=[650.0], polarization="s")
        expected["solver"] = {"harmonics_x": 1, "harmonics_y": 1}
        assert project == expected
    assert all(record["warnings"] == ["Preflight warning", *WARNINGS] for record in report["candidates"])
    stored = http.snapshots[report["snapshot"]["id"]]
    assert export == {"project": stored["project"], "result": stored["result"]}
    assert export["result"]["warnings"] == WARNINGS
    assert report["snapshot"]["provenance"]["input_hash"] == agent.input_hash(export["project"])
    assert len([call for call in http.calls if call[1] == "/api/snapshots"]) == 1


@pytest.mark.parametrize("argv", [
    ["--example", "circular_hole_2d", "--cd", "45"],
    ["--diameters", "45"],
    ["--example", "circular_hole_2d", "--diameters", "-1"],
    ["--example", "circular_hole_2d", "--diameters", "140.1"],
    ["--example", "circular_hole_2d", "--diameters", "nan"],
    ["--example", "circular_hole_2d", "--diameters", "inf"],
    ["--example", "circular_hole_2d", "--diameters", "45", "45"],
    ["--example", "circular_hole_2d", "--max-candidates", "2"],
    ["--example", "circular_hole_2d", "--max-candidates", "9"],
    ["--example", "circular_hole_2d", "--max-candidates", "0"],
    ["--example", "circular_hole_2d", "--deadline-seconds", "0"],
    ["--example", "circular_hole_2d", "--request-timeout", "31"],
    ["--example", "other"],
])
def test_bad_cli_modes_values_and_budget_stop_before_http(argv, monkeypatch):
    http = CircularHTTP()
    monkeypatch.setattr(agent, "LocalHTTP", lambda url: http)
    with pytest.raises(SystemExit) as error:
        agent.main(argv)
    assert error.value.code == 2 and not http.calls


@pytest.mark.parametrize("candidates", [[True], ["45"], [], [float("nan")], [-0.1], [141], [1, 1], [1, 2, 3, 4]])
def test_circular_programmatic_options_fail_before_http(candidates):
    http = CircularHTTP()
    with pytest.raises(ValueError):
        experiment(http, candidates=candidates)
    assert not http.calls


def test_cli_default_circular_files_have_exact_identity_and_warnings(tmp_path, monkeypatch, capsys):
    http = CircularHTTP()
    monkeypatch.setattr(agent, "LocalHTTP", lambda url: http)
    output, report = tmp_path / "result.json", tmp_path / "report.json"
    assert agent.main(["--example", "circular_hole_2d", "--output", str(output), "--report", str(report)]) == 0
    saved = http.snapshots["saved-1"]
    assert json.loads(output.read_text()) == {"project": saved["project"], "result": saved["result"]}
    data = json.loads(report.read_text())
    assert [record["diameter_nm"] for record in data["candidates"]] == [45, 65, 85]
    assert all(record["warnings"] == ["Preflight warning", *WARNINGS] for record in data["candidates"])
    text = capsys.readouterr().out
    assert "64 midpoint" in text and "not real HBM" in text and "Best among evaluated candidates" in text


@pytest.mark.parametrize("values", [[0], [140]])
def test_endpoint_diameters_are_valid_local_options(values):
    experiment(candidates=values, budget=1)


def test_failed_circular_candidate_consumes_budget():
    http = CircularHTTP()
    http.failed_cd = 45
    report, export = experiment(http).run()
    assert report["status"] == "completed" and report["attempted_count"] == 3 and report["evaluated_count"] == 2
    assert report["best"]["diameter_nm"] == 65
    assert export["project"]["layers"][0]["diameter_nm"] == 65
    assert len(http.jobs) == 3


@pytest.mark.parametrize("rejection", ["invalid", "422"])
def test_circular_invalid_input_stops_without_job(rejection):
    http = CircularHTTP()
    if rejection == "invalid":
        http.validation_valid = False
    else:
        http.validation_error = agent.ApiError(422, {"error": {"code": "invalid_input", "diagnostics": [
            {"code": "bad_diameter", "severity": "error", "message": "Invalid diameter"}]}})
    report, export = experiment(http).run()
    assert report["status"] == "stopped" and report["attempted_count"] == 1 and export is None
    assert report["candidates"][1]["status"] == "not_evaluated"
    assert not http.jobs


@pytest.mark.parametrize("failure", ["timeout", "interrupt", "poll_error"])
def test_circular_cleanup_once_for_known_active_job(failure):
    http = CircularHTTP()
    http.always_running = failure == "timeout"
    http.interrupt_poll = failure == "interrupt"
    http.poll_error = agent.ExampleError("Connection lost") if failure == "poll_error" else None
    report, export = experiment(http, deadline_seconds=1).run()
    assert report["cancellation"] == {"job_id": "job-0", "status": "cancelled"}
    assert len([call for call in http.calls if call[0] == "DELETE"]) == 1
    assert len(http.jobs) == 1 and export is None


@pytest.mark.parametrize("failure", [agent.UnknownPostOutcome("Lost submission"), KeyboardInterrupt(),
                                     agent.ApiError(429, {"error": {"code": "capacity_exceeded"}})])
def test_circular_uncertain_or_rejected_submit_has_no_retry(failure):
    http = CircularHTTP()
    http.submit_error = failure
    report, export = experiment(http).run()
    assert report["status"] in {"stopped", "interrupted"} and export is None
    assert len([call for call in http.calls if call[1] == "/api/jobs"]) == 1
    assert "cancellation" not in report


@pytest.mark.parametrize("target", ["seed", "validation_project", "validation_hash", "submit_id", "poll_hash", "poll_id",
                                    "poll_kind", "result_hash", "wavelength", "polarization", "saved_id",
                                    "saved_hash", "saved_project", "saved_result", "saved_source"])
def test_circular_identity_mismatch_never_exports(target):
    http = CircularHTTP()
    original = http.request

    def tamper(method, path, body=None, *, timeout):
        response = original(method, path, body, timeout=timeout)
        if target == "seed" and path.startswith("/api/example"):
            response["layers"] = []
        if path == "/api/validate":
            if target == "validation_project":
                response["project"]["layers"][1]["diameter_nm"] += 1
            if target == "validation_hash":
                response["input_hash"] = "f" * 64
        if target == "submit_id" and path == "/api/jobs":
            response.pop("id")
        if path.startswith("/api/jobs/"):
            if target.startswith("poll_"):
                response[{"poll_id": "id", "poll_kind": "kind", "poll_hash": "input_hash"}[target]] = "wrong"
            if target == "result_hash":
                response["result"]["metadata"]["input_hash"] = "f" * 64
            if target == "wavelength":
                response["result"]["wavelengths_nm"] = [649.0]
            if target == "polarization":
                response["result"]["spectra"]["p"] = response["result"]["spectra"].pop("s")
        if path == "/api/projects/saved-1":
            if target == "saved_id":
                response["id"] = "wrong"
            if target == "saved_hash":
                response["provenance"]["input_hash"] = "f" * 64
            if target == "saved_project":
                response["project"]["layers"][1]["diameter_nm"] += 1
            if target == "saved_result":
                response["result"]["warnings"] = []
            if target == "saved_source":
                response["provenance"]["source"] = "unverified_import"
        return response

    http.request = tamper
    report, export = experiment(http).run()
    assert report["status"] == "stopped" and export is None
    if target.startswith("poll_"):
        assert len([call for call in http.calls if call[0] == "DELETE"]) == 1


def test_uncertain_save_keeps_original_job_for_get_only_recovery(tmp_path, monkeypatch, capsys):
    http = CircularHTTP()
    original = http.request

    def lose_receipt(method, path, body=None, *, timeout):
        response = original(method, path, body, timeout=timeout)
        if path == "/api/snapshots":
            raise agent.UnknownPostOutcome("Snapshot outcome unknown")
        return response

    http.request = lose_receipt
    monkeypatch.setattr(agent, "LocalHTTP", lambda url: http)
    report_path, output = tmp_path / "report.json", tmp_path / "old-result.json"
    output.write_text("Previous result")
    assert agent.main(["--example", "circular_hole_2d", "--report", str(report_path), "--output", str(output)]) == 1
    report = json.loads(report_path.read_text())
    assert report["unknown_post_outcome"] and report["best"]["job_id"] == "job-0"
    assert output.read_text() == "Previous result"
    assert len([call for call in http.calls if call[1] == "/api/snapshots"]) == 1
    assert len(http.jobs) == 3 and len(http.snapshots) == 1
    assert "provenance.job_id" in capsys.readouterr().err


def test_json_write_is_atomic_per_file_and_keeps_unicode(tmp_path, monkeypatch):
    destination = tmp_path / "report.json"
    destination.write_text("Existing output")
    original_replace = agent.os.replace
    observed = []

    def replace(source, target):
        assert source.parent == target.parent == tmp_path
        assert destination.read_text() == "Existing output"
        assert json.loads(source.read_text()) == {"label": "원형", "value": 45.0}
        observed.append((source, target))
        original_replace(source, target)

    monkeypatch.setattr(agent.os, "replace", replace)
    agent.write_json(destination, {"label": "원형", "value": 45.0})
    assert len(observed) == 1 and json.loads(destination.read_text()) == {"label": "원형", "value": 45.0}
    assert list(tmp_path.iterdir()) == [destination]


@pytest.mark.parametrize("failure", ["serialization", "write", "replace", "interrupt"])
def test_atomic_json_failure_preserves_previous_file_and_cleans_temp(tmp_path, monkeypatch, failure):
    destination = tmp_path / "best.json"
    destination.write_text("Previous export")
    value = {"value": float("nan")} if failure == "serialization" else {"value": 45.0}
    expected = ValueError if failure == "serialization" else (KeyboardInterrupt if failure == "interrupt" else OSError)

    def fail(*_args, **_kwargs):
        raise expected("Injected file failure")

    if failure == "write":
        monkeypatch.setattr(agent.os, "fsync", fail)
    elif failure in {"replace", "interrupt"}:
        monkeypatch.setattr(agent.os, "replace", fail)
    with pytest.raises(expected):
        agent.write_json(destination, value)
    assert destination.read_text() == "Previous export"
    assert list(tmp_path.iterdir()) == [destination]


@pytest.mark.parametrize("conflict", ["same", "directory", "nested", "non_directory_parent", "hardlink"])
def test_output_path_conflict_fails_before_http(tmp_path, monkeypatch, conflict):
    http = CircularHTTP()
    monkeypatch.setattr(agent, "LocalHTTP", lambda url: http)
    output, report = tmp_path / "output.json", tmp_path / "report.json"
    if conflict == "same":
        report = output
    elif conflict == "directory":
        output.mkdir()
    elif conflict == "nested":
        report = output / "report.json"
    elif conflict == "non_directory_parent":
        output.write_text("Not a directory")
        output = output / "child.json"
    elif conflict == "hardlink":
        output.write_text("Existing export")
        report.hardlink_to(output)
    with pytest.raises(SystemExit) as error:
        agent.main(["--example", "circular_hole_2d", "--output", str(output), "--report", str(report)])
    assert error.value.code == 2 and not http.calls


def test_export_write_failure_records_stop_retains_snapshot_and_previous_output(tmp_path, monkeypatch, capsys):
    http = CircularHTTP()
    monkeypatch.setattr(agent, "LocalHTTP", lambda url: http)
    output, report = tmp_path / "output.json", tmp_path / "report.json"
    output.write_text("Previous output")
    replace = agent.os.replace

    def fail_export(source, target):
        if target == output:
            raise OSError("Injected export failure")
        replace(source, target)

    monkeypatch.setattr(agent.os, "replace", fail_export)
    assert agent.main(["--example", "circular_hole_2d", "--output", str(output), "--report", str(report)]) == 1
    data = json.loads(report.read_text())
    assert data["status"] == "stopped" and "Could not write export" in data["stop_reason"]
    assert data["snapshot"]["id"] == "saved-1" and data["best"]["job_id"] == "job-0"
    assert output.read_text() == "Previous output" and len(list(tmp_path.iterdir())) == 2
    text = capsys.readouterr()
    assert "import " not in text.out and "GET /api/projects/saved-1" in text.err
    assert len(http.jobs) == 3 and len(http.snapshots) == 1


def test_report_write_failure_is_nonzero_without_claiming_new_report(tmp_path, monkeypatch, capsys):
    http = CircularHTTP()
    monkeypatch.setattr(agent, "LocalHTTP", lambda url: http)
    output, report = tmp_path / "output.json", tmp_path / "report.json"
    report.write_text("Previous report")
    replace = agent.os.replace

    def fail_report(source, target):
        if target == report:
            raise OSError("Injected report failure")
        replace(source, target)

    monkeypatch.setattr(agent.os, "replace", fail_report)
    assert agent.main(["--example", "circular_hole_2d", "--output", str(output), "--report", str(report)]) == 1
    assert report.read_text() == "Previous report" and json.loads(output.read_text())["result"]["warnings"] == WARNINGS
    assert len(list(tmp_path.iterdir())) == 2
    text = capsys.readouterr()
    assert "Full report:" not in text.out and "Could not write report" in text.err
    assert "GET /api/projects/saved-1" in text.err


@pytest.mark.parametrize("job_id", [123, True, ["bad"], {"bad": "id"}, None, ""])
def test_malformed_submission_id_has_bounded_unknown_outcome_without_cancel_or_retry(job_id):
    http = CircularHTTP()
    original = http.request

    def bad_id(method, path, body=None, *, timeout):
        response = original(method, path, body, timeout=timeout)
        if method == "POST" and path == "/api/jobs":
            response["id"] = job_id
        return response

    http.request = bad_id
    report, export = experiment(http).run()
    assert report["status"] == "stopped" and report["unknown_post_outcome"] and export is None
    assert report["attempted_count"] == 1 and report["candidates"][1]["status"] == "not_evaluated"
    assert len([call for call in http.calls if call[1] == "/api/jobs"]) == 1
    assert not any(call[0] == "DELETE" for call in http.calls)


def test_malformed_error_detail_remains_a_bounded_report():
    http = CircularHTTP()
    http.submit_error = agent.ApiError(503, {"error": "Unexpected proxy text"})
    report, export = experiment(http).run()
    assert report["status"] == "stopped" and report["api_error"]["status"] == 503 and export is None
    assert len([call for call in http.calls if call[1] == "/api/jobs"]) == 1
