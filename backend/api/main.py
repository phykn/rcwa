"""HTTP boundary: validate inputs, launch jobs, and save completed project snapshots."""

import asyncio
import json
import math
import os
import re
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError, model_validator

from api.change_preview import preview_changes
from api.stack_change_preview import ProposalTooLarge, bounded_proposal, preview_stack_changes
from api.jobs import JobManager
from api.storage import ProjectStore, canonical_hash
from api.contracts import (
    Capabilities,
    ChangePreviewRequest,
    ChangeProposal,
    StackChangePreviewRequest,
    StackChangeProposal,
    StoredServerSnapshot,
    ErrorResponse,
    JobRequest,
    JobResponse,
    SavedProject,
    SavedSummary,
    ServerSnapshot,
    SnapshotRequest,
    ValidationResponse,
)
from rcwa_core.contracts import ForwardResult
from rcwa_core.preflight import Diagnostic, engine_info, preflight_project
from rcwa_core.schemas import Project, StrictModel


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
        if result.get("schema_version") not in ("1.0", "1.1"):
            raise ValueError("Result schema_version must be 1.0 or 1.1")
        if result["schema_version"] == "1.1":
            ForwardResult.model_validate(result, strict=True)
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

    responses = {code: {"model": ErrorResponse} for code in (400, 403, 404, 409, 413, 422, 429, 503)}
    app = FastAPI(title="RCWA Workbench", version="0.3.0", lifespan=lifespan, responses=responses)
    origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")

    def error_response(status, code, message, diagnostics=None):
        return JSONResponse(
            status_code=status,
            content={
                "detail": message,
                "error": {"code": code, "message": message, "diagnostics": diagnostics or []},
            },
        )

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        if isinstance(error.detail, dict):
            return error_response(error.status_code, **error.detail)
        codes = {404: "not_found", 409: "job_not_succeeded", 429: "capacity", 503: "engine_unavailable"}
        return error_response(error.status_code, codes.get(error.status_code, "invalid_input"), str(error.detail))

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        diagnostics = []
        for item in error.errors():
            structured = getattr(item.get("ctx", {}).get("error"), "diagnostics", None)
            if structured:
                diagnostics.extend(d.model_dump() for d in structured)
                continue
            location = list(item["loc"])
            code = "unsupported_scope" if "geometry" in location or "schema_version" in location else "invalid_input"
            diagnostics.append({"code": code, "severity": "error", "location": location, "message": item["msg"]})
        return error_response(422, "invalid_input", "Request validation failed", diagnostics)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @app.middleware("http")
    async def limit_request_size(request: Request, call_next):
        # Local-only defense in depth, not authentication. Origin-less HTTP
        # scripts work; a browser cannot mutate through an unapproved Origin.
        hosts = request.headers.getlist("host")
        authority = (
            re.fullmatch(r"(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?", hosts[0], re.IGNORECASE)
            if len(hosts) == 1
            else None
        )
        if authority is None or (authority[2] is not None and not 1 <= int(authority[2]) <= 65535):
            return error_response(400, "disallowed_host", "Use a valid loopback local API host and port.")
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("origin")
            if origin is not None and origin not in origins:
                return error_response(403, "disallowed_origin", "Browser Origin is not permitted for local mutations.")
        # Bound JSON before model parsing, including chunked requests.
        if request.method in {"POST", "PUT", "PATCH"}:
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 2_000_000:
                    return error_response(413, "body_too_large", "Request exceeds the 2 MB limit")
            if body:
                try:

                    def reject_nonfinite(value):
                        raise ValueError(f"Non-finite JSON number: {value}")

                    parsed = json.loads(body, parse_constant=reject_nonfinite)
                    json.dumps(parsed, allow_nan=False)
                except (ValueError, UnicodeError, RecursionError):
                    return error_response(422, "invalid_json", "Request must be valid JSON with finite numbers")
            request._body = bytes(body)
        return await call_next(request)

    @app.get("/api/health")
    async def health():
        return {
            "status": "ok",
            "storage": app.state.store.backend,
            "engine": "meent",
            "engine_version": engine_info().installed_version,
            "engine_available": engine_info().available,
            "scope": "up to eight top-to-bottom 1D finite layers; classical mounting",
            "authentication": "local-demo-only",
        }

    @app.get("/api/example", response_model=Project)
    async def example():
        return Project().model_dump()

    @app.get("/api/capabilities", response_model=Capabilities)
    async def capabilities():
        return {
            "api_version": "0.3.0",
            "project_schema_version": "1.1",
            "result_schema_version": "1.1",
            "supported_project_schema_versions": ["1.0", "1.1"],
            "supported_result_schema_versions": ["1.0", "1.1"],
            "engine": engine_info(),
            "operations": [
                "validate", "preview_changes", "preview_stack_changes", "forward", "synthetic_fit", "poll", "cancel",
                "save_snapshot", "import_project",
            ],
            "geometry": ["1–8 top-to-bottom isotropic rectangle_1d or homogeneous finite layers; common period; invariant y; classical mounting",
                         "rectangle_1d: centered ridge with material/background; homogeneous: material only"],
            "polarizations": ["s", "p", "both"],
            "materials": ["constant", "tabulated: linear n/k interpolation, no extrapolation; lossless ambient"],
            "observables": ["R", "T", "R_specular", "T_specular", "A_balance", "order-resolved R/T"],
            "units": {
                "length": "nm",
                "wavelength": "vacuum nm",
                "angle": "degrees from +z",
                "power": "unit incident normal flux",
            },
            "limits": {
                "simultaneous_jobs": app.state.jobs.max_workers,
                "job_timeout_seconds": app.state.jobs.timeout,
                "retained_jobs": 100,
                "request_bytes": 2_000_000,
                "proposal_bytes": 8_000_000,
                "layers": 8,
                "wavelength_count": 81,
                "material_table_rows": 2000,
                "harmonics_min": 1,
                "harmonics_max": 20,
                "basis_size_max": 41,
                "wavelength_nm": [200, 2500],
                "period_nm": [20, 5000],
                "thickness_nm": [0, 2000],
                "angle_deg": [0, 75],
                "n": "0 < n <= 10",
                "k": "0 <= k <= 10",
                "cd": "0 <= CD <= period",
            },
            "persistence": {
                "jobs": "Volatile; lost on restart or oldest-completed eviction at 100 records",
                "snapshots": "Append-only database records; survive restart; save by succeeded forward job ID",
                "imports": "Always unverified, including legacy records and claimed provenance in JSON",
            },
            "limitations": [
                "Local loopback, one API worker, unauthenticated; Origin/Host checks are not authentication",
                "Static Pages is precomputed only, with no live API",
                "No phase, Jones, ellipsometry, arbitrary geometry, 2D patterns, anisotropy, or measured-data inversion",
                "Validation is not a solve or convergence certification",
                "T is substrate entrance-plane flux; no absorbing-substrate backside transmission",
                "A_balance is a flux deficit, not independently integrated absorption",
                "Example materials are synthetic, not calibrated optical constants",
                "Synthetic fitting requires exactly one rectangle and is limited to 41 wavelengths and 12 harmonics; it is not design optimization",
            ],
        }

    def admissibility(project):
        diagnostics = preflight_project(project)
        engine = engine_info()
        if not engine.available:
            diagnostics.append(
                Diagnostic(code="engine_unavailable", severity="error", location=["engine"], message=engine.message)
            )
        return diagnostics

    @app.post("/api/validate", response_model=ValidationResponse)
    async def validate(project: Project = Body(...)):
        diagnostics = admissibility(project)
        valid = not any(d.severity == "error" for d in diagnostics)
        return {
            "valid": valid,
            "project": project,
            "input_hash": canonical_hash(project.model_dump()),
            "diagnostics": diagnostics,
        }

    @app.post("/api/change-preview", response_model=ChangeProposal)
    async def change_preview(request: ChangePreviewRequest):
        """Preview caller-specified geometry without solving, persisting or applying."""
        try:
            return bounded_proposal(preview_changes(request))
        except ValidationError as error:
            # The combined candidate can violate CD <= period even when each
            # individual patch number is admissible. Preserve structured errors.
            errors = [
                {**item, "loc": ("body", "candidate_project", *item["loc"])}
                for item in error.errors()
            ]
            raise RequestValidationError(errors) from error

    @app.exception_handler(ProposalTooLarge)
    async def proposal_too_large(request, error):
        return error_response(413, "proposal_too_large", str(error))

    @app.post("/api/stack-change-preview", response_model=StackChangeProposal)
    async def stack_change_preview(request: StackChangePreviewRequest):
        """Preview one atomic stack replacement without solving, storing or applying."""
        try:
            return preview_stack_changes(request)
        except ValidationError as error:
            errors = [{**item, "loc": ("body", "candidate_project", *item["loc"])} for item in error.errors()]
            raise RequestValidationError(errors) from error

    @app.post("/api/jobs", status_code=202, response_model=JobResponse)
    async def submit(request: JobRequest):
        diagnostics = admissibility(request.project)
        errors = [d for d in diagnostics if d.severity == "error"]
        if errors:
            code = errors[0].code
            status = 503 if code == "engine_unavailable" else 422
            raise HTTPException(
                status,
                {"code": code, "message": errors[0].message, "diagnostics": [d.model_dump() for d in diagnostics]},
            )
        try:
            return app.state.jobs.submit(
                request.kind, request.project.model_dump(), request.fit.model_dump() if request.fit else None
            )
        except RuntimeError as error:
            raise HTTPException(429, str(error)) from error

    @app.get("/api/jobs/{job_id}", response_model=JobResponse)
    async def get_job(job_id: str):
        app.state.jobs.poll()
        job = app.state.jobs.jobs.get(job_id)
        if job is None:
            raise HTTPException(
                404, {"code": "job_missing", "message": "Job missing or expired; jobs are lost on API restart"}
            )
        return job

    @app.delete("/api/jobs/{job_id}", response_model=JobResponse)
    async def cancel_job(job_id: str):
        job = app.state.jobs.cancel(job_id)
        if job is None:
            raise HTTPException(404, {"code": "job_missing", "message": "Job missing or expired"})
        return job

    @app.post("/api/snapshots", status_code=201, response_model=ServerSnapshot)
    async def save_snapshot(request: SnapshotRequest):
        app.state.jobs.poll()
        job = app.state.jobs.jobs.get(request.job_id)
        if job is None:
            raise HTTPException(404, {"code": "job_missing", "message": "Job missing or expired; cannot save it"})
        if job["kind"] != "forward" or job["status"] != "succeeded":
            raise HTTPException(409, "Only a succeeded forward job can be saved as a server snapshot")
        project = app.state.jobs.inputs[request.job_id]["project"]
        result = job["result"]
        provenance = {
            "source": "server_computed",
            "job_id": job["id"],
            "input_hash": job["input_hash"],
            "project_schema_version": project["schema_version"],
            "result_schema_version": result["schema_version"],
            "engine": result["metadata"]["engine"],
            "engine_version": result["metadata"]["version"],
            "adapter_version": engine_info().adapter_version,
            "submitted_at": job["created_at"],
            "completed_at": job["completed_at"],
            "canonicalization": "SHA-256; normalized Project; sorted JSON keys; compact separators; UTF-8; finite numbers",
        }
        return app.state.store.save(project, result, provenance=provenance)

    @app.post("/api/projects", status_code=201, response_model=SavedProject)
    async def save_project(request: SaveRequest):
        return app.state.store.save(request.project.model_dump(), request.result)

    @app.get("/api/projects", response_model=list[SavedSummary])
    async def list_projects():
        return app.state.store.list()

    @app.get("/api/projects/{project_id}", response_model=SavedProject)
    async def get_project(project_id: str):
        project = app.state.store.get(project_id)
        if project is None:
            raise HTTPException(404, "Project not found")
        if project["provenance"]["source"] == "server_computed":
            StoredServerSnapshot.model_validate(project, strict=True)
        return project

    return app


app = create_app()
