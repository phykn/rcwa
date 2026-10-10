"""Bounded disposable numerical processes, without a queue broker.

Run one API process. In-memory job state is intentionally not durable; save a
completed project to retain its result. Every calculation has a hard deadline.
"""

import json
import logging
from copy import deepcopy
import multiprocessing as mp
import os
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

# Must be set before a spawned process imports NumPy/BLAS.
for variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[variable] = "1"

LOGGER = logging.getLogger(__name__)
MAX_OUTPUT_BYTES = 8_000_000
MAX_HISTORY_BYTES = 64_000_000
MAX_HISTORY_JOBS = 100
TIMEOUT_MESSAGE = "Calculation exceeded the time limit."


def retained_size(*values) -> int:
    """Estimate retained JSON-object memory, deduplicating identity per job.

    Separate jobs are intentionally summed independently. This conservatively
    counts strings shared between records more than once, unlike serialized size.
    """
    seen = set()

    def measure(value):
        identity = id(value)
        if identity in seen:
            return 0
        seen.add(identity)
        size = sys.getsizeof(value)
        if isinstance(value, dict):
            size += sum(measure(key) + measure(item) for key, item in value.items())
        elif isinstance(value, (list, tuple)):
            size += sum(measure(item) for item in value)
        return size

    return sum(measure(value) for value in values)


def calculate(kind: str, project: dict, fit: dict | None, output: str) -> None:
    """Only validated JSON crosses the process boundary; never executable input."""
    try:
        from rcwa_core.project_io import forward_project, parse_project

        model = parse_project(project)
        if kind == "forward":
            result = forward_project(model)
        elif kind == "fit" and model.schema_version != "1.2":
            from rcwa_core.fitting import fit_cd

            result = fit_cd(model, fit)
        else:
            raise ValueError("Unsupported calculation kind for this project")
        payload = {"result": result, "error": None, "error_code": None}
    except Exception as error:
        from rcwa_core.preflight import EngineUnavailableError, PreflightError, SolverError

        # Only deliberately public numerical messages cross the HTTP boundary.
        public = str(error) if isinstance(error, (SolverError, PreflightError)) else "Numerical calculation failed."
        payload = {
            "result": None,
            "error": public,
            "error_code": error.code if isinstance(error, EngineUnavailableError) else "numerical_failure",
        }
    # The observer reads only after exit; an interrupted/partial write is invalid.
    Path(output).write_text(json.dumps(payload, allow_nan=False), encoding="utf-8")


@dataclass
class Running:
    process: mp.Process
    started: float
    output: Path
    resource_class: str = "legacy"
    deadline: float | None = None
    reaped: bool = False
    process_closed: bool = False
    output_removed: bool = False


class JobManager:
    def __init__(self, max_workers: int = 2, timeout: float = 120, max_history_bytes: int = MAX_HISTORY_BYTES):
        self.max_workers = max_workers
        self.timeout = timeout
        if max_history_bytes <= 0:
            raise ValueError("History memory budget must be positive")
        self.max_history_bytes = max_history_bytes
        self.history_sizes: dict[str, int] = {}
        self.history_bytes = 0
        self.jobs: dict[str, dict] = {}
        self.running: dict[str, Running] = {}
        self.inputs: dict[str, dict] = {}
        # Reaped children release numerical slots even if a filesystem/handle
        # cleanup needs another attempt. Unreaped children stay in running.
        self.cleanup_pending: dict[str, Running] = {}
        self.cleanup_errors: dict[str, tuple[str, ...]] = {}
        self.directory = tempfile.TemporaryDirectory(prefix="rcwa-jobs-")
        self.context = mp.get_context("spawn")
        self._lock = threading.RLock()
        self._closed = False
        self._directory_cleaned = False

    def submit(self, kind: str, project: dict, fit: dict | None) -> dict:
        from rcwa_core.project_io import normalized_project_and_hash

        # Normalize/revalidate copied input before reserving any worker resource.
        model, project, input_hash = normalized_project_and_hash(project)
        fit = deepcopy(fit)
        if kind not in {"forward", "fit"} or (kind == "fit" and model.schema_version == "1.2"):
            raise ValueError("Only forward calculations are supported for 1.2 projects")
        if kind == "forward" and fit is not None:
            raise ValueError("Forward jobs must not include fit options")
        resource_class = "2d" if model.schema_version == "1.2" else "legacy"
        with self._lock:
            if self._closed:
                raise RuntimeError("Calculation manager is closed.")
            self.poll()
            if self.cleanup_pending:
                raise RuntimeError("A previous calculation is awaiting resource cleanup. Try again after cleanup completes.")
            if len(self.running) >= self.max_workers:
                raise RuntimeError("Both calculation slots are busy. Try again after a job completes.")
            if resource_class == "2d" and any(a.resource_class == "2d" for a in self.running.values()):
                raise RuntimeError("The 2D calculation slot is busy. Try again after it completes.")
            self._prune_history(reserve=1)
            job_id = str(uuid4())
            output = Path(self.directory.name) / f"{job_id}.json"
            job = dict(
                id=job_id,
                kind=kind,
                status="running",
                created_at=datetime.now(timezone.utc).isoformat(),
                result=None,
                error=None,
                error_code=None,
                completed_at=None,
                input_hash=input_hash,
            )
            # Holding the lock makes reservation and start atomic to submitters.
            # Register before start so even a partially successful start can be
            # stopped, reaped and accounted for on the failure path.
            self.jobs[job_id] = job
            self.inputs[job_id] = {"project": project, "fit": fit}
            active = None
            try:
                process = self.context.Process(target=calculate, args=(kind, project, fit, str(output)))
                started = time.monotonic()
                active = Running(process, started, output, resource_class, started + self.timeout)
                self.running[job_id] = active
                process.start()
            except Exception:
                self._finish(job_id, active, "failed", error="Numerical process could not be started.",
                             error_code="worker_start_failed")
            return deepcopy(job)

    def _expired(self, active: Running) -> bool:
        deadline = active.deadline if active.deadline is not None else active.started + self.timeout
        return time.monotonic() >= deadline

    def _remember_terminal(self, job_id: str) -> None:
        if job_id not in self.history_sizes and self.jobs[job_id]["status"] != "running":
            size = retained_size(self.jobs[job_id], self.inputs.get(job_id))
            self.history_sizes[job_id] = size
            self.history_bytes += size

    def _prune_history(self, *, reserve=0) -> None:
        # Normally sizes are cached at the terminal transition. Also recognize
        # pre-existing records, preserving the manager's historical test/read API.
        for job_id in self.jobs:
            self._remember_terminal(job_id)
        for old_id in list(self.history_sizes):
            if len(self.jobs) + reserve <= MAX_HISTORY_JOBS and self.history_bytes <= self.max_history_bytes:
                break
            if old_id in self.running or old_id in self.cleanup_pending:
                continue  # Never discard ownership needed to reap/clean a child.
            self.jobs.pop(old_id, None)
            self.inputs.pop(old_id, None)
            self.history_bytes -= self.history_sizes.pop(old_id)

    def _finish(self, job_id, active, status, *, result=None, error=None, error_code=None):
        """The sole terminal transition; caller holds the lock.

        Deadline means acceptance time, not child exit time. Validation and
        retained-size measurement may take time: check just before committing.
        """
        job = self.jobs[job_id]
        if job["status"] == "running":
            outcome = dict(status=status, result=result, error=error, error_code=error_code,
                           completed_at=datetime.now(timezone.utc).isoformat())
            size = retained_size({**job, **outcome}, self.inputs.get(job_id))
            if status == "succeeded" and size > self.max_history_bytes:
                outcome.update(status="failed", result=None, error="Calculation result exceeds the history memory limit.",
                               error_code="history_limit")
            if active is not None and self._expired(active):
                outcome.update(status="failed", result=None, error=TIMEOUT_MESSAGE, error_code="timeout")
            job.update(outcome)
            self._remember_terminal(job_id)
        if active is not None:
            self._cleanup(job_id, active)
        # A single captured input can exceed an intentionally tiny injected test
        # budget. It expires after cleanup, rather than remaining unbounded.
        self._prune_history()

    def _cleanup(self, job_id: str, active: Running) -> None:
        """Retry recoverable cleanup faults without allowing them to kill poll.

        Never claim a slot was released until the owned child is proven reaped.
        Persistent faults are retained and logged for inspection and later retry.
        """
        errors = []
        for _ in range(2):
            if active.reaped:
                break
            try:
                if active.process.is_alive():
                    try:
                        active.process.terminate()
                    except Exception:
                        # A kill fallback still works after a terminate failure.
                        pass
                    try:
                        active.process.join(timeout=2)
                    except Exception:
                        pass
                    if active.process.is_alive():
                        active.process.kill()
                    active.process.join(timeout=2)
                    if active.process.is_alive():
                        raise RuntimeError("Owned numerical child did not stop")
                # join() rejects an unstarted multiprocessing.Process. A failed
                # start with no pid has no child to reap and can simply close.
                if getattr(active.process, "pid", False) is not None:
                    active.process.join(timeout=0)
                active.reaped = True
            except Exception as error:
                errors.append(f"process_reap:{type(error).__name__}")
        if active.reaped:
            self.running.pop(job_id, None)
            for _ in range(2):
                if active.process_closed:
                    break
                try:
                    active.process.close()
                    active.process_closed = True
                except Exception as error:
                    errors.append(f"process_close:{type(error).__name__}")
            for _ in range(2):
                if active.output_removed:
                    break
                try:
                    active.output.unlink(missing_ok=True)
                    active.output_removed = True
                except Exception as error:
                    errors.append(f"output_unlink:{type(error).__name__}")
        if active.reaped and active.process_closed and active.output_removed:
            self.cleanup_pending.pop(job_id, None)
            self.cleanup_errors.pop(job_id, None)
        else:
            if active.reaped:
                self.cleanup_pending[job_id] = active
            diagnostic = tuple(sorted(set(errors))) or ("cleanup_incomplete",)
            if self.cleanup_errors.get(job_id) != diagnostic:
                LOGGER.error("Numerical worker cleanup incomplete for %s: %s", job_id, ", ".join(diagnostic))
            self.cleanup_errors[job_id] = diagnostic

    def poll(self) -> None:
        with self._lock:
            for job_id, active in list(self.cleanup_pending.items()):
                self._cleanup(job_id, active)
            for job_id, active in list(self.running.items()):
                job = self.jobs[job_id]
                if job["status"] != "running":
                    self._cleanup(job_id, active)
                    continue
                try:
                    if self._expired(active):
                        self._finish(job_id, active, "failed", error=TIMEOUT_MESSAGE, error_code="timeout")
                        continue
                    if active.process.is_alive():
                        continue
                    if getattr(active.process, "exitcode", 0) not in (None, 0):
                        self._finish(job_id, active, "failed", error="Numerical process exited unexpectedly.",
                                     error_code="worker_crashed")
                        continue
                    if active.output.stat().st_size > MAX_OUTPUT_BYTES:
                        raise ValueError("Worker output exceeds its limit")
                    payload = json.loads(active.output.read_text(encoding="utf-8"))
                    if not isinstance(payload, dict) or set(payload) != {"result", "error", "error_code"}:
                        raise ValueError("Invalid worker envelope")
                    if payload["error"] is not None:
                        if (
                            not isinstance(payload["error"], str)
                            or payload["result"] is not None
                            or payload["error_code"]
                            not in {"numerical_failure", "engine_unavailable", "engine_version_mismatch"}
                        ):
                            raise ValueError("Invalid worker failure")
                        self._finish(job_id, active, "failed", error=payload["error"], error_code=payload["error_code"])
                    else:
                        if payload["error_code"] is not None:
                            raise ValueError("Invalid worker success")
                        inputs = self.inputs[job_id]
                        from rcwa_core.project_io import validate_result_for_project

                        result = validate_result_for_project(job["kind"], payload["result"],
                                                             inputs["project"], inputs["fit"])
                        result = result.model_dump(mode="json")
                        self._finish(job_id, active, "succeeded", result=result)
                except Exception:
                    # Bad output, validator failures and process inspection
                    # exceptions are isolated to one job; observer stays alive.
                    self._finish(job_id, active, "failed",
                                 error="Numerical process returned missing or invalid output.",
                                 error_code="invalid_worker_output")
            self._prune_history()

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            self.poll()
            return deepcopy(self.jobs.get(job_id))

    def capture(self, job_id: str) -> tuple[dict, dict] | None:
        """Atomically capture server-owned job and input for a snapshot save."""
        with self._lock:
            self.poll()
            if job_id not in self.jobs:
                return None
            return deepcopy(self.jobs[job_id]), deepcopy(self.inputs[job_id])

    def cancel(self, job_id: str, error: str | None = None, status: str = "cancelled") -> dict | None:
        with self._lock:
            active = self.running.get(job_id)
            if active:
                self._finish(job_id, active, status, error=error,
                             error_code="timeout" if status == "failed" else "cancelled")
            elif job_id in self.cleanup_pending:
                self._cleanup(job_id, self.cleanup_pending[job_id])
            self._prune_history()
            return deepcopy(self.jobs.get(job_id))

    def close(self) -> None:
        with self._lock:
            self._closed = True
            for job_id in list(self.running):
                self.cancel(job_id)
            self.poll()
            if self.running:
                self.cleanup_errors["directory"] = ("owned_children_not_reaped",)
                LOGGER.error("Numerical directory retained because owned children are not reaped")
                return
            for _ in range(2):
                if self._directory_cleaned:
                    break
                try:
                    self.directory.cleanup()
                    self._directory_cleaned = True
                    self.cleanup_errors.pop("directory", None)
                except Exception as error:
                    self.cleanup_errors["directory"] = (f"directory_cleanup:{type(error).__name__}",)
            if not self._directory_cleaned:
                LOGGER.error("Numerical directory cleanup incomplete: %s", self.cleanup_errors["directory"])
            # Directory cleanup can also resolve a previously failing unlink.
            for job_id, active in list(self.cleanup_pending.items()):
                self._cleanup(job_id, active)
            self._prune_history()
