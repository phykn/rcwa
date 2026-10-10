"""Bounded disposable numerical processes, without a queue broker.

Run one API process. In-memory job state is intentionally not durable; save a
completed project to retain its result. Every calculation has a hard deadline.
"""

import json
from copy import deepcopy
import multiprocessing as mp
import os
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from api.storage import canonical_hash

# Must be set before a spawned process imports NumPy/BLAS.
for variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[variable] = "1"


def calculate(kind: str, project: dict, fit: dict | None, output: str) -> None:
    """Only validated JSON crosses the process boundary; never executable input."""
    try:
        from rcwa_core.schemas import Project
        from rcwa_core.solver import forward

        model = Project.model_validate(project)
        if kind == "forward":
            result = forward(model)
        else:
            from rcwa_core.fitting import fit_cd

            result = fit_cd(model, fit)
        payload = {"result": result, "error": None, "error_code": None}
    except Exception as error:
        from rcwa_core.preflight import EngineUnavailableError, PreflightError
        from rcwa_core.solver import SolverError

        # Only deliberately public numerical messages cross the HTTP boundary.
        public = str(error) if isinstance(error, (SolverError, PreflightError)) else "Numerical calculation failed."
        payload = {
            "result": None,
            "error": public,
            "error_code": error.code if isinstance(error, EngineUnavailableError) else "numerical_failure",
        }
    Path(output).write_text(json.dumps(payload, allow_nan=False), encoding="utf-8")


@dataclass
class Running:
    process: mp.Process
    started: float
    output: Path


class JobManager:
    def __init__(self, max_workers: int = 2, timeout: float = 120):
        self.max_workers = max_workers
        self.timeout = timeout
        self.jobs: dict[str, dict] = {}
        self.running: dict[str, Running] = {}
        self.inputs: dict[str, dict] = {}
        self.directory = tempfile.TemporaryDirectory(prefix="rcwa-jobs-")
        self.context = mp.get_context("spawn")

    def submit(self, kind: str, project: dict, fit: dict | None) -> dict:
        self.poll()
        if len(self.running) >= self.max_workers:
            raise RuntimeError("Both calculation slots are busy. Try again after a job completes.")
        # Bounded history; ongoing jobs are never evicted.
        for old_id in list(self.jobs):
            if len(self.jobs) < 100:
                break
            if old_id not in self.running:
                del self.jobs[old_id]
                self.inputs.pop(old_id, None)
        project, fit = deepcopy(project), deepcopy(fit)
        job_id = str(uuid4())
        output = Path(self.directory.name) / f"{job_id}.json"
        process = self.context.Process(target=calculate, args=(kind, project, fit, str(output)))
        job = dict(
            id=job_id,
            kind=kind,
            status="running",
            created_at=datetime.now(timezone.utc).isoformat(),
            result=None,
            error=None,
            error_code=None,
            completed_at=None,
            input_hash=canonical_hash(project),
        )
        process.start()
        self.running[job_id] = Running(process, time.monotonic(), output)
        self.jobs[job_id] = job
        self.inputs[job_id] = {"project": project, "fit": fit}
        return deepcopy(job)

    def poll(self) -> None:
        for job_id, active in list(self.running.items()):
            if active.process.is_alive():
                if time.monotonic() - active.started > self.timeout:
                    self.cancel(job_id, "Calculation exceeded the time limit.", "failed")
                continue
            active.process.join()
            job = self.jobs[job_id]
            try:
                if active.output.stat().st_size > 8_000_000:
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
                    job.update(result=None, error=payload["error"], error_code=payload["error_code"], status="failed")
                else:
                    if payload["error_code"] is not None:
                        raise ValueError("Invalid worker success")
                    inputs = self.inputs[job_id]
                    from rcwa_core.contracts import validate_result

                    result = validate_result(job["kind"], payload["result"], inputs["project"], inputs["fit"])
                    job.update(result=result.model_dump(mode="json"), error=None, error_code=None, status="succeeded")
            except (OSError, ValueError, TypeError, KeyError):
                job.update(
                    status="failed",
                    result=None,
                    error="Numerical process returned missing or invalid output.",
                    error_code="invalid_worker_output",
                )
            job["completed_at"] = datetime.now(timezone.utc).isoformat()
            active.output.unlink(missing_ok=True)
            active.process.close()
            del self.running[job_id]

    def cancel(self, job_id: str, error: str | None = None, status: str = "cancelled") -> dict | None:
        active = self.running.pop(job_id, None)
        if active:
            active.process.terminate()
            active.process.join(timeout=2)
            if active.process.is_alive():
                active.process.kill()
                active.process.join()
            active.process.close()
            active.output.unlink(missing_ok=True)
            self.jobs[job_id].update(
                status=status,
                error=error,
                result=None,
                error_code="timeout" if status == "failed" else "cancelled",
                completed_at=datetime.now(timezone.utc).isoformat(),
            )
        return self.jobs.get(job_id)

    def close(self) -> None:
        for job_id in list(self.running):
            self.cancel(job_id)
        self.directory.cleanup()
