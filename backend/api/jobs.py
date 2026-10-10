"""Bounded disposable numerical processes, without a queue broker.

Run one API process. In-memory job state is intentionally not durable; save a
completed project to retain its result. Every calculation has a hard deadline.
"""

import json
import multiprocessing as mp
import os
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

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
        payload = {"result": result, "error": None}
    except Exception as error:
        payload = {"result": None, "error": f"{type(error).__name__}: {error}"}
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
        )
        process.start()
        self.running[job_id] = Running(process, time.monotonic(), output)
        self.jobs[job_id] = job
        return job.copy()

    def poll(self) -> None:
        for job_id, active in list(self.running.items()):
            if active.process.is_alive():
                if time.monotonic() - active.started > self.timeout:
                    self.cancel(job_id, "Calculation exceeded the time limit.", "failed")
                continue
            active.process.join()
            job = self.jobs[job_id]
            try:
                payload = json.loads(active.output.read_text(encoding="utf-8"))
                job.update(payload, status="failed" if payload["error"] else "succeeded")
            except (OSError, ValueError):
                job.update(status="failed", error="Numerical process exited without a result.")
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
            self.jobs[job_id].update(status=status, error=error)
        return self.jobs.get(job_id)

    def close(self) -> None:
        for job_id in list(self.running):
            self.cancel(job_id)
        self.directory.cleanup()
