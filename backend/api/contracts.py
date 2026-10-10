"""Public HTTP envelopes. Runtime models also generate the OpenAPI contract."""

from typing import Literal

from pydantic import Field, model_validator

from rcwa_core.contracts import ForwardResult, Result
from rcwa_core.preflight import Diagnostic, EngineInfo
from rcwa_core.schemas import FitRequest, Project, StrictModel


class FitOptions(StrictModel):
    target_cd_nm: float = Field(gt=0)
    lower_cd_nm: float = Field(default=40.0, gt=0)
    upper_cd_nm: float = Field(default=360.0, gt=0)


class JobRequest(StrictModel):
    kind: Literal["forward", "fit"] = "forward"
    project: Project
    fit: FitOptions | None = None

    @model_validator(mode="after")
    def operation(self):
        if self.kind == "forward" and self.fit is not None:
            raise ValueError("Forward jobs must not include fit options")
        if self.kind == "fit":
            if self.fit is None:
                raise ValueError("Synthetic fit requires fit options")
            FitRequest(project=self.project, **self.fit.model_dump())
        return self


class ErrorDetail(StrictModel):
    code: str
    message: str
    diagnostics: list[Diagnostic] = Field(default_factory=list)


class ErrorResponse(StrictModel):
    detail: str
    error: ErrorDetail


class JobResponse(StrictModel):
    id: str
    kind: Literal["forward", "fit"]
    status: Literal["running", "succeeded", "failed", "cancelled"]
    created_at: str
    completed_at: str | None
    input_hash: str
    result: Result | None
    error: str | None
    error_code: str | None


class ValidationResponse(StrictModel):
    valid: bool
    project: Project | None
    input_hash: str | None
    diagnostics: list[Diagnostic]
    meaning: Literal["Admissible input only; numerical success and convergence are not guaranteed."] = (
        "Admissible input only; numerical success and convergence are not guaranteed."
    )


class SnapshotRequest(StrictModel):
    job_id: str = Field(min_length=1, max_length=100)


class Provenance(StrictModel):
    source: Literal["server_computed", "unverified_import"]
    job_id: str | None = None
    input_hash: str | None = None
    project_schema_version: str | None = None
    result_schema_version: str | None = None
    engine: str | None = None
    engine_version: str | None = None
    adapter_version: str | None = None
    submitted_at: str | None = None
    completed_at: str | None = None
    canonicalization: str | None = None


class SavedSummary(StrictModel):
    id: str
    name: str
    created_at: str
    updated_at: str
    provenance: Provenance


class SavedProject(SavedSummary):
    project: Project
    # Compatibility: imported legacy files have a deliberately weaker shape;
    # provenance, never result fields, distinguishes them from server results.
    result: dict | None


class ServerSnapshot(SavedSummary):
    project: Project
    result: ForwardResult


class ResourceLimits(StrictModel):
    simultaneous_jobs: int
    job_timeout_seconds: float
    retained_jobs: int
    request_bytes: int
    layers: int
    wavelength_count: int
    material_table_rows: int
    harmonics_min: int
    harmonics_max: int
    basis_size_max: int
    wavelength_nm: list[float]
    period_nm: list[float]
    thickness_nm: list[float]
    angle_deg: list[float]
    n: str
    k: str
    cd: str


class Capabilities(StrictModel):
    api_version: str
    project_schema_version: str
    result_schema_version: str
    engine: EngineInfo
    operations: list[str]
    geometry: list[str]
    polarizations: list[str]
    materials: list[str]
    observables: list[str]
    units: dict[str, str]
    limits: ResourceLimits
    persistence: dict[str, str]
    limitations: list[str]
