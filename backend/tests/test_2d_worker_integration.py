from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import gzip
import json
import multiprocessing as mp
import os
from pathlib import Path
import signal
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest

from api.jobs import JobManager
from rcwa_core.project_io import forward_project, normalized_project_and_hash
from rcwa_core.schemas import Project

FIXTURES = Path(__file__).parent / "fixtures/true-2d"


def default_project():
    return json.loads((FIXTURES / "default-project.json").read_text())


def small_project():
    project = default_project()
    project["illumination"]["wavelengths_nm"] = [650.0]
    project["solver"] = {"harmonics_x": 1, "harmonics_y": 2}
    return project


def legacy_project():
    project = Project().model_dump(mode="json")
    project["illumination"]["wavelengths_nm"] = [650.0]
    project["solver"]["harmonics"] = 3
    return project


@pytest.fixture(scope="module")
def result_2d():
    return forward_project(small_project())


class ProcessStub:
    """Only this owned process is controllable; no blanket process termination."""

    def __init__(self, *, target, args):
        self.target, self.args = target, args
        self.output = Path(args[-1])
        self.alive = False
        self.pid = None
        self.exitcode = None
        self.closed = False
        self.calls = []
        self.faults = {}
        self.ignore_terminate = False

    def fail(self, name):
        self.calls.append(name)
        remaining = self.faults.get(name, 0)
        if remaining:
            self.faults[name] = remaining - 1
            raise OSError(f"Injected {name} failure")

    def start(self):
        self.fail("start")
        self.alive, self.pid = True, 123456

    def is_alive(self):
        self.fail("is_alive")
        return self.alive

    def terminate(self):
        self.fail("terminate")
        if not self.ignore_terminate:
            self.alive, self.exitcode = False, -15

    def kill(self):
        self.fail("kill")
        self.alive, self.exitcode = False, -9

    def join(self, **kwargs):
        self.fail("join")

    def close(self):
        self.fail("close")
        assert not self.alive
        self.closed = True

    def complete(self, payload):
        self.output.write_text(json.dumps(payload, allow_nan=True))
        self.alive, self.exitcode = False, 0


@pytest.fixture
def controlled_manager():
    manager = JobManager()
    processes = []

    def process(**kwargs):
        child = ProcessStub(**kwargs)
        processes.append(child)
        return child

    manager.context = SimpleNamespace(Process=process)
    manager.test_processes = processes
    try:
        yield manager
    finally:
        # Clear deliberately persistent fault injection before final disposal.
        for child in processes:
            child.faults.clear()
        manager.close()
        assert not manager.running and not manager.cleanup_pending


def ready(manager, result):
    job = manager.submit("forward", small_project(), None)
    process = manager.test_processes[-1]
    process.complete({"result": deepcopy(result), "error": None, "error_code": None})
    return job["id"], process


def wait_job(manager, job_id, limit=30):
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        job = manager.get(job_id)
        if job["status"] != "running":
            return job
        time.sleep(0.025)
    pytest.fail("Owned numerical job did not finish within test deadline")


def assert_disposed(manager, job_id, process, output):
    assert job_id not in manager.running and job_id not in manager.cleanup_pending
    assert not output.exists()
    assert process._closed  # Real multiprocessing handle is also released.
    assert not manager.cleanup_errors


def test_real_spawned_small_2d_unequal_axes_and_exact_binding(result_2d):
    manager = JobManager()
    try:
        project = small_project()
        original = deepcopy(project)
        job = manager.submit("forward", project, None)
        active = manager.running[job["id"]]
        assert active.process.pid and active.process.is_alive()
        project["layers"][0]["cd_y_nm"] = 1
        complete = wait_job(manager, job["id"])
        assert complete["status"] == "succeeded", complete
        _, normalized, expected_hash = normalized_project_and_hash(original)
        assert complete["input_hash"] == expected_hash == complete["result"]["metadata"]["input_hash"]
        assert manager.capture(job["id"])[1]["project"] == normalized
        for pol in ("s", "p"):
            assert complete["result"]["spectra"][pol] == result_2d["spectra"][pol]
            orders = complete["result"]["spectra"][pol]["orders"][0]
            assert len(orders) == 15
            assert {(o["m"], o["n"]) for o in orders} == {(m, n) for m in range(-1, 2) for n in range(-2, 3)}
            assert all(set(("R_s", "R_p", "T_s", "T_p")) <= set(order) for order in orders)
        assert_disposed(manager, job["id"], active.process, active.output)
    finally:
        manager.close()


def test_real_spawned_default_h5_matches_frozen_actual_powers():
    expected = json.loads(gzip.decompress((FIXTURES / "default-result-H5-adapter-1.4.json.gz").read_bytes()))
    manager = JobManager()
    try:
        job = manager.submit("forward", default_project(), None)
        active = manager.running[job["id"]]
        complete = wait_job(manager, job["id"], limit=120)
        assert complete["status"] == "succeeded", complete
        actual = complete["result"]
        assert complete["input_hash"] == actual["metadata"]["input_hash"] == expected["metadata"]["input_hash"]
        assert actual["schema_version"] == "1.2" and actual["result_type"] == "forward"
        assert actual["metadata"]["adapter_version"] == "1.4.0"
        assert not actual["metadata"]["offline_reference_override"]
        for pol in ("s", "p"):
            for field in ("R", "T", "R_specular", "T_specular", "A_balance"):
                np.testing.assert_allclose(actual["spectra"][pol][field], expected["spectra"][pol][field], atol=1e-10, rtol=0)
            for actual_rows, expected_rows in zip(actual["spectra"][pol]["orders"], expected["spectra"][pol]["orders"], strict=True):
                assert [(o["m"], o["n"]) for o in actual_rows] == [(o["m"], o["n"]) for o in expected_rows]
                for field in ("R", "T", "R_s", "R_p", "T_s", "T_p", "kx_over_k0", "ky_over_k0"):
                    np.testing.assert_allclose([o[field] for o in actual_rows], [o[field] for o in expected_rows], atol=1e-10, rtol=0)
        assert_disposed(manager, job["id"], active.process, active.output)
    finally:
        manager.close()


def test_two_threads_racing_2d_admission_reserve_exactly_one(controlled_manager):
    manager = controlled_manager
    barrier = threading.Barrier(2)

    def submit():
        barrier.wait()
        try:
            return manager.submit("forward", small_project(), None)
        except RuntimeError:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: submit(), range(2)))
    assert sum(item is not None for item in results) == 1
    assert len(manager.jobs) == len(manager.inputs) == len(manager.running) == len(manager.test_processes) == 1


@pytest.mark.parametrize("kinds", [("legacy", "legacy"), ("2d", "legacy"), ("legacy", "2d")])
def test_shared_two_process_limit_and_immediate_rejection(controlled_manager, kinds):
    manager = controlled_manager
    jobs = [manager.submit("forward", small_project() if kind == "2d" else legacy_project(), None) for kind in kinds]
    for project in (small_project(), legacy_project()):
        with pytest.raises(RuntimeError, match="slots are busy"):
            manager.submit("forward", project, None)
    assert len(manager.jobs) == len(manager.inputs) == len(manager.running) == len(manager.test_processes) == 2
    manager.cancel(jobs[0]["id"])
    manager.submit("forward", legacy_project(), None)
    assert len(manager.running) == 2


def test_uniform_12_project_still_consumes_the_only_2d_slot(controlled_manager):
    project = small_project()
    project["layers"] = [project["layers"][1]]
    controlled_manager.submit("forward", project, None)
    with pytest.raises(RuntimeError, match="2D calculation slot"):
        controlled_manager.submit("forward", small_project(), None)
    assert len(controlled_manager.test_processes) == len(controlled_manager.jobs) == 1


@pytest.mark.parametrize("change", [
    lambda p: p["solver"].update(harmonics_x=6),
    lambda p: p["solver"].update(harmonics_y=0),
    lambda p: p["solver"].update(harmonics_x=True),
    lambda p: p["solver"].update(offline_reference_override=True),
    lambda p: p["solver"].update(diagnostics=True),
    lambda p: p["illumination"].update(wavelengths_nm=[float(450 + i) for i in range(32)]),
    lambda p: p.update(layers=[deepcopy(p["layers"][0]) for _ in range(9)]),
])
def test_invalid_public_caps_never_allocate_a_process(controlled_manager, change):
    project = small_project()
    change(project)
    with pytest.raises(ValueError):
        controlled_manager.submit("forward", project, None)
    assert not controlled_manager.jobs and not controlled_manager.inputs and not controlled_manager.test_processes


def test_2d_fit_without_a_valid_spec_is_rejected_before_process_allocation(controlled_manager):
    with pytest.raises(ValueError, match="parameters"):
        controlled_manager.submit("fit", small_project(), {})
    assert not controlled_manager.jobs and not controlled_manager.test_processes


@pytest.mark.parametrize("elapsed, expected", [(119.999, "succeeded"), (120, "failed"), (120.001, "failed")])
def test_observation_time_deadline_includes_already_exited_child(controlled_manager, result_2d, monkeypatch, elapsed, expected):
    manager = controlled_manager
    monkeypatch.setattr("api.jobs.time.monotonic", lambda: 100.0)
    job_id, process = ready(manager, result_2d)
    monkeypatch.setattr("api.jobs.time.monotonic", lambda: 100 + elapsed)
    complete = manager.get(job_id)
    assert complete["status"] == expected
    assert complete["error_code"] == (None if expected == "succeeded" else "timeout")
    assert process.closed and not process.output.exists() and not manager.running
    timestamp = complete["completed_at"]
    for _ in range(3):
        assert manager.cancel(job_id)["completed_at"] == timestamp
        assert manager.get(job_id) == complete


def test_result_validation_crossing_deadline_cannot_publish_success(controlled_manager, result_2d, monkeypatch):
    now = [100.0]
    monkeypatch.setattr("api.jobs.time.monotonic", lambda: now[0])
    job_id, _ = ready(controlled_manager, result_2d)
    from rcwa_core.project_io import validate_result_for_project

    def late_validation(*args):
        result = validate_result_for_project(*args)
        now[0] = 220.0
        return result

    monkeypatch.setattr("rcwa_core.project_io.validate_result_for_project", late_validation)
    complete = controlled_manager.get(job_id)
    assert complete["status"] == "failed" and complete["error_code"] == "timeout"
    assert complete["result"] is None


@pytest.mark.parametrize("cancel_first", [True, False])
def test_complete_cancel_capture_race_has_one_terminal_outcome(controlled_manager, result_2d, monkeypatch, cancel_first):
    manager = controlled_manager
    job_id, process = ready(manager, result_2d)
    if cancel_first:
        cancelled = manager.cancel(job_id)
        assert cancelled["status"] == "cancelled"
        assert manager.capture(job_id)[0] == manager.get(job_id) == cancelled
    else:
        entered, release = threading.Event(), threading.Event()
        from rcwa_core.project_io import validate_result_for_project

        def blocked_validation(*args):
            entered.set()
            assert release.wait(5)
            return validate_result_for_project(*args)

        monkeypatch.setattr("rcwa_core.project_io.validate_result_for_project", blocked_validation)
        with ThreadPoolExecutor(max_workers=3) as pool:
            poll = pool.submit(manager.get, job_id)
            assert entered.wait(5)
            cancel = pool.submit(manager.cancel, job_id)
            capture = pool.submit(manager.capture, job_id)
            release.set()
            complete = poll.result(timeout=5)
            assert complete["status"] == "succeeded"
            assert cancel.result(timeout=5) == capture.result(timeout=5)[0] == complete
    assert process.closed and not process.output.exists() and not manager.running


def test_cancel_at_deadline_is_timeout_and_capture_is_immutable(controlled_manager, monkeypatch):
    monkeypatch.setattr("api.jobs.time.monotonic", lambda: 0)
    job = controlled_manager.submit("forward", small_project(), None)
    monkeypatch.setattr("api.jobs.time.monotonic", lambda: 120)
    result = controlled_manager.cancel(job["id"])
    assert result["error_code"] == "timeout"
    captured, inputs = controlled_manager.capture(job["id"])
    captured["status"] = "succeeded"
    inputs["project"]["layers"][0]["cd_y_nm"] = 0
    assert controlled_manager.get(job["id"])["status"] == "failed"
    assert controlled_manager.inputs[job["id"]]["project"]["layers"][0]["cd_y_nm"] == 60
    assert controlled_manager.get("missing") is None and controlled_manager.capture("missing") is None


@pytest.mark.parametrize("payload", [
    [], {}, {"result": {}, "error": None, "error_code": None},
    {"result": None, "error": 3, "error_code": "numerical_failure"},
    {"result": None, "error": "failure", "error_code": "arbitrary"},
    {"result": {}, "error": None, "error_code": "numerical_failure"},
])
def test_bad_envelopes_are_isolated_and_allow_fresh_work(controlled_manager, result_2d, payload):
    manager = controlled_manager
    job_id, process = ready(manager, result_2d)
    process.complete(payload)
    assert manager.get(job_id)["error_code"] == "invalid_worker_output"
    assert process.closed and not process.output.exists() and not manager.running
    next_id, _ = ready(manager, result_2d)
    assert manager.get(next_id)["status"] == "succeeded"


@pytest.mark.parametrize("fault", ["missing", "partial", "oversized", "crash", "wrong_schema", "nonfinite", "wrong_hash", "offline_reference", "validator"])
def test_worker_output_failures_cleanup_and_restart(controlled_manager, result_2d, monkeypatch, fault):
    manager = controlled_manager
    job_id, process = ready(manager, result_2d)
    if fault == "missing":
        process.output.unlink()
    elif fault == "partial":
        process.output.write_text('{"result":')
    elif fault == "oversized":
        process.output.write_bytes(b" " * 8_000_001)
    elif fault == "crash":
        process.exitcode = 17
    elif fault in {"wrong_schema", "nonfinite", "wrong_hash", "offline_reference"}:
        result = deepcopy(result_2d)
        if fault == "wrong_schema":
            result["schema_version"] = "1.1"
        elif fault == "nonfinite":
            result["spectra"]["s"]["R"][0] = float("nan")
        elif fault == "wrong_hash":
            result["metadata"]["input_hash"] = "0" * 64
        else:
            result["metadata"]["offline_reference_override"] = True
        process.complete({"result": result, "error": None, "error_code": None})
    else:
        def broken_validator(*args):
            raise RuntimeError("Validator implementation fault")
        monkeypatch.setattr("rcwa_core.project_io.validate_result_for_project", broken_validator)
    complete = manager.get(job_id)
    assert complete["status"] == "failed"
    assert complete["error_code"] == ("worker_crashed" if fault == "crash" else "invalid_worker_output")
    assert process.closed and not process.output.exists() and not manager.running
    monkeypatch.undo()
    next_id, _ = ready(manager, result_2d)
    assert manager.get(next_id)["status"] == "succeeded"


@pytest.mark.parametrize("fault", ["construction", "start", "partial_start"])
def test_failed_start_does_not_strand_a_reserved_2d_slot(controlled_manager, result_2d, fault):
    manager = controlled_manager
    original = manager.context

    def broken_process(**kwargs):
        if fault == "construction":
            raise OSError("Process constructor failed")
        process = original.Process(**kwargs)
        original_start = process.start

        def broken_start():
            if fault == "partial_start":
                original_start()
                process.output.write_text("partial")
            raise OSError("start failed")

        process.start = broken_start
        return process

    manager.context = SimpleNamespace(Process=broken_process)
    job = manager.submit("forward", small_project(), None)
    assert job["status"] == "failed" and job["error_code"] == "worker_start_failed"
    assert not manager.running and not manager.cleanup_pending and not manager.cleanup_errors
    manager.context = original
    next_id, _ = ready(manager, result_2d)
    assert manager.get(next_id)["status"] == "succeeded"


@pytest.mark.parametrize("operation", ["join", "close", "unlink"])
def test_recoverable_cleanup_exception_is_retried(controlled_manager, result_2d, monkeypatch, operation):
    manager = controlled_manager
    job_id, process = ready(manager, result_2d)
    if operation == "unlink":
        original = Path.unlink
        attempts = []

        def flaky_unlink(path, *args, **kwargs):
            if path == process.output and not attempts:
                attempts.append(1)
                raise PermissionError("Transient file lock")
            return original(path, *args, **kwargs)

        monkeypatch.setattr(Path, "unlink", flaky_unlink)
    else:
        process.faults[operation] = 1
    assert manager.get(job_id)["status"] == "succeeded"
    assert process.closed and not process.output.exists()
    assert not manager.running and not manager.cleanup_pending and not manager.cleanup_errors


@pytest.mark.parametrize("operation", ["join", "close", "unlink"])
def test_persistent_cleanup_is_explicit_and_retried_on_next_poll(controlled_manager, result_2d, monkeypatch, operation):
    manager = controlled_manager
    job_id, process = ready(manager, result_2d)
    if operation == "unlink":
        original = Path.unlink

        def broken_unlink(path, *args, **kwargs):
            if path == process.output:
                raise PermissionError("Persistent file lock")
            return original(path, *args, **kwargs)

        monkeypatch.setattr(Path, "unlink", broken_unlink)
    else:
        process.faults[operation] = 10
    result = manager.get(job_id)
    assert result["status"] == "succeeded"
    assert job_id in manager.cleanup_errors
    if operation == "join":
        assert job_id in manager.running  # Never release an unproven child slot.
        with pytest.raises(RuntimeError, match="2D calculation slot"):
            manager.submit("forward", small_project(), None)
    else:
        assert job_id in manager.cleanup_pending and job_id not in manager.running
        original_count = len(manager.jobs)
        for _ in range(2):
            with pytest.raises(RuntimeError, match="awaiting resource cleanup"):
                manager.submit("forward", small_project(), None)
            assert len(manager.jobs) == original_count
            assert len(manager.test_processes) == 1
    process.faults.clear()
    monkeypatch.undo()
    manager.poll()
    assert not manager.cleanup_pending and not manager.running and not manager.cleanup_errors
    assert manager.get(job_id) == result
    next_id, _ = ready(manager, result_2d)
    assert manager.get(next_id)["status"] == "succeeded"


def test_cancel_terminate_failure_and_kill_fallback(controlled_manager):
    manager = controlled_manager
    job = manager.submit("forward", small_project(), None)
    process = manager.test_processes[-1]
    process.faults["terminate"] = 1
    result = manager.cancel(job["id"])
    assert result["status"] == "cancelled" and "kill" in process.calls
    assert process.closed and not manager.running


def test_process_inspection_exception_does_not_kill_observer(controlled_manager):
    manager = controlled_manager
    job = manager.submit("forward", small_project(), None)
    manager.test_processes[-1].faults["is_alive"] = 1
    assert manager.get(job["id"])["error_code"] == "invalid_worker_output"
    manager.poll()
    assert not manager.running and not manager.cleanup_errors


def test_history_eviction_and_normalized_input_capture(controlled_manager, result_2d):
    manager = controlled_manager
    for index in range(100):
        manager.jobs[str(index)] = {"status": "succeeded"}
        manager.inputs[str(index)] = {"project": {"old": True}}
    project = small_project()
    job = manager.submit("forward", project, None)
    project["layers"][0]["cd_y_nm"] = 1
    assert len(manager.jobs) == len(manager.inputs) == 100
    assert "0" not in manager.jobs and "0" not in manager.inputs
    assert manager.inputs[job["id"]]["project"] == small_project()
    job["status"] = "forged"
    assert manager.jobs[job["id"]]["status"] == "running"


def blocked_calculation(kind, project, fit, output):
    """Disposable spawn-safe lifecycle fixture, deliberately no physics work."""
    Path(output).write_text("ready")
    time.sleep(300)


def stubborn_calculation(kind, project, fit, output):
    if os.name == "posix":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    blocked_calculation(kind, project, fit, output)


def blocking_context(target):
    context = mp.get_context("spawn")
    return SimpleNamespace(Process=lambda **kwargs: context.Process(target=target, args=kwargs["args"]))


def wait_started(active):
    deadline = time.monotonic() + 10
    while not active.output.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert active.output.exists() and active.process.is_alive()


def assert_pid_gone(pid):
    assert pid not in {child.pid for child in mp.active_children()}
    if os.name == "posix":
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


def test_real_h5_cancel_while_alive_and_fresh_2d_job_succeeds():
    manager = JobManager()
    try:
        job = manager.submit("forward", default_project(), None)
        active = manager.running[job["id"]]
        pid = active.process.pid
        assert active.process.is_alive()
        cancelled = manager.cancel(job["id"])
        assert cancelled["status"] == "cancelled"
        assert manager.cancel(job["id"]) == manager.get(job["id"]) == cancelled
        assert_disposed(manager, job["id"], active.process, active.output)
        assert_pid_gone(pid)
        fresh = manager.submit("forward", small_project(), None)
        assert wait_job(manager, fresh["id"])["status"] == "succeeded"
    finally:
        manager.close()


def test_real_short_deadline_kill_fallback_and_fresh_admission():
    manager = JobManager(timeout=0.5)
    manager.context = blocking_context(stubborn_calculation)
    try:
        job = manager.submit("forward", small_project(), None)
        active = manager.running[job["id"]]
        pid = active.process.pid
        wait_started(active)
        result = wait_job(manager, job["id"], limit=10)
        assert result["status"] == "failed" and result["error_code"] == "timeout"
        assert_disposed(manager, job["id"], active.process, active.output)
        assert_pid_gone(pid)
        manager.context, manager.timeout = mp.get_context("spawn"), 120
        fresh = manager.submit("forward", small_project(), None)
        assert wait_job(manager, fresh["id"])["status"] == "succeeded"
    finally:
        manager.close()


def test_shutdown_during_real_2d_worker_cleans_process_directory_and_restart():
    manager = JobManager()
    manager.context = blocking_context(blocked_calculation)
    job = manager.submit("forward", small_project(), None)
    active = manager.running[job["id"]]
    pid, directory = active.process.pid, Path(manager.directory.name)
    wait_started(active)
    manager.close()
    assert manager.jobs[job["id"]]["status"] == "cancelled"
    assert_disposed(manager, job["id"], active.process, active.output)
    assert not directory.exists()
    assert_pid_gone(pid)
    manager.close()
    restarted = JobManager()
    try:
        assert restarted.get(job["id"]) is None
        fresh = restarted.submit("forward", small_project(), None)
        assert wait_job(restarted, fresh["id"])["status"] == "succeeded"
    finally:
        restarted.close()


@pytest.mark.skipif(os.getenv("RCWA_RUN_120S_WATCHDOG") != "1", reason="Release-level actual 120-second watchdog")
def test_real_120_second_blocked_worker_watchdog():
    manager = JobManager()
    assert manager.timeout == 120
    manager.context = blocking_context(blocked_calculation)
    started = time.monotonic()
    try:
        job = manager.submit("forward", small_project(), None)
        active = manager.running[job["id"]]
        pid = active.process.pid
        wait_started(active)
        result = wait_job(manager, job["id"], limit=125)
        elapsed = time.monotonic() - started
        assert 120 <= elapsed < 130
        assert result["error_code"] == "timeout" and result["status"] == "failed"
        assert_disposed(manager, job["id"], active.process, active.output)
        assert_pid_gone(pid)
        manager.context = mp.get_context("spawn")
        fresh = manager.submit("forward", small_project(), None)
        assert wait_job(manager, fresh["id"])["status"] == "succeeded"
    finally:
        manager.close()


def test_public_cap_edges_are_admitted_without_widening_them(controlled_manager):
    project = small_project()
    project["solver"] = {"harmonics_x": 5, "harmonics_y": 5}
    project["illumination"]["wavelengths_nm"] = [450.0 + i * 10 for i in range(31)]
    project["layers"] = [deepcopy(project["layers"][0]) for _ in range(8)]
    for layer in project["layers"]:
        layer["thickness_nm"] = 2000.0
    job = controlled_manager.submit("forward", project, None)
    assert job["status"] == "running" and len(controlled_manager.test_processes) == 1
    assert controlled_manager.running[job["id"]].resource_class == "2d"


def test_one_bad_job_does_not_prevent_other_job_completion(controlled_manager, result_2d):
    manager = controlled_manager
    broken = manager.submit("forward", small_project(), None)
    legacy = manager.submit("forward", legacy_project(), None)
    first, second = manager.test_processes
    first.complete({"result": {}, "error": None, "error_code": None})
    second.complete({"result": forward_project(legacy_project()), "error": None, "error_code": None})
    manager.poll()
    assert manager.jobs[broken["id"]]["error_code"] == "invalid_worker_output"
    assert manager.jobs[legacy["id"]]["status"] == "succeeded"
    assert first.closed and second.closed and not manager.running and not manager.cleanup_errors


@pytest.mark.parametrize("failures", [1, 2])
def test_directory_cleanup_faults_are_explicit_and_recoverable(monkeypatch, failures):
    manager = JobManager()
    directory = Path(manager.directory.name)
    original = manager.directory.cleanup
    remaining = [failures]

    def cleanup():
        if remaining[0]:
            remaining[0] -= 1
            raise PermissionError("Temporary directory is locked")
        original()

    monkeypatch.setattr(manager.directory, "cleanup", cleanup)
    manager.close()
    if failures == 2:
        assert directory.exists()
        assert manager.cleanup_errors["directory"] == ("directory_cleanup:PermissionError",)
        manager.close()
    assert not directory.exists() and not manager.cleanup_errors


@pytest.mark.parametrize("classes, expected_statuses", [
    (("2d", "2d"), [202, 429]),
    (("legacy", "legacy", "legacy"), [202, 202, 429]),
    (("2d", "legacy", "2d"), [202, 202, 429]),
])
def test_independent_http_clients_share_atomic_worker_admission(controlled_manager, tmp_path, monkeypatch,
                                                              classes, expected_statuses):
    import asyncio
    import httpx
    from api.main import create_app

    manager = controlled_manager
    monkeypatch.setattr("api.main.JobManager", lambda **kwargs: manager)
    app = create_app(f"sqlite:///{tmp_path / 'admission.db'}")

    async def exercise():
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost") as first:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost") as second:
                    clients = (first, second)
                    replies = await asyncio.gather(*(
                        clients[index % 2].post("/api/jobs", json={"project": small_project() if kind == "2d" else legacy_project()})
                        for index, kind in enumerate(classes)
                    ))
                    assert sorted(reply.status_code for reply in replies) == expected_statuses
                    admitted = sum(reply.status_code == 202 for reply in replies)
                    assert len(manager.jobs) == len(manager.inputs) == len(manager.running) == len(manager.test_processes) == admitted
                    for reply in replies:
                        if reply.status_code == 429:
                            assert reply.json()["error"]["code"] == "capacity"

    asyncio.run(exercise())


@pytest.mark.parametrize("state", ["ready", "timeout", "already_cancelled"])
@pytest.mark.parametrize("cancel_first", [True, False])
def test_http_poll_cancel_snapshot_race_saves_only_one_committed_success(controlled_manager, result_2d, tmp_path,
                                                                       monkeypatch, state, cancel_first):
    import asyncio
    import httpx
    from api.main import create_app

    manager = controlled_manager
    monkeypatch.setattr("api.main.JobManager", lambda **kwargs: manager)
    app = create_app(f"sqlite:///{tmp_path / 'snapshot-race.db'}")

    async def exercise():
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost") as first:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost") as second:
                    submitted = await first.post("/api/jobs", json={"project": small_project()})
                    assert submitted.status_code == 202, submitted.text
                    job_id = submitted.json()["id"]
                    process = manager.test_processes[-1]
                    if state == "already_cancelled":
                        assert (await first.delete(f"/api/jobs/{job_id}")).json()["status"] == "cancelled"
                    else:
                        process.complete({"result": deepcopy(result_2d), "error": None, "error_code": None})
                        if state == "timeout":
                            manager.running[job_id].deadline = time.monotonic()
                    calls = {
                        "poll": lambda: first.get(f"/api/jobs/{job_id}"),
                        "cancel": lambda: second.delete(f"/api/jobs/{job_id}"),
                        "save": lambda: first.post("/api/snapshots", json={"job_id": job_id}),
                    }
                    order = ("cancel", "save", "poll") if cancel_first else ("save", "poll", "cancel")
                    responses = dict(zip(order, await asyncio.gather(*(calls[key]() for key in order)), strict=True))
                    final = (await second.get(f"/api/jobs/{job_id}")).json()
                    assert final["status"] in {"succeeded", "cancelled", "failed"}
                    assert responses["cancel"].json() == responses["poll"].json() == final
                    assert (await first.delete(f"/api/jobs/{job_id}")).json() == final
                    saved = responses["save"]
                    if final["status"] == "succeeded":
                        assert saved.status_code == 201, saved.text
                        snapshot = saved.json()
                        assert snapshot["result"] == final["result"]
                        assert snapshot["project"] == small_project()
                        assert snapshot["provenance"]["completed_at"] == final["completed_at"]
                        repeated = await second.post("/api/snapshots", json={"job_id": job_id})
                        assert repeated.json() == snapshot
                        assert len((await first.get("/api/projects")).json()) == 1
                    else:
                        assert saved.status_code == 409
                        assert (await second.post("/api/snapshots", json={"job_id": job_id})).status_code == 409
                        assert (await first.get("/api/projects")).json() == []
                    if state == "timeout":
                        assert final["error_code"] == "timeout"
                    assert process.closed and not process.output.exists() and not manager.running
                    assert not manager.cleanup_pending and not manager.cleanup_errors

    asyncio.run(exercise())


def test_retained_size_deduplicates_within_each_job_not_across_jobs():
    import sys
    from api.jobs import retained_size

    shared = {"table": [float(i) for i in range(10)]}
    once = [shared]
    repeated = [shared, shared]
    assert retained_size(repeated) - retained_size(once) == sys.getsizeof(repeated) - sys.getsizeof(once)
    assert retained_size(shared, shared) == retained_size(shared)
    assert retained_size(shared) + retained_size(shared) == 2 * retained_size(shared)


def test_history_memory_budget_evicts_oldest_completed_and_clears_sizes(controlled_manager, result_2d):
    from api.jobs import retained_size

    manager = controlled_manager
    first, _ = ready(manager, result_2d)
    assert manager.get(first)["status"] == "succeeded"
    manager.max_history_bytes = manager.history_sizes[first] * 2
    finished = [first]
    for _ in range(5):
        job_id, _ = ready(manager, result_2d)
        assert manager.get(job_id)["status"] == "succeeded"
        finished.append(job_id)
        assert manager.history_bytes == sum(manager.history_sizes.values()) <= manager.max_history_bytes
        assert set(manager.jobs) == set(manager.inputs) == set(manager.history_sizes)
        for retained_id in manager.jobs:
            assert manager.history_sizes[retained_id] == retained_size(manager.jobs[retained_id], manager.inputs[retained_id])
    assert set(manager.jobs) == set(finished[-2:])
    assert manager.get(first) is None and manager.capture(first) is None
    job, inputs = manager.capture(finished[-1])
    assert job["result"]["metadata"]["input_hash"] == job["input_hash"]
    assert inputs["project"] == small_project()
    manager.max_history_bytes = 1
    manager.poll()
    assert not manager.jobs and not manager.inputs and not manager.history_sizes and manager.history_bytes == 0


def test_history_budget_never_evicts_live_worker_or_cleanup_ownership(controlled_manager, result_2d):
    manager = controlled_manager
    live = manager.submit("forward", legacy_project(), None)
    complete, process = ready(manager, result_2d)
    assert manager.get(complete)["status"] == "succeeded"
    manager.max_history_bytes = manager.history_sizes[complete]
    later, process = ready(manager, result_2d)
    process.faults["close"] = 10
    assert manager.get(later)["status"] == "succeeded"
    assert complete not in manager.jobs
    assert live["id"] in manager.running and manager.get(live["id"])["status"] == "running"
    assert later in manager.cleanup_pending and later in manager.inputs
    # Ownership records may temporarily exceed a tiny injected budget. They are
    # bounded by the two worker slots, with further admission blocked.
    manager.max_history_bytes = 1
    manager.poll()
    assert live["id"] in manager.jobs and later in manager.jobs
    with pytest.raises(RuntimeError, match="awaiting resource cleanup"):
        manager.submit("forward", small_project(), None)
    process.faults.clear()
    manager.poll()
    assert later not in manager.jobs and not manager.cleanup_pending and manager.history_bytes == 0
    assert live["id"] in manager.running


def test_oversized_single_result_is_failed_before_commit_and_discarded(controlled_manager, result_2d):
    from api.jobs import retained_size

    manager = controlled_manager
    job_id, process = ready(manager, result_2d)
    manager.max_history_bytes = retained_size(manager.jobs[job_id], manager.inputs[job_id]) + 2000
    complete = manager.get(job_id)
    assert complete["status"] == "failed" and complete["error_code"] == "history_limit"
    assert complete["result"] is None
    assert manager.get(job_id) == manager.cancel(job_id) == complete
    assert manager.history_bytes <= manager.max_history_bytes
    assert process.closed and not process.output.exists()
    assert manager.capture(job_id)[1]["project"] == small_project()


def test_tiny_budget_expires_input_after_cleanup_without_size_leak(controlled_manager, result_2d):
    manager = controlled_manager
    job_id, process = ready(manager, result_2d)
    manager.max_history_bytes = 1
    assert manager.get(job_id) is None
    assert not manager.jobs and not manager.inputs and not manager.history_sizes and manager.history_bytes == 0
    assert not manager.running and not manager.cleanup_pending and not manager.cleanup_errors
    assert process.closed and not process.output.exists()


def test_history_sizing_crossing_deadline_still_commits_timeout(controlled_manager, result_2d, monkeypatch):
    from api.jobs import retained_size

    now = [100.0]
    monkeypatch.setattr("api.jobs.time.monotonic", lambda: now[0])
    job_id, _ = ready(controlled_manager, result_2d)

    def slow_size(*values):
        size = retained_size(*values)
        now[0] = 220.0
        return size

    monkeypatch.setattr("api.jobs.retained_size", slow_size)
    complete = controlled_manager.get(job_id)
    assert complete["status"] == "failed" and complete["error_code"] == "timeout"
    assert complete["result"] is None


def test_saved_snapshot_survives_memory_eviction_and_database_restart(controlled_manager, result_2d, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from api.main import create_app

    manager = controlled_manager
    database = f"sqlite:///{tmp_path / 'history-budget.db'}"
    monkeypatch.setattr("api.main.JobManager", lambda **kwargs: manager)
    with TestClient(create_app(database), base_url="http://localhost") as client:
        limits = client.get("/api/capabilities").json()["limits"]
        assert limits["retained_completed_bytes"] == manager.max_history_bytes == 64_000_000
        assert limits["retained_jobs"] == 100
        first, _ = ready(manager, result_2d)
        assert client.get(f"/api/jobs/{first}").json()["status"] == "succeeded"
        saved = client.post("/api/snapshots", json={"job_id": first}).json()
        assert client.post("/api/snapshots", json={"job_id": first}).json() == saved
        manager.max_history_bytes = manager.history_sizes[first] + 100
        assert client.get("/api/capabilities").json()["limits"]["retained_completed_bytes"] == manager.max_history_bytes
        second, _ = ready(manager, result_2d)
        assert client.get(f"/api/jobs/{second}").json()["status"] == "succeeded"
        assert client.get(f"/api/jobs/{first}").status_code == 404
        assert client.post("/api/snapshots", json={"job_id": first}).status_code == 404
        assert client.get(f"/api/projects/{saved['id']}").json() == saved
        assert manager.history_bytes == sum(manager.history_sizes.values()) <= manager.max_history_bytes
    monkeypatch.setattr("api.main.JobManager", JobManager)
    with TestClient(create_app(database), base_url="http://localhost") as client:
        assert client.get(f"/api/projects/{saved['id']}").json() == saved
        assert client.get(f"/api/jobs/{second}").status_code == 404


def test_resource_profiler_counts_protocol_stamp_and_supplied_unicode_request_id(controlled_manager, result_2d, tmp_path):
    from api.storage import ProjectStore
    import importlib.util

    path = Path(__file__).resolve().parents[2] / "scripts/true_2d_worker_resources.py"
    spec = importlib.util.spec_from_file_location("true_2d_worker_resources", path)
    profiler = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(profiler)
    snapshot_measurements, snapshot_provenance = profiler.snapshot_measurements, profiler.snapshot_provenance

    job_id, _ = ready(controlled_manager, result_2d)
    job, inputs = controlled_manager.capture(job_id)
    store = ProjectStore(f"sqlite:///{tmp_path / 'wire-profile.db'}")
    try:
        snapshot = store.save(inputs["project"], job["result"], provenance=snapshot_provenance(job, inputs["project"]))
    finally:
        store.engine.dispose()
    standard = snapshot_measurements(snapshot)
    request_id = "응답-7😀"
    supplied = snapshot_measurements(snapshot, request_id, supplied_request_id=True)
    delta = len(json.dumps(request_id, ensure_ascii=False).encode("utf-8")) - len(b"1")
    assert standard["request_id_source"] == "synthetic default"
    assert supplied["request_id"] == request_id and "caller-supplied" in supplied["request_id_source"]
    for version, report in standard["wire_versions"].items():
        assert supplied["wire_versions"][version]["jsonrpc_line_bytes"] == report["jsonrpc_line_bytes"] + delta
    legacy = standard["wire_versions"]["2025-11-25"]
    modern = standard["wire_versions"]["2026-07-28"]
    assert legacy["server_info_stamp"] is None and legacy["result_type"] is None
    assert modern["server_info_stamp"]["io.modelcontextprotocol/serverInfo"]["name"] == "RCWA Workbench"
    assert modern["result_type"] == "complete"
    assert modern["jsonrpc_line_bytes"] > legacy["jsonrpc_line_bytes"]
    assert standard["estimated_completed_job_input_bytes"] > standard["result_bytes"]


def test_actual_max_resource_payload_history_retains_seven_within_64mb(controlled_manager, record_property):
    """Replay captured maximum payloads through controlled workers, never solve."""
    from api.jobs import MAX_HISTORY_BYTES, retained_size

    snapshot = json.loads(gzip.decompress((FIXTURES / "max-resource-snapshot.json.gz").read_bytes()))
    project, result = snapshot["project"], snapshot["result"]
    assert project["solver"] == {"harmonics_x": 5, "harmonics_y": 5}
    assert len(project["layers"]) == 8 and len(project["illumination"]["wavelengths_nm"]) == 31
    material_tables = [project["ambient"], project["substrate"]]
    for layer in project["layers"]:
        material_tables.extend([layer["material"], layer["background"]])
    assert len(material_tables) == 18
    assert all(material["kind"] == "tabulated" and len(material["wavelengths_nm"]) == 2000 for material in material_tables)
    manager = controlled_manager
    assert manager.max_history_bytes == MAX_HISTORY_BYTES == 64_000_000
    submitted, observed_sizes = [], []
    for _ in range(10):
        job = manager.submit("forward", deepcopy(project), None)
        job_id = job["id"]
        submitted.append(job_id)
        process = manager.test_processes[-1]
        process.complete({"result": deepcopy(result), "error": None, "error_code": None})
        manager.poll()
        committed = manager.jobs[job_id]
        assert committed["status"] == "succeeded"
        assert committed["input_hash"] == snapshot["provenance"]["input_hash"]
        assert committed["result"] == result and manager.inputs[job_id]["project"] == project
        size = manager.history_sizes[job_id]
        assert size == retained_size(committed, manager.inputs[job_id])
        observed_sizes.append(size)
        assert manager.history_bytes == sum(manager.history_sizes.values()) <= 64_000_000
        assert set(manager.jobs) == set(manager.inputs) == set(manager.history_sizes)
        assert not manager.running and not manager.cleanup_pending and not manager.cleanup_errors
        assert process.closed and not process.output.exists()
    expected_count, expected_bytes = 0, 0
    for size in reversed(observed_sizes):
        if expected_bytes + size > manager.max_history_bytes:
            break
        expected_bytes += size
        expected_count += 1
    assert expected_count == len(manager.jobs) == 7
    assert list(manager.jobs) == submitted[-7:]
    assert manager.history_bytes == expected_bytes
    assert all(manager.get(job_id) is None and manager.capture(job_id) is None for job_id in submitted[:-7])
    measurement = {
        "fixture": "max-resource-snapshot.json.gz", "completed_payloads_replayed": 10,
        "per_job_estimated_bytes": observed_sizes, "retained_jobs": len(manager.jobs),
        "retained_estimated_bytes": manager.history_bytes, "budget_bytes": manager.max_history_bytes,
    }
    record_property("max_resource_completed_history", json.dumps(measurement))
    print(json.dumps(measurement))
