import math
from copy import deepcopy
from typing import Annotated, Literal

from pydantic import AfterValidator, ConfigDict, Field, field_validator, model_validator
from typing_extensions import NotRequired, TypedDict

from api.stack_change_preview import bounded_proposal
from rcwa_core.identity import canonical_hash, same_canonical
from rcwa_core.preflight import Diagnostic
from rcwa_core.preflight_2d import preflight_2d
from rcwa_core.project_io import parse_project
from rcwa_core.schemas import StrictModel
from rcwa_core.schemas_2d import Project2D

Pitch = Annotated[float, Field(strict=True, ge=20, le=5000)]
Width = Annotated[float, Field(strict=True, ge=0, le=5000)]
Thickness = Annotated[float, Field(strict=True, ge=0, le=2000)]
Index = Annotated[int, Field(strict=True, ge=0, le=7)]


class UniformDimensions(TypedDict):
    __pydantic_config__ = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    index: Index
    geometry: Literal["homogeneous"]
    thickness_nm: NotRequired[Thickness]


class GratingDimensions(TypedDict):
    __pydantic_config__ = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    index: Index
    geometry: Literal["rectangle_1d"]
    thickness_nm: NotRequired[Thickness]
    cd_nm: NotRequired[Width]


class RectangleDimensions(TypedDict):
    __pydantic_config__ = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    index: Index
    geometry: Literal["rectangle_2d"]
    thickness_nm: NotRequired[Thickness]
    cd_x_nm: NotRequired[Width]
    cd_y_nm: NotRequired[Width]


class CircleDimensions(TypedDict):
    __pydantic_config__ = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    index: Index
    geometry: Literal["circular_hole_2d"]
    thickness_nm: NotRequired[Thickness]
    diameter_nm: NotRequired[Width]


LayerDimensions = Annotated[
    UniformDimensions | GratingDimensions | RectangleDimensions | CircleDimensions,
    Field(discriminator="geometry", json_schema_extra={"minProperties": 3}),
]


class DimensionChanges(TypedDict, total=False):
    __pydantic_config__ = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    period_nm: Pitch
    period_y_nm: Pitch
    layers: Annotated[list[LayerDimensions], Field(min_length=1, max_length=8)]


def _nonempty_dimensions(changes: DimensionChanges) -> DimensionChanges:
    if not changes:
        raise ValueError("At least one 2D dimension change is required")
    indexes = set()
    for layer in changes.get("layers", []):
        if len(layer) <= 2:
            raise ValueError("Each indexed layer patch requires at least one dimension")
        if layer["index"] in indexes:
            raise ValueError("Layer patch indexes must be unique")
        indexes.add(layer["index"])
    return changes


DimensionPatch = Annotated[
    DimensionChanges, AfterValidator(_nonempty_dimensions), Field(json_schema_extra={"minProperties": 1}),
]


class DimensionChangePreviewRequest(StrictModel):
    base_project: Project2D
    changes: DimensionPatch

    @field_validator("base_project", mode="before")
    @classmethod
    def explicit_strict_base(cls, value):
        project = parse_project(value)
        if not isinstance(project, Project2D):
            raise ValueError("2D dimension preview requires explicit schema 1.2")
        return project

    @model_validator(mode="after")
    def existing_shapes(self):
        for patch in self.changes.get("layers", []):
            index = patch["index"]
            if index >= len(self.base_project.layers):
                raise ValueError("Layer patch index does not exist in the base project")
            if patch["geometry"] != self.base_project.layers[index].geometry:
                raise ValueError("Layer patch geometry must match the existing layer")
        return self


class DimensionDiff(StrictModel):
    path: str = Field(pattern=r"^(period_nm|period_y_nm|layers\[[0-7]\]\.(thickness_nm|cd_nm|cd_x_nm|cd_y_nm|diameter_nm))$")
    before: float = Field(strict=True)
    after: float = Field(strict=True)


class DimensionChangeProposal(StrictModel):
    schema_version: Literal["rcwa-change-proposal/1.2"]
    base_project: Project2D
    candidate_project: Project2D
    changes: DimensionPatch
    base_input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    candidate_input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    diff: list[DimensionDiff] = Field(max_length=26)
    diagnostics: list[Diagnostic] = Field(max_length=62)
    valid: bool = Field(strict=True)


def dimension_candidate(base: Project2D, changes: DimensionChanges) -> Project2D:
    """Apply all dimensions before validation; never repair dependent widths."""
    candidate = deepcopy(base.model_dump())
    for field in ("period_nm", "period_y_nm"):
        if field in changes:
            candidate[field] = changes[field]
    for patch in changes.get("layers", []):
        for field, value in patch.items():
            if field not in {"index", "geometry"}:
                candidate["layers"][patch["index"]][field] = value
    return Project2D.model_validate(candidate, strict=True)


def same_dimension(left: float, right: float) -> bool:
    return left == right and (left != 0 or math.copysign(1, left) == math.copysign(1, right))


def dimension_diff(base: Project2D, candidate: Project2D) -> list[DimensionDiff]:
    diff = []
    for field in ("period_nm", "period_y_nm"):
        before, after = getattr(base, field), getattr(candidate, field)
        if not same_dimension(before, after):
            diff.append(DimensionDiff(path=field, before=before, after=after))
    for index, (before, after) in enumerate(zip(base.layers, candidate.layers)):
        for field in ("thickness_nm", "cd_nm", "cd_x_nm", "cd_y_nm", "diameter_nm"):
            if hasattr(before, field) and not same_dimension(getattr(before, field), getattr(after, field)):
                diff.append(DimensionDiff(path=f"layers[{index}].{field}",
                                          before=getattr(before, field), after=getattr(after, field)))
    return diff


def preview_2d_changes(request: DimensionChangePreviewRequest) -> DimensionChangeProposal:
    request = DimensionChangePreviewRequest.model_validate(request.model_dump(), strict=True)
    base = request.base_project
    candidate = dimension_candidate(base, request.changes)
    diagnostics = preflight_2d(candidate)
    return bounded_proposal(DimensionChangeProposal(
        schema_version="rcwa-change-proposal/1.2", base_project=base, candidate_project=candidate,
        changes=request.changes, base_input_hash=canonical_hash(base.model_dump()),
        candidate_input_hash=canonical_hash(candidate.model_dump()), diff=dimension_diff(base, candidate),
        diagnostics=diagnostics, valid=not any(item.severity == "error" for item in diagnostics),
    ))


def validate_2d_proposal_binding(payload: dict, request: DimensionChangePreviewRequest) -> None:
    # Compare RAW payload, including every canonical field and the exact supplied
    # patch. Python == would conceal signed-zero tampering. This is consistency,
    # not authenticated provenance or a prediction of numerical convergence.
    if not same_canonical(payload, preview_2d_changes(request).model_dump()):
        raise ValueError("API proposal does not match the requested normalized base and 2D dimension changes")
