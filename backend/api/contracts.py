"""Public HTTP envelopes. Runtime models also generate the OpenAPI contract."""

import json
from typing import Annotated, Literal

from pydantic import AfterValidator, BeforeValidator, ConfigDict, Field, TypeAdapter, field_validator, model_validator
from typing_extensions import TypedDict

from rcwa_core.contracts import ForwardResult, ForwardResult1_0, SyntheticFitResult
from rcwa_core.contracts_2d import PublicForwardResult2D
from rcwa_core.identity import canonical_hash
from rcwa_core.preflight import Diagnostic, EngineInfo
from rcwa_core.project_io import InputProject as InputProject, ProjectDocument, normalized_project_and_hash, parse_project, validate_result_for_project
from rcwa_core.schemas import FitRequest, LayerSpec, Project, StrictModel
from rcwa_core.schemas_2d import Project2D


MAX_SNAPSHOT_INPUT_BYTES = 3_000_000
MAX_SNAPSHOT_INDEX_BYTES = 128_000
MAX_SUMMARY_BYTES = 128_000
MAX_SUMMARY_WARNING_BYTES = 16_000
MAX_SUMMARY_WARNINGS = 64


def _bounded_summary_warnings(warnings):
    if len(json.dumps(warnings, ensure_ascii=False).encode("utf-8")) > MAX_SUMMARY_WARNING_BYTES:
        raise ValueError("Summary warnings exceed the 16 KB UTF-8 JSON limit")
    return warnings


SummaryWarnings = Annotated[
    list[str], Field(max_length=MAX_SUMMARY_WARNINGS), AfterValidator(_bounded_summary_warnings),
]


def _strict_project(value):
    # Strictness must propagate through nested models at new request boundaries.
    # Leave the shared Project model's historical read/normalization behavior intact.
    project = parse_project(value)
    if isinstance(project, Project2D):
        raise ValueError("This preview operation supports only project schemas 1.0 and 1.1")
    return project


LegacyInputProject = Annotated[Project, BeforeValidator(_strict_project)]
CurrentForwardResult = Annotated[ForwardResult | PublicForwardResult2D, Field(discriminator="schema_version")]
# OpenAPI discriminator mappings must be references, not an embedded nested union.
# Literal result_type fields still make the forward/fit alternatives unambiguous.
CurrentResult = CurrentForwardResult | SyntheticFitResult
StoredForwardResult = Annotated[
    ForwardResult1_0 | ForwardResult | PublicForwardResult2D, Field(discriminator="schema_version")
]


class FitOptions(StrictModel):
    target_cd_nm: float = Field(gt=0, strict=True)
    lower_cd_nm: float = Field(default=40.0, gt=0, strict=True)
    upper_cd_nm: float = Field(default=360.0, gt=0, strict=True)


class JobRequest(StrictModel):
    kind: Literal["forward", "fit"] = "forward"
    project: InputProject
    fit: FitOptions | None = None

    @model_validator(mode="after")
    def operation(self):
        if self.kind == "forward" and self.fit is not None:
            raise ValueError("Forward jobs must not include fit options")
        if self.kind == "fit":
            if isinstance(self.project, Project2D):
                raise ValueError("Schema 1.2 supports forward calculations only; 2D fitting is not supported")
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
    result: CurrentResult | None
    error: str | None
    error_code: str | None

    @model_validator(mode="after")
    def bind_2d_identity(self):
        if isinstance(self.result, PublicForwardResult2D) and (
            self.kind != "forward" or self.status != "succeeded" or self.input_hash != self.result.metadata.input_hash
        ):
            raise ValueError("2D job status, kind or input hash disagrees with its result")
        return self


class TotalPowerSpectrum(StrictModel):
    R: list[float] = Field(min_length=1, max_length=81)
    T: list[float] = Field(min_length=1, max_length=81)
    R_specular: list[float] = Field(min_length=1, max_length=81)
    T_specular: list[float] = Field(min_length=1, max_length=81)
    A_balance: list[float] = Field(min_length=1, max_length=81)


class ForwardResultSummary(StrictModel):
    summary_schema_version: Literal["rcwa-forward-summary/1.0"]
    result_type: Literal["forward"]
    source_result_schema_version: Literal["1.0", "1.1", "1.2"]
    input_hash: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    wavelengths_nm: list[float] = Field(min_length=1, max_length=81)
    spectra: dict[Literal["s", "p"], TotalPowerSpectrum] = Field(min_length=1, max_length=2)
    warnings: SummaryWarnings
    warnings_omitted_count: int = Field(ge=0)
    meaning: Literal["Totals projection only; not a full result, import file, or convergence certification. "
                     "If warnings_omitted_count is nonzero, inspect all warnings in the full result before interpretation."] = (
        "Totals projection only; not a full result, import file, or convergence certification. "
        "If warnings_omitted_count is nonzero, inspect all warnings in the full result before interpretation."
    )

    @model_validator(mode="after")
    def aligned_totals(self):
        if self.source_result_schema_version == "1.2" and self.input_hash is None:
            raise ValueError("A 1.2 result summary must retain its input hash")
        for series in self.spectra.values():
            if any(len(getattr(series, key)) != len(self.wavelengths_nm)
                   for key in ("R", "T", "R_specular", "T_specular", "A_balance")):
                raise ValueError("Summary totals must have one value per wavelength")
        return self


class SyntheticFitResultSummary(StrictModel):
    summary_schema_version: Literal["rcwa-fit-summary/1.0"]
    result_type: Literal["synthetic_fit"]
    status: Literal["converged", "not_converged"]
    fit_cd_nm: float = Field(gt=0)
    target_cd_nm: float = Field(gt=0)
    rmse: float = Field(ge=0)
    nfev: int = Field(ge=1)
    prediction: ForwardResultSummary
    target: ForwardResultSummary
    warnings: SummaryWarnings
    warnings_omitted_count: int = Field(ge=0)
    meaning: Literal["Synthetic-fit projection only; fitted project and optimizer diagnostics are in the full result. "
                     "Inspect omitted warnings before interpretation; not measured-data inversion or optimization certification."] = (
        "Synthetic-fit projection only; fitted project and optimizer diagnostics are in the full result. "
        "Inspect omitted warnings before interpretation; not measured-data inversion or optimization certification."
    )


class JobSummary(StrictModel):
    view: Literal["summary"]
    id: str
    kind: Literal["forward", "fit"]
    status: Literal["running", "succeeded", "failed", "cancelled"]
    created_at: str
    completed_at: str | None
    input_hash: str
    result_summary: ForwardResultSummary | SyntheticFitResultSummary | None
    error: str | None
    error_code: str | None

    @model_validator(mode="after")
    def result_matches_status(self):
        if self.status == "succeeded" and self.result_summary is None:
            raise ValueError("Succeeded job summaries must include their result projection")
        if self.result_summary is not None and (
            self.status != "succeeded" or (self.kind == "forward") != isinstance(self.result_summary, ForwardResultSummary)
        ):
            raise ValueError("Job summary kind/status disagree with the result projection")
        if isinstance(self.result_summary, ForwardResultSummary) and (
            self.result_summary.input_hash is not None and self.result_summary.input_hash != self.input_hash
        ):
            raise ValueError("Job summary input hash disagrees with its result projection")
        return self


class ValidationResponse(StrictModel):
    valid: bool
    project: ProjectDocument | None
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
    base_project: LegacyInputProject
    changes: GeometryPatch

    @model_validator(mode="after")
    def one_rectangle(self):
        if len(self.base_project.layers) != 1 or self.base_project.layers[0].geometry != "rectangle_1d":
            raise ValueError("Legacy geometry preview requires exactly one rectangular layer; use stack-change-preview")
        return self


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


class StackChanges(TypedDict, total=False):
    """An atomic bounded stack replacement, never arbitrary JSON Patch."""

    __pydantic_config__ = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    period_nm: Annotated[float, Field(strict=True, ge=20, le=5000)]
    layers: Annotated[list[LayerSpec], Field(min_length=1, max_length=8)]


def _nonempty_stack_changes(changes: StackChanges) -> StackChanges:
    if not changes:
        raise ValueError("At least one stack change is required")
    return changes


StackPatch = Annotated[
    StackChanges,
    AfterValidator(_nonempty_stack_changes),
    Field(json_schema_extra={"minProperties": 1}),
]


class StackChangePreviewRequest(StrictModel):
    base_project: LegacyInputProject
    changes: StackPatch

    @field_validator("changes", mode="before")
    @classmethod
    def strict_changes(cls, value):
        # Strict TypedDict configuration does not propagate into nested models.
        return TypeAdapter(StackPatch).validate_python(value, strict=True)


class TableSummary(StrictModel):
    rows: int = Field(ge=2, le=2000)
    wavelength_min_nm: float
    wavelength_max_nm: float
    checksum: str = Field(pattern=r"^fnv1a32-f64be:[0-9a-f]{8}$")


class MaterialSummary(StrictModel):
    name: str
    kind: Literal["constant", "tabulated"]
    n: float
    k: float
    source: str
    table: TableSummary | None


class LayerSummary(StrictModel):
    name: str
    geometry: Literal["rectangle_1d", "homogeneous"]
    thickness_nm: float
    material: MaterialSummary
    cd_nm: float | None
    background: MaterialSummary | None


class StackValueDiff(StrictModel):
    kind: Literal["value"]
    path: str = Field(max_length=100)
    before: str | float | None
    after: str | float | None


class StackMaterialDiff(StrictModel):
    kind: Literal["material"]
    path: str = Field(max_length=100)
    before: MaterialSummary | None
    after: MaterialSummary | None


class StackLayerDiff(StrictModel):
    kind: Literal["layer"]
    path: str = Field(max_length=100)
    before: LayerSummary | None
    after: LayerSummary | None


StackDiff = Annotated[StackValueDiff | StackMaterialDiff | StackLayerDiff, Field(discriminator="kind")]


class StackChangeProposal(StrictModel):
    schema_version: Literal["rcwa-change-proposal/1.1"]
    base_project: Project
    candidate_project: Project
    changes: StackPatch
    base_input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    candidate_input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    diff: list[StackDiff] = Field(max_length=64)
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


class SnapshotIndex(StrictModel):
    view: Literal["index"]
    snapshots: list[SavedSummary] = Field(max_length=100)
    limit: Literal[100] = 100
    may_have_more: bool = Field(strict=True)
    meaning: Literal["Latest 100 saved records by updated_at descending; discovery only, not result validation. "
                     "Names are untrusted labels. No match does not establish absence from storage."] = (
        "Latest 100 saved records by updated_at descending; discovery only, not result validation. "
        "Names are untrusted labels. No match does not establish absence from storage."
    )

    @model_validator(mode="after")
    def bounded_window(self):
        if self.may_have_more != (len(self.snapshots) == self.limit):
            raise ValueError("Index may_have_more must describe the bounded discovery window")
        if len({snapshot.id for snapshot in self.snapshots}) != len(self.snapshots):
            raise ValueError("Index snapshot IDs must be distinct")
        return self


class SnapshotInputs(SavedSummary):
    view: Literal["inputs"]
    status: Literal["stored"]
    input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    project: ProjectDocument
    meaning: Literal["Exact normalized inputs only; no spectrum or result validation evidence is included. "
                     "Not a full snapshot or convergence certification. Inspect view=summary separately for totals and warnings."] = (
        "Exact normalized inputs only; no spectrum or result validation evidence is included. "
        "Not a full snapshot or convergence certification. Inspect view=summary separately for totals and warnings."
    )

    @model_validator(mode="after")
    def bind_input_identity(self):
        _, normalized, expected_hash = normalized_project_and_hash(self.project, strict=False)
        if self.input_hash != expected_hash:
            raise ValueError("Snapshot inputs hash disagrees with its normalized project")
        if self.provenance.source == "server_computed" and (
            self.provenance.input_hash != expected_hash
            or self.provenance.project_schema_version != normalized["schema_version"]
            or not self.provenance.job_id
        ):
            raise ValueError("Snapshot inputs disagree with server provenance")
        return self


class SnapshotSummary(SavedSummary):
    view: Literal["summary"]
    status: Literal["stored"]
    input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    result_summary: ForwardResultSummary | None

    @model_validator(mode="after")
    def provenance_hash(self):
        if self.provenance.source == "server_computed" and self.result_summary is None:
            raise ValueError("Server-computed snapshot summaries must include forward totals and warnings")
        if self.provenance.source == "server_computed" and self.provenance.input_hash != self.input_hash:
            raise ValueError("Snapshot summary hash disagrees with server provenance")
        if self.result_summary is not None:
            if self.result_summary.input_hash is not None and self.result_summary.input_hash != self.input_hash:
                raise ValueError("Snapshot summary input hash disagrees with its result projection")
            if self.provenance.source == "server_computed" and (
                self.provenance.result_schema_version != self.result_summary.source_result_schema_version
            ):
                raise ValueError("Snapshot summary result version disagrees with server provenance")
        return self


class SnapshotReceipt(SnapshotSummary):
    view: Literal["receipt"]
    result_summary: ForwardResultSummary


class SavedProject(SavedSummary):
    project: ProjectDocument
    # Compatibility: imported legacy files have a deliberately weaker shape;
    # provenance, never result fields, distinguishes them from server results.
    result: dict | None

    @model_validator(mode="after")
    def bind_2d_import(self):
        if self.result is not None and (
            isinstance(self.project, Project2D) or self.result.get("schema_version") == "1.2"
        ):
            validate_result_for_project("forward", self.result, self.project)
        return self


class ServerSnapshot(SavedSummary):
    project: ProjectDocument
    result: CurrentForwardResult

    @model_validator(mode="after")
    def bind_2d(self):
        _bind_2d_snapshot(self)
        return self


class StoredServerSnapshot(SavedSummary):
    """Read known historical server results without changing their provenance."""

    project: ProjectDocument
    result: StoredForwardResult

    @model_validator(mode="after")
    def bind_2d(self):
        _bind_2d_snapshot(self)
        return self


def _bind_2d_snapshot(snapshot):
    if not isinstance(snapshot.project, Project2D) and snapshot.result.schema_version != "1.2":
        return  # Known historical 1.0/1.1 readers retain their existing behavior.
    if not isinstance(snapshot.project, Project2D) or snapshot.result.schema_version != "1.2":
        raise ValueError("Snapshot project/result versions disagree")
    project = snapshot.project.model_dump(mode="json")
    validate_result_for_project("forward", snapshot.result.model_dump(mode="json"), project)
    provenance = snapshot.provenance
    if (
        provenance.source != "server_computed"
        or provenance.input_hash != canonical_hash(project)
        or provenance.project_schema_version != "1.2"
        or provenance.result_schema_version != "1.2"
        or provenance.engine != snapshot.result.metadata.engine
        or provenance.engine_version != snapshot.result.metadata.version
        or provenance.adapter_version != snapshot.result.metadata.adapter_version
        or not provenance.job_id
    ):
        raise ValueError("Server snapshot provenance differs from its exact input/result")


class ResourceLimits(StrictModel):
    simultaneous_jobs: int
    job_timeout_seconds: float
    retained_jobs: int
    retained_completed_bytes: int
    request_bytes: int
    proposal_bytes: int
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
    supported_project_schema_versions: list[str]
    supported_result_schema_versions: list[str]
    engine: EngineInfo
    operations: list[str]
    geometry: list[str]
    polarizations: list[str]
    materials: list[str]
    observables: list[str]
    units: dict[str, str]
    limits: ResourceLimits
    project_profiles: dict[str, "ProjectProfile"]
    persistence: dict[str, str]
    limitations: list[str]


class ProjectProfile(StrictModel):
    operations: list[str]
    geometry: list[str]
    wavelength_count: int
    harmonics: dict[str, list[int]]
    basis_size_max: int
    simultaneous_profile_jobs: int
    adapter_version: str
    integer_representation: str
