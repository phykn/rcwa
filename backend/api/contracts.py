"""Public HTTP envelopes. Runtime models also generate the OpenAPI contract."""

from typing import Annotated, Literal

from pydantic import AfterValidator, ConfigDict, Field, model_validator
from typing_extensions import TypedDict

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


class GeometryChanges(TypedDict, total=False):
    """Only explicitly supplied geometry numbers; missing is distinct from null."""

    __pydantic_config__ = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    period_nm: Annotated[float, Field(strict=True, ge=20, le=5000)]
    cd_nm: Annotated[float, Field(strict=True, ge=0, le=5000)]
    thickness_nm: Annotated[float, Field(strict=True, ge=0, le=2000)]


def _nonempty_geometry_changes(changes: GeometryChanges) -> GeometryChanges:
    if not changes:
        raise ValueError("At least one geometry change is required")
    return changes


GeometryPatch = Annotated[
    GeometryChanges,
    AfterValidator(_nonempty_geometry_changes),
    Field(json_schema_extra={"minProperties": 1}),
]
GeometryField = Literal["period_nm", "cd_nm", "thickness_nm"]


class ChangePreviewRequest(StrictModel):
    base_project: Project
    changes: GeometryPatch


class GeometryDiff(StrictModel):
    field: GeometryField
    before: float = Field(strict=True)
    after: float = Field(strict=True)


class ChangeProposal(StrictModel):
    schema_version: Literal["rcwa-change-proposal/1.0"]
    base_project: Project
    candidate_project: Project
    changes: GeometryPatch
    base_input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    candidate_input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    diff: list[GeometryDiff] = Field(max_length=3)
    diagnostics: list[Diagnostic]
    valid: bool = Field(strict=True)


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
