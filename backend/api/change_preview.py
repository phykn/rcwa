"""Pure bounded geometry proposals. No engine inspection, jobs, storage or apply."""

from api.contracts import ChangePreviewRequest, ChangeProposal, GeometryChanges, GeometryDiff
from api.storage import canonical_hash
from rcwa_core.preflight import preflight_project
from rcwa_core.schemas import Project

GEOMETRY_FIELDS = ("period_nm", "cd_nm", "thickness_nm")


def candidate_project(base: Project, changes: GeometryChanges) -> Project:
    """Apply the complete patch before cross-field validation, never field-by-field."""
    candidate = base.model_dump()
    for field in GEOMETRY_FIELDS:
        if field in changes:
            target = candidate if field == "period_nm" else candidate["layers"][0]
            target[field] = changes[field]
    return Project.model_validate(candidate)


def preview_changes(request: ChangePreviewRequest) -> ChangeProposal:
    # Revalidate even model instances to reject any in-memory mutation.
    request = ChangePreviewRequest.model_validate(request.model_dump())
    base = request.base_project
    candidate = candidate_project(base, request.changes)
    diff = []
    for field in GEOMETRY_FIELDS:
        before = getattr(base if field == "period_nm" else base.layers[0], field)
        after = getattr(candidate if field == "period_nm" else candidate.layers[0], field)
        if before != after:
            diff.append(GeometryDiff(field=field, before=before, after=after))
    diagnostics = preflight_project(candidate)
    return ChangeProposal(
        schema_version="rcwa-change-proposal/1.0",
        base_project=base,
        candidate_project=candidate,
        changes=request.changes,
        base_input_hash=canonical_hash(base.model_dump()),
        candidate_input_hash=canonical_hash(candidate.model_dump()),
        diff=diff,
        diagnostics=diagnostics,
        valid=not any(item.severity == "error" for item in diagnostics),
    )


def validate_proposal_binding(payload: dict, request: ChangePreviewRequest) -> None:
    """Reject a schema-valid response for unrelated inputs or incorrect semantics."""
    expected = preview_changes(request)
    # Compare the original JSON, not a model with missing Project defaults filled
    # in: a successful response must actually contain both canonical Projects.
    if payload != expected.model_dump():
        raise ValueError("API proposal does not match the requested normalized base and geometry changes")
