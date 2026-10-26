import asyncio
import json
import logging
import math
import os
import re
from contextlib import asynccontextmanager
from typing import Annotated, Literal
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError, model_validator

from api.material_diagnostics import material_default_diagnostics
from api.diagnostics import (
    MAX_ERROR_DIAGNOSTICS as MAX_ERROR_DIAGNOSTICS,
    MAX_ERROR_LOCATION_BYTES as MAX_ERROR_LOCATION_BYTES,
    MAX_ERROR_TEXT_BYTES as MAX_ERROR_TEXT_BYTES,
    _bounded_diagnostics, _bounded_text, structured_diagnostics,
)
from api.dimension_change_preview import DimensionChangePreviewRequest, DimensionChangeProposal, preview_2d_changes
from api.change_preview import preview_changes
from api.stack_change_preview import MAX_PROPOSAL_BYTES, ProposalTooLarge, bounded_proposal, preview_stack_changes
from api.jobs import MAX_HISTORY_JOBS, AdmissionUnavailable, JobManager
from api.storage import ProjectStore, canonical_hash
from api.contracts import (
    Capabilities,
    ChangePreviewRequest,
    ChangeProposal,
    StackChangePreviewRequest,
    StackChangeProposal,
    StoredServerSnapshot,
    ErrorResponse,
    InputProject,
    JobRequest,
    JobResponse,
    SavedProject,
    SavedSummary,
    ServerSnapshot,
    SnapshotRequest,
    ValidationResponse,
    JobSummary, SnapshotSummary, SnapshotReceipt, SnapshotIndex, SnapshotInputs,
)
from api.result_summary import SummaryUnavailable, summarize_job, summarize_snapshot
from api.snapshot_views import SnapshotViewUnavailable, snapshot_index, snapshot_inputs
from rcwa_core.contracts import ForwardResult
from rcwa_core.preflight import Diagnostic, engine_info
from rcwa_core.project_io import preflight_project_any, validate_result_for_project
from rcwa_core.schemas import Project, StrictModel
from rcwa_core.schemas_2d import Project2D
from rcwa_core.solver_2d import ADAPTER_VERSION_2D


MAX_RESULT_DEPTH = 32  # computed results nest under ten levels


def _nesting_depth(value) -> int:
    """Container nesting depth, iteratively so hostile input cannot exhaust the stack."""
    deepest, stack = 0, [(value, 1)]
    while stack:
        item, depth = stack.pop()
        if isinstance(item, (dict, list)):
            deepest = max(deepest, depth)
            if depth <= MAX_RESULT_DEPTH:
                stack.extend((child, depth + 1) for child in (item.values() if isinstance(item, dict) else item))
    return deepest


class SaveRequest(StrictModel):
    project: InputProject
    result: dict | None = None

    @model_validator(mode="after")
    def validate_result(self):
        if self.result is None:
            return self
        # Saved/imported powers are user data, not a new server-certified solve.
        # Enforce a reloadable shape and reject non-finite nested metadata too.
        if _nesting_depth(self.result) > MAX_RESULT_DEPTH:
            # Deeper JSON saves but cannot be serialized back out, leaving an unreadable record.
            raise ValueError(f"Result JSON must not nest deeper than {MAX_RESULT_DEPTH} levels")
        try:
            json.dumps(self.result, allow_nan=False, ensure_ascii=False).encode("utf-8")
        except (ValueError, TypeError, UnicodeError) as error:
            raise ValueError("Result must contain finite JSON values and valid Unicode") from error
        result = self.result
        if isinstance(self.project, Project2D):
            validate_result_for_project("forward", result, self.project)
            return self
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


logger = logging.getLogger(__name__)
MAX_REQUEST_BYTES = 2_000_000


def _request_diagnostics(error):
    return structured_diagnostics(
        error, lambda location: "unsupported_scope" if "geometry" in location or "schema_version" in location
        else "invalid_input")


def candidate_error(error: ValidationError) -> RequestValidationError:
    """A combined candidate can break a cross-field rule (such as CD <= period)
    even when each patched number is admissible; report it on the candidate."""
    return RequestValidationError(
        [{**item, "loc": ("body", "candidate_project", *item["loc"])} for item in error.errors()])


def create_app(database_url: str | None = None, job_timeout: float = 120) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.store = ProjectStore(database_url)
        app.state.jobs = JobManager(timeout=job_timeout)

        async def observe():
            # Cleanup can wait seconds on a stuck child; keep it off the event loop.
            while True:
                try:
                    await asyncio.to_thread(app.state.jobs.poll)
                except Exception:
                    logger.exception("Job observer poll failed; retrying")
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
    app = FastAPI(title="RCWA Workbench", version="0.4.0", lifespan=lifespan, responses=responses)
    origins = [
        origin.strip()
        for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
        if origin.strip()
    ]

    def error_response(status, code, message, diagnostics=None):
        message = _bounded_text(message)
        return JSONResponse(
            status_code=status,
            content={
                "detail": message,
                "error": {"code": code, "message": message, "diagnostics": _bounded_diagnostics(diagnostics or [])},
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
        return error_response(422, "invalid_input", "Request validation failed", _request_diagnostics(error))

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
                if len(body) > MAX_REQUEST_BYTES:
                    return error_response(413, "body_too_large", "Request exceeds the 2 MB limit")
            if body:
                try:

                    def reject_nonfinite(value):
                        raise ValueError(f"Non-finite JSON number: {value}")

                    def unique_members(pairs):
                        value = {}
                        for key, item in pairs:
                            if key in value:
                                raise ValueError("Duplicate JSON member")
                            value[key] = item
                        return value

                    parsed = json.loads(body, parse_constant=reject_nonfinite,
                                        **({"object_pairs_hook": unique_members}
                                           if request.url.path == "/api/2d-change-preview" else {}))
                    # ASCII escaping hides lone surrogates; reject them in keys
                    # and values before persistence or worker allocation.
                    json.dumps(parsed, allow_nan=False, ensure_ascii=False).encode("utf-8")
                except (ValueError, UnicodeError, RecursionError):
                    return error_response(
                        422, "invalid_json", "Request must be valid JSON with finite numbers and valid Unicode"
                    )
            request._body = bytes(body)
        return await call_next(request)

    @app.get("/api/health")
    def health():
        return {
            "status": "ok",
            "storage": app.state.store.backend,
            "engine": "meent",
            "engine_version": engine_info().installed_version,
            "engine_available": engine_info().available,
            "scope": "up to eight finite layers; legacy 1D or explicit 1.2 centered rectangular 2D patterns",
            "authentication": "local-demo-only",
        }

    @app.get("/api/example", response_model=Project | Project2D)
    def example(example: Literal["legacy_1d", "circular_hole_2d"] = "legacy_1d"):
        if example == "circular_hole_2d":
            return Project2D.model_validate_json(
                (Path(__file__).parent / "examples" / "circular-hole-2d.json").read_text(encoding="utf-8"), strict=True
            )
        return Project().model_dump()

    @app.get("/api/capabilities", response_model=Capabilities)
    def capabilities():
        return {
            "api_version": "0.4.0",
            "project_schema_version": "1.2",
            "result_schema_version": "1.2",
            "supported_project_schema_versions": ["1.0", "1.1", "1.2"],
            "supported_result_schema_versions": ["1.0", "1.1", "1.2"],
            "engine": engine_info(),
            "operations": [
                "validate", "preview_changes", "preview_stack_changes", "preview_2d_changes", "forward", "synthetic_fit", "poll", "cancel",
                "save_snapshot", "import_project", "list_snapshots", "snapshot_inputs",
            ],
            "geometry": ["1–8 top-to-bottom isotropic rectangle_1d or homogeneous finite layers; common period; invariant y; classical mounting",
                         "rectangle_1d: centered ridge with material/background; homogeneous: material only",
                         "1.2: centered circular_hole_2d (64 midpoint strips), rectangle_2d, rectangle_1d or homogeneous; common orthogonal x/y periods"],
            "polarizations": ["s", "p", "both"],
            "materials": ["constant", "tabulated: linear n/k interpolation, no extrapolation; lossless ambient"],
            "observables": ["R", "T", "R_specular", "T_specular", "A_balance", "order-resolved R/T",
                            "1.2: integer (m,n) and outgoing local R_s/R_p/T_s/T_p powers"],
            "units": {
                "length": "nm",
                "wavelength": "vacuum nm",
                "angle": "degrees from +z",
                "power": "unit incident normal flux",
            },
            "limits": {
                "simultaneous_jobs": app.state.jobs.max_workers,
                "job_timeout_seconds": app.state.jobs.timeout,
                "retained_jobs": MAX_HISTORY_JOBS,
                "retained_completed_bytes": app.state.jobs.max_history_bytes,
                "request_bytes": MAX_REQUEST_BYTES,
                "proposal_bytes": MAX_PROPOSAL_BYTES,
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
                "jobs": "Volatile; lost on restart or oldest-completed eviction at 100 records or the reported "
                        "estimated completed-input/result memory budget. The byte bound applies to evictable history "
                        "after cleanup; ownership-protected terminal records may temporarily exceed it. "
                        "Unreaped children consume slots; cleanup-pending records block new admission. "
                        "An individually oversized result fails with history_limit. Save completed results promptly.",
                "snapshots": "Append-only database records; survive restart; save by succeeded forward job ID",
                "imports": "Always unverified, including legacy records and claimed provenance in JSON",
            },
            "project_profiles": {
                version: {
                    "operations": ["validate", "forward", "poll", "cancel", "save_snapshot", "import_project",
                                   "list_snapshots", "snapshot_inputs"]
                    + (["preview_2d_changes", "dimension_fit"] if version == "1.2" else ["synthetic_fit", "preview_changes", "preview_stack_changes"]),
                    "geometry": ["rectangle_1d", "homogeneous", "rectangle_2d", "circular_hole_2d"] if version == "1.2" else (
                        ["rectangle_1d"] if version == "1.0" else ["rectangle_1d", "homogeneous"]
                    ),
                    "wavelength_count": 31 if version == "1.2" else 81,
                    "harmonics": {"x": [1, 5], "y": [1, 5]} if version == "1.2" else {"x": [1, 20]},
                    "basis_size_max": 121 if version == "1.2" else 41,
                    "simultaneous_profile_jobs": 1 if version == "1.2" else app.state.jobs.max_workers,
                    "adapter_version": ADAPTER_VERSION_2D if version == "1.2" else engine_info().adapter_version,
                    "integer_representation": "Harmonics require integer JSON tokens; runtime rejects 3.0 although JSON Schema integer accepts it.",
                }
                for version in ("1.0", "1.1", "1.2")
            },
            "limitations": [
                "Local loopback, one API worker, unauthenticated; Origin/Host checks are not authentication",
                "Static Pages is precomputed only, with no live API",
                "No phase, Jones, ellipsometry, arbitrary or offset/rotated geometry, anisotropy, or measured-data inversion",
                "1.2 supports forward calculations and measured-spectrum dimension fits (POST /api/jobs kind=fit with fit_2d); legacy change proposals are not supported",
                "At most one 1.2 process within two total jobs; legacy limits above do not describe 1.2, use project_profiles",
                "The no-argument example remains legacy; /api/example?example=circular_hole_2d returns the explicit 1.2 circular input",
                "Material names are labels, not database lookups; supply constant n/k or a tabulated n/k table explicitly",
                "Optional summary views omit order arrays and full input/metadata; they are not full results or import files. "
                "Check warnings_omitted_count and inspect full warnings if nonzero. Summary envelopes are capped at 128 KB",
                "GET jobs/projects supports ?view=summary; POST snapshots supports ?view=receipt; full responses remain the default",
                "GET /api/projects?view=index discovers the latest 100 records, capped at 128 KB; may_have_more is true at 100. "
                "Discovery does not validate results; no match does not prove absence. Names are untrusted labels",
                "GET /api/projects/{id}?view=inputs returns exact normalized inputs/hash/provenance without results, capped at 3 MB. "
                "The complete saved record must pass its existing integrity checks before projection; this is not physics certification",
                "Full-result imports above the 2 MB request cap return 413; use project-only import or save a succeeded job by ID",
                "Validation is not a solve or convergence certification",
                "T is substrate entrance-plane flux; no absorbing-substrate backside transmission",
                "A_balance is a flux deficit, not independently integrated absorption",
                "Example materials are synthetic, not calibrated optical constants",
                "Synthetic fitting requires exactly one rectangle and is limited to 41 wavelengths and 12 harmonics; it is not design optimization",
            ],
        }

    def admissibility(project):
        diagnostics = preflight_project_any(project)
        engine = engine_info()
        if not engine.available:
            diagnostics.append(
                Diagnostic(code="engine_unavailable", severity="error", location=["engine"], message=engine.message)
            )
        return diagnostics

    @app.post("/api/validate", response_model=ValidationResponse, description=(
        "Check admissibility without solving. Material names are display labels, never database lookups. "
        "Supply explicit constant n/k or tabulated values. A name-only constant material uses n=1, k=0 "
        "and receives a request-specific material_name_only warning; normalized historical data is unchanged."
    ))
    def validate(project: Annotated[InputProject, Body()]):
        diagnostics = admissibility(project) + material_default_diagnostics(project)
        valid = not any(d.severity == "error" for d in diagnostics)
        return {
            "valid": valid,
            "project": project,
            "input_hash": canonical_hash(project.model_dump()),
            "diagnostics": diagnostics,
        }

    @app.post("/api/change-preview", response_model=ChangeProposal)
    def change_preview(request: ChangePreviewRequest):
        """Preview caller-specified geometry without solving, persisting or applying."""
        try:
            return bounded_proposal(preview_changes(request))
        except ValidationError as error:
            raise candidate_error(error) from error

    @app.exception_handler(SummaryUnavailable)
    async def summary_unavailable(request, error):
        return error_response(409, "summary_unavailable", str(error))

    @app.exception_handler(SnapshotViewUnavailable)
    async def snapshot_view_unavailable(request, error):
        return error_response(409, "snapshot_view_unavailable", str(error))

    @app.exception_handler(ProposalTooLarge)
    async def proposal_too_large(request, error):
        return error_response(413, "proposal_too_large", str(error))

    @app.post("/api/stack-change-preview", response_model=StackChangeProposal)
    def stack_change_preview(request: StackChangePreviewRequest):
        """Preview one atomic stack replacement without solving, storing or applying."""
        try:
            return preview_stack_changes(request)
        except ValidationError as error:
            raise candidate_error(error) from error

    @app.post("/api/2d-change-preview", response_model=DimensionChangeProposal)
    def dimension_change_preview(request: DimensionChangePreviewRequest):
        """Preview dimensions on an exact 1.2 base without engine lookup or side effects."""
        try:
            return preview_2d_changes(request)
        except ValidationError as error:
            raise candidate_error(error) from error

    @app.post("/api/jobs", status_code=202, response_model=JobResponse)
    def submit(request: JobRequest):
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
                request.kind, request.project.model_dump(), request.fit_options()
            )
        except AdmissionUnavailable as error:
            raise HTTPException(503, {"code": error.code, "message": str(error)}) from error
        except RuntimeError as error:
            raise HTTPException(429, str(error)) from error

    @app.get("/api/jobs/{job_id}", response_model=JobResponse | JobSummary)
    def get_job(job_id: str, view: Literal["full", "summary"] = "full"):
        job = app.state.jobs.get(job_id)
        if job is None:
            raise HTTPException(
                404, {"code": "job_missing", "message": "Job missing or expired; jobs are lost on API restart"}
            )
        if view == "summary":
            JobResponse.model_validate(job, strict=True)
            return summarize_job(job)
        return job

    @app.delete("/api/jobs/{job_id}", response_model=JobResponse)
    def cancel_job(job_id: str):
        job = app.state.jobs.cancel(job_id)
        if job is None:
            raise HTTPException(404, {"code": "job_missing", "message": "Job missing or expired"})
        return job

    @app.post("/api/snapshots", status_code=201, response_model=ServerSnapshot | SnapshotReceipt)
    def save_snapshot(request: SnapshotRequest, view: Literal["full", "receipt"] = "full"):
        captured = app.state.jobs.capture(request.job_id)
        if captured is None:
            raise HTTPException(404, {"code": "job_missing", "message": "Job missing or expired; cannot save it"})
        job, inputs = captured
        if job["kind"] != "forward" or job["status"] != "succeeded":
            raise HTTPException(409, "Only a succeeded forward job can be saved as a server snapshot")
        project = inputs["project"]
        result = job["result"]
        try:
            validate_result_for_project("forward", result, project)
            if job["input_hash"] != canonical_hash(project):
                raise ValueError("Captured job input hash mismatch")
        except (ValueError, TypeError, KeyError) as error:
            raise HTTPException(
                409, {"code": "invalid_job_output", "message": "Job input/result failed integrity validation."}
            ) from error
        provenance = {
            "source": "server_computed",
            "job_id": job["id"],
            "input_hash": job["input_hash"],
            "project_schema_version": project["schema_version"],
            "result_schema_version": result["schema_version"],
            "engine": result["metadata"]["engine"],
            "engine_version": result["metadata"]["version"],
            "adapter_version": result["metadata"]["adapter_version"],
            "submitted_at": job["created_at"],
            "completed_at": job["completed_at"],
            "canonicalization": "SHA-256; normalized Project; sorted JSON keys; compact separators; UTF-8; finite numbers",
        }
        saved = app.state.store.save(project, result, provenance=provenance)
        if view == "receipt":
            # Validate the same full server-owned pair before projecting it.
            # Any post-save failure is a 5xx: the mutation outcome must stay unknown.
            try:
                ServerSnapshot.model_validate(saved, strict=True)
                return summarize_snapshot(saved, receipt=True)
            except (ValueError, TypeError, KeyError) as error:
                raise HTTPException(500, {"code": "snapshot_receipt_unavailable", "message":
                    "Snapshot may have been saved, but its bounded receipt is unavailable. Do not start a new calculation; "
                    "repeat this idempotent save by the same job ID or inspect saved projects."}) from error
        return saved

    @app.post("/api/projects", status_code=201, response_model=SavedProject)
    def save_project(request: SaveRequest):
        return app.state.store.save(request.project.model_dump(), request.result)

    @app.get("/api/projects", response_model=list[SavedSummary] | SnapshotIndex)
    def list_projects(view: Literal["full", "index"] = "full"):
        try:
            records = app.state.store.list()
            if view == "index":
                return snapshot_index(records)
            # Preserve the existing default array, including exact entry fields.
            return [SavedSummary.model_validate(record, strict=True) for record in records]
        except SnapshotViewUnavailable:
            raise
        except (ValueError, TypeError, KeyError, RecursionError) as error:
            raise HTTPException(409, {"code": "invalid_stored_snapshot", "message":
                "Saved index metadata failed validation; no complete index is available."}) from error

    @app.get("/api/projects/{project_id}", response_model=SavedProject | SnapshotSummary | SnapshotInputs)
    def get_project(project_id: str, view: Literal["full", "summary", "inputs"] = "full"):
        try:
            # Decode errors are integrity failures too, including corrupt result
            # JSON. An inputs projection must never salvage a rejected full pair.
            project = app.state.store.get(project_id)
            if project is None:
                raise HTTPException(404, "Project not found")
            SavedProject.model_validate(project, strict=True)
            if project["provenance"]["source"] == "server_computed":
                StoredServerSnapshot.model_validate(project, strict=True)
            if view == "inputs":
                return snapshot_inputs(project)
        except SnapshotViewUnavailable:
            raise
        except (ValueError, TypeError, KeyError, RecursionError) as error:
            raise HTTPException(
                409, {"code": "invalid_stored_snapshot", "message": "Saved input/result failed integrity validation."}
            ) from error
        return summarize_snapshot(project) if view == "summary" else project

    return app


app = create_app()
