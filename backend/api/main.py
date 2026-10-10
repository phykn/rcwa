"""HTTP boundary: validate inputs, launch jobs, and save completed project snapshots."""

import asyncio
import json
import math
import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import model_validator

from api.jobs import JobManager
from api.storage import ProjectStore
from rcwa_core.schemas import FitRequest, Project, StrictModel


class JobRequest(StrictModel):
    kind: Literal["forward", "fit"] = "forward"
    project: Project
    fit: dict | None = None


class SaveRequest(StrictModel):
    project: Project
    result: dict | None = None

    @model_validator(mode="after")
    def validate_result(self):
        if self.result is None:
            return self
        # Saved/imported powers are user data, not a new server-certified solve.
        # Enforce a reloadable shape and reject non-finite nested metadata too.
        try:
            json.dumps(self.result, allow_nan=False)
        except (ValueError, TypeError) as error:
            raise ValueError("Result must contain finite JSON values") from error
        result = self.result
        if result.get("schema_version") != "1.0":
            raise ValueError("Result schema_version must be 1.0")
        wavelengths = self.project.illumination.wavelengths_nm
        if result.get("wavelengths_nm") != wavelengths:
            raise ValueError("Result wavelengths must match the saved project")
        expected = (
            {"s", "p"} if self.project.illumination.polarization == "both" else {self.project.illumination.polarization}
        )
        spectra = result.get("spectra")
        if not isinstance(spectra, dict) or set(spectra) != expected:
            raise ValueError("Result polarizations must match the saved project")
        for series in spectra.values():
            if not isinstance(series, dict):
                raise ValueError("Each spectrum must be an object")
            for key in ("R", "T", "R_specular", "T_specular", "A_balance"):
                values = series.get(key)
                if (
                    not isinstance(values, list)
                    or len(values) != len(wavelengths)
                    or any(
                        isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                        for value in values
                    )
                ):
                    raise ValueError(f"Result {key} must contain one finite number per wavelength")
        if not isinstance(result.get("warnings"), list) or not all(isinstance(v, str) for v in result["warnings"]):
            raise ValueError("Result warnings must be a list of strings")
        if not isinstance(result.get("metadata"), dict):
            raise ValueError("Result metadata must be an object")
        return self


def create_app(database_url: str | None = None, job_timeout: float = 120) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.store = ProjectStore(database_url)
        app.state.jobs = JobManager(timeout=job_timeout)

        async def observe():
            while True:
                app.state.jobs.poll()
                await asyncio.sleep(0.1)

        observer = asyncio.create_task(observe())
        try:
            yield
        finally:
            observer.cancel()
            try:
                await observer
            except asyncio.CancelledError:
                pass
            app.state.jobs.close()
            app.state.store.engine.dispose()

    app = FastAPI(title="RCWA Workbench", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @app.middleware("http")
    async def limit_request_size(request: Request, call_next):
        # Bound JSON before model parsing, including chunked requests.
        if request.method in {"POST", "PUT", "PATCH"}:
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 2_000_000:
                    from starlette.responses import JSONResponse

                    return JSONResponse({"detail": "Request exceeds the 2 MB limit"}, status_code=413)
            if body:
                try:

                    def reject_nonfinite(value):
                        raise ValueError(f"Non-finite JSON number: {value}")

                    parsed = json.loads(body, parse_constant=reject_nonfinite)
                    json.dumps(parsed, allow_nan=False)
                except (ValueError, UnicodeError, RecursionError):
                    from starlette.responses import JSONResponse

                    return JSONResponse({"detail": "Request must be valid JSON with finite numbers"}, status_code=422)
            request._body = bytes(body)
        return await call_next(request)

    @app.get("/api/health")
    async def health():
        return {
            "status": "ok",
            "storage": app.state.store.backend,
            "engine": "meent",
            "engine_version": "0.13.2",
            "scope": "single-layer 1D classical mounting",
            "authentication": "local-demo-only",
        }

    @app.get("/api/example")
    async def example():
        return Project().model_dump()

    @app.post("/api/jobs", status_code=202)
    async def submit(request: JobRequest):
        if request.kind == "fit":
            try:
                FitRequest(project=request.project, **(request.fit or {}))
            except (ValueError, TypeError) as error:
                raise HTTPException(422, str(error)) from error
        elif request.fit is not None:
            raise HTTPException(422, "Forward jobs must not include fit options")
        try:
            return app.state.jobs.submit(request.kind, request.project.model_dump(), request.fit)
        except RuntimeError as error:
            raise HTTPException(429, str(error)) from error

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str):
        app.state.jobs.poll()
        job = app.state.jobs.jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "Job not found; temporary jobs are lost on API restart")
        return job

    @app.delete("/api/jobs/{job_id}")
    async def cancel_job(job_id: str):
        job = app.state.jobs.cancel(job_id)
        if job is None:
            raise HTTPException(404, "Job not found")
        return job

    @app.post("/api/projects", status_code=201)
    async def save_project(request: SaveRequest):
        return app.state.store.save(request.project.model_dump(), request.result)

    @app.get("/api/projects")
    async def list_projects():
        return app.state.store.list()

    @app.get("/api/projects/{project_id}")
    async def get_project(project_id: str):
        project = app.state.store.get(project_id)
        if project is None:
            raise HTTPException(404, "Project not found")
        return project

    return app


app = create_app()
