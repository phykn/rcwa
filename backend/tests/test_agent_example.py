from copy import deepcopy
import importlib.util
from pathlib import Path
from urllib.error import URLError

import pytest

PATH = Path(__file__).resolve().parents[2] / "scripts" / "agent_example.py"
spec = importlib.util.spec_from_file_location("agent_example", PATH)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def result(score):
    return {
        "result_type": "forward",
        "wavelengths_nm": [650.0],
        "spectra": {"s": {"R": [score], "R_specular": [0.001]}},
        "warnings": ["Fourier convergence is not certified by a single run."],
    }


class FakeHTTP:
    def __init__(self):
        self.calls = []
        self.jobs = {}
        self.polls = 0
        self.available = True
        self.validation_valid = True
        self.validation_error = None
        self.submit_error = None
        self.failed_cd = None
        self.always_running = False
        self.interrupt_poll = False
        self.poll_error = None
        self.project = {
            "layers": [{"cd_nm": 180.0}],
            "illumination": {"wavelengths_nm": [450.0, 650.0], "polarization": "both"},
        }

    def request(self, method, path, body=None, *, timeout):
        self.calls.append((method, path, deepcopy(body), timeout))
        if path == "/api/capabilities":
            return {"engine": {"available": self.available, "message": "test engine status"}}
        if path == "/api/example":
            return deepcopy(self.project)
        if path == "/api/validate":
            if self.validation_error:
                raise self.validation_error
            return {
                "valid": self.validation_valid,
                "project": body,
                "input_hash": "test-hash",
                "diagnostics": [
                    {"code": "test_warning", "severity": "warning", "location": [], "message": "Preflight warning"}
                ],
            }
        if method == "POST" and path == "/api/jobs":
            if self.submit_error:
                raise self.submit_error
            job_id = f"job-{len(self.jobs)}"
            self.jobs[job_id] = deepcopy(body["project"])
            return {"id": job_id, "status": "running"}
        if method == "DELETE":
            return {"status": "cancelled"}
        if path.startswith("/api/jobs/"):
            self.polls += 1
            if self.interrupt_poll:
                raise KeyboardInterrupt
            if self.poll_error:
                raise self.poll_error
            if self.always_running:
                return {"status": "running"}
            cd = self.jobs[path.rsplit("/", 1)[1]]["layers"][0]["cd_nm"]
            if cd == self.failed_cd:
                return {"status": "failed", "error": "Numerical failure", "error_code": "numerical_failure"}
            return {"status": "succeeded", "result": result(cd / 1000)}
        if path == "/api/snapshots":
            self.saved_job_id = body["job_id"]
            self.saved_project = self.jobs[body["job_id"]]
            return {"id": "saved-1"}
        if path == "/api/projects/saved-1":
            return {
                "project": self.saved_project,
                "result": result(self.saved_project["layers"][0]["cd_nm"] / 1000),
                "provenance": {"source": "server_computed", "job_id": self.saved_job_id, "input_hash": "test-hash"},
            }
        raise AssertionError((method, path, body))


def experiment(http=None, **kwargs):
    clock = Clock()
    run = agent.Experiment(
        http or FakeHTTP(),
        candidates=kwargs.pop("candidates", [140.0, 180.0, 220.0]),
        clock=clock,
        sleep=clock.sleep,
        **kwargs,
    )
    return run, clock


def test_scoring_uses_explicit_total_power_wavelength_and_polarization():
    data = {
        "result_type": "forward",
        "wavelengths_nm": [550.0, 650.0],
        "spectra": {"s": {"R": [0.9, 0.4], "R_specular": [0.8, 0.1]}, "p": {"R": [0.7, 0.6]}},
    }
    assert agent.score_result(data) == 0.4


@pytest.mark.parametrize("value", [float("nan"), float("inf"), True, "0.5"])
def test_score_rejects_invalid_power(value):
    with pytest.raises(agent.ExampleError):
        agent.score_result(result(value))


@pytest.mark.parametrize("wavelengths", [[550.0], [650.0, 650.0]])
def test_score_never_substitutes_a_different_wavelength(wavelengths):
    data = result(0.2)
    data["wavelengths_nm"] = wavelengths
    with pytest.raises(agent.ExampleError):
        agent.score_result(data)


def test_full_workflow_uses_only_http_and_exports_the_server_pair():
    http = FakeHTTP()
    run, _ = experiment(http)
    report, exported = run.run()
    assert report["status"] == "completed"
    assert report["attempted_count"] == report["evaluated_count"] == 3
    assert report["best"] == {
        "cd_nm": 220.0,
        "score": 0.22,
        "job_id": "job-2",
        "description": "Best among evaluated candidates",
    }
    assert set(exported) == {"project", "result"}
    assert exported["project"] == http.saved_project
    assert exported["project"]["illumination"] == {"wavelengths_nm": [650.0], "polarization": "s"}
    assert http.project["layers"][0]["cd_nm"] == 180.0
    assert all(len(candidate["warnings"]) == 2 for candidate in report["candidates"])
    save_calls = [call for call in http.calls if call[1] == "/api/snapshots"]
    assert save_calls[0][2] == {"job_id": "job-2"}
    assert all(call[3] <= 10 for call in http.calls)


def test_failed_candidate_counts_toward_budget_and_never_becomes_best():
    http = FakeHTTP()
    http.failed_cd = 220.0
    report, exported = experiment(http)[0].run()
    assert report["status"] == "completed"
    assert report["attempted_count"] == 3 and report["evaluated_count"] == 2
    assert report["best"]["cd_nm"] == 180.0
    assert report["candidates"][2]["error_code"] == "numerical_failure"
    assert exported["project"]["layers"][0]["cd_nm"] == 180.0


@pytest.mark.parametrize(
    "kwargs",
    [
        {"candidates": []},
        {"candidates": [1, 2, 3, 4]},
        {"budget": 9},
        {"budget": True},
        {"candidates": [float("nan")]},
        {"candidates": [1, 1]},
        {"deadline_seconds": 0},
        {"deadline_seconds": float("inf")},
        {"request_timeout": 31},
    ],
)
def test_invalid_limits_fail_before_http(kwargs):
    http = FakeHTTP()
    with pytest.raises(ValueError):
        experiment(http, **kwargs)
    assert not http.calls


def test_deadline_stops_polling_and_attempts_bounded_cancellation_once():
    http = FakeHTTP()
    http.always_running = True
    run, clock = experiment(http, deadline_seconds=5)
    report, exported = run.run()
    assert report["status"] == "stopped" and "deadline" in report["stop_reason"]
    assert clock.now == 5.0 and max(clock.sleeps) <= 2.0
    assert 1 < http.polls < 20
    assert report["cancellation"]["status"] == "cancelled"
    assert len([c for c in http.calls if c[0] == "DELETE"]) == 1
    assert len([c for c in http.calls if c[1] == "/api/jobs"]) == 1
    assert report["candidates"][1]["status"] == "not_evaluated"
    assert exported is None


def test_interruption_cancels_known_job_and_reports_remaining_candidates():
    http = FakeHTTP()
    http.interrupt_poll = True
    report, exported = experiment(http)[0].run()
    assert report["status"] == "interrupted"
    assert report["cancellation"] == {"job_id": "job-0", "status": "cancelled"}
    assert report["candidates"][1]["status"] == "not_evaluated"
    assert exported is None


def test_interrupt_during_submission_does_not_resubmit_an_unknown_job():
    http = FakeHTTP()
    http.submit_error = KeyboardInterrupt()
    report, _ = experiment(http)[0].run()
    assert report["status"] == "interrupted" and report["unknown_post_outcome"]
    assert len([c for c in http.calls if c[1] == "/api/jobs"]) == 1
    assert "cancellation" not in report


@pytest.mark.parametrize(
    "submit_error",
    [
        agent.UnknownPostOutcome("Submission timed out; outcome unknown"),
        agent.ApiError(429, {"detail": "Both slots busy", "error": {"code": "capacity_exceeded"}}),
        agent.ApiError(503, {"detail": "Engine unavailable", "error": {"code": "engine_unavailable"}}),
    ],
)
def test_uncertain_or_rejected_submission_stops_without_retries(submit_error):
    http = FakeHTTP()
    http.submit_error = submit_error
    report, exported = experiment(http)[0].run()
    assert report["status"] == "stopped"
    assert len([c for c in http.calls if c[1] == "/api/jobs"]) == 1
    assert report["candidates"][1]["status"] == "not_evaluated"
    assert exported is None


def test_unavailable_engine_stops_before_validation_or_submission():
    http = FakeHTTP()
    http.available = False
    report, _ = experiment(http)[0].run()
    assert report["attempted_count"] == 0
    assert len(http.calls) == 1


def test_invalid_configuration_stops_before_any_job():
    http = FakeHTTP()
    http.validation_valid = False
    report, _ = experiment(http)[0].run()
    assert report["candidates"][0]["status"] == "invalid"
    assert not any(c[1] == "/api/jobs" for c in http.calls)


def test_422_diagnostics_are_retained_for_the_failed_candidate():
    http = FakeHTTP()
    diagnostic = {"code": "unsupported_scope", "severity": "error", "location": ["layers"], "message": "Bad layer"}
    http.validation_error = agent.ApiError(422, {"error": {"code": "invalid_input", "diagnostics": [diagnostic]}})
    report, _ = experiment(http)[0].run()
    assert report["candidates"][0]["validation_diagnostics"] == [diagnostic]
    assert report["attempted_count"] == 1


def test_poll_transport_failure_cancels_known_job():
    http = FakeHTTP()
    http.poll_error = agent.ExampleError("Connection lost")
    report, _ = experiment(http)[0].run()
    assert report["cancellation"]["status"] == "cancelled"


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com",
        "http://example.com",
        "http://localhost:8000/path",
        "http://name:secret@localhost:8000",
        "http://127.0.0.1:8000?next=x",
    ],
)
def test_remote_redirect_or_credential_destinations_are_not_accepted(url):
    with pytest.raises(ValueError):
        agent.LocalHTTP(url)


def test_transport_reports_ambiguous_post_without_retry(monkeypatch):
    client = agent.LocalHTTP("http://127.0.0.1:8000")
    attempts = []

    def fail(req, timeout):
        attempts.append(req)
        raise URLError("timed out")

    monkeypatch.setattr(client.opener, "open", fail)
    with pytest.raises(agent.UnknownPostOutcome, match="outcome unknown"):
        client.request("POST", "/api/jobs", {}, timeout=1)
    assert len(attempts) == 1


def test_cli_writes_failure_report_without_creating_export(tmp_path, monkeypatch):
    http = FakeHTTP()
    http.available = False
    monkeypatch.setattr(agent, "LocalHTTP", lambda url: http)
    report, output = tmp_path / "report.json", tmp_path / "best.json"
    assert agent.main(["--report", str(report), "--output", str(output)]) == 1
    assert report.is_file() and not output.exists()


def test_late_accepted_submission_retains_id_for_deadline_cancellation():
    http = FakeHTTP()
    run, clock = experiment(http, deadline_seconds=1)
    original = http.request

    def slow_submit(method, path, body=None, *, timeout):
        response = original(method, path, body, timeout=timeout)
        if method == "POST" and path == "/api/jobs":
            clock.now = 1.1
        return response

    http.request = slow_submit
    report, _ = run.run()
    assert report["candidates"][0]["job_id"] == "job-0"
    assert report["cancellation"] == {"job_id": "job-0", "status": "cancelled"}


def test_uncertain_snapshot_save_stops_without_retry_or_export():
    http = FakeHTTP()
    original = http.request

    def lost_save(method, path, body=None, *, timeout):
        response = original(method, path, body, timeout=timeout)
        if path == "/api/snapshots":
            raise agent.UnknownPostOutcome("Snapshot outcome unknown")
        return response

    http.request = lost_save
    report, exported = experiment(http)[0].run()
    assert report["unknown_post_outcome"]
    assert report["best"]["cd_nm"] == 220.0
    assert len([call for call in http.calls if call[1] == "/api/snapshots"]) == 1
    assert exported is None


@pytest.mark.parametrize("tamper", ["project", "result", "provenance"])
def test_mismatched_snapshot_is_never_exported(tamper):
    http = FakeHTTP()
    original = http.request

    def wrong_snapshot(method, path, body=None, *, timeout):
        response = original(method, path, body, timeout=timeout)
        if path == "/api/projects/saved-1":
            response = deepcopy(response)
            if tamper == "project":
                response["project"]["illumination"]["polarization"] = "p"
            elif tamper == "result":
                response["result"]["warnings"] = []
            else:
                response["provenance"]["source"] = "unverified_import"
        return response

    http.request = wrong_snapshot
    report, exported = experiment(http)[0].run()
    assert report["status"] == "stopped"
    assert exported is None


def test_failed_cancellation_is_reported_without_retry():
    http = FakeHTTP()
    http.interrupt_poll = True
    original = http.request

    def unavailable_cancel(method, path, body=None, *, timeout):
        response = original(method, path, body, timeout=timeout)
        if method == "DELETE":
            raise agent.ExampleError("Connection lost during cancellation")
        return response

    http.request = unavailable_cancel
    report, _ = experiment(http)[0].run()
    assert report["cancellation"]["status"] == "unconfirmed"
    assert len([call for call in http.calls if call[0] == "DELETE"]) == 1


def test_synthetic_fit_or_untagged_result_is_not_scored_as_forward():
    data = result(0.5)
    data["result_type"] = "synthetic_fit"
    with pytest.raises(agent.ExampleError):
        agent.score_result(data)
    del data["result_type"]
    with pytest.raises(agent.ExampleError):
        agent.score_result(data)
