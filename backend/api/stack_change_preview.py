"""Pure, bounded, atomic stack proposals with concise deterministic summaries."""

import json
import struct
from copy import deepcopy

from api.contracts import (
    LayerSummary, MaterialSummary, StackChangePreviewRequest, StackChangeProposal,
    StackDiff, StackLayerDiff, StackMaterialDiff, StackValueDiff, TableSummary,
)
from api.storage import canonical_hash
from rcwa_core.preflight import preflight_project
from rcwa_core.schemas import Material, Project

MAX_PROPOSAL_BYTES = 8_000_000


class ProposalTooLarge(ValueError):
    pass


def bounded_proposal(proposal):
    """Use the actual compact UTF-8 HTTP representation, not character count."""
    encoded = json.dumps(proposal.model_dump(mode="json"), ensure_ascii=False,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encoded) > MAX_PROPOSAL_BYTES:
        raise ProposalTooLarge("Proposal response exceeds the 8 MB limit; reduce material table sizes")
    return proposal


def material_summary(material: Material) -> MaterialSummary:
    table = None
    if material.kind == "tabulated":
        # Informational change detector, not a signature or trust guarantee.
        # IEEE-754 bytes avoid Python/JavaScript JSON float spelling differences.
        checksum = 2166136261
        for row in zip(material.wavelengths_nm, material.n_values, material.k_values):
            for byte in struct.pack(">ddd", *row):
                checksum = ((checksum ^ byte) * 16777619) & 0xFFFFFFFF
        table = TableSummary(
            rows=len(material.wavelengths_nm), wavelength_min_nm=material.wavelengths_nm[0],
            wavelength_max_nm=material.wavelengths_nm[-1], checksum=f"fnv1a32-f64be:{checksum:08x}",
        )
    return MaterialSummary(name=material.name, kind=material.kind, n=material.n, k=material.k,
                           source=material.source, table=table)


def layer_summary(layer) -> LayerSummary:
    rectangle = layer.geometry == "rectangle_1d"
    return LayerSummary(
        name=layer.name, geometry=layer.geometry, thickness_nm=layer.thickness_nm,
        cd_nm=layer.cd_nm if rectangle else None, material=material_summary(layer.material),
        background=material_summary(layer.background) if rectangle else None,
    )


def stack_diff(base: Project, candidate: Project) -> list[StackDiff]:
    differences = []
    for field in ("schema_version", "period_nm"):
        before, after = getattr(base, field), getattr(candidate, field)
        if before != after:
            differences.append(StackValueDiff(kind="value", path=field, before=before, after=after))
    for index in range(max(len(base.layers), len(candidate.layers))):
        before = base.layers[index] if index < len(base.layers) else None
        after = candidate.layers[index] if index < len(candidate.layers) else None
        path = f"layers[{index}]"
        if before is None or after is None or before.geometry != after.geometry:
            differences.append(StackLayerDiff(
                kind="layer", path=path, before=layer_summary(before) if before is not None else None,
                after=layer_summary(after) if after is not None else None,
            ))
            continue
        for field in ("name", "thickness_nm", "cd_nm", "material", "background"):
            if before.geometry == "homogeneous" and field in {"cd_nm", "background"}:
                continue
            old, new = getattr(before, field), getattr(after, field)
            if old == new:
                continue
            if field in {"material", "background"}:
                differences.append(StackMaterialDiff(
                    kind="material", path=f"{path}.{field}", before=material_summary(old), after=material_summary(new),
                ))
            else:
                differences.append(StackValueDiff(kind="value", path=f"{path}.{field}", before=old, after=new))
    return differences


def stack_candidate_project(base: Project, changes: dict) -> Project:
    """Every explicit stack proposal targets 1.1; promotion is visible in diff."""
    candidate = base.model_dump()
    candidate["schema_version"] = "1.1"
    candidate.update(deepcopy(changes))
    return Project.model_validate(candidate)


def preview_stack_changes(request: StackChangePreviewRequest) -> StackChangeProposal:
    request = StackChangePreviewRequest.model_validate(request.model_dump(), strict=True)
    base = request.base_project
    changes = request.model_dump()["changes"]
    candidate = stack_candidate_project(base, changes)
    diagnostics = preflight_project(candidate)
    return bounded_proposal(StackChangeProposal(
        schema_version="rcwa-change-proposal/1.1", base_project=base, candidate_project=candidate,
        changes=changes, base_input_hash=canonical_hash(base.model_dump()),
        candidate_input_hash=canonical_hash(candidate.model_dump()), diff=stack_diff(base, candidate),
        diagnostics=diagnostics, valid=not any(item.severity == "error" for item in diagnostics),
    ))


def validate_stack_proposal_binding(payload: dict, request: StackChangePreviewRequest) -> None:
    # Compare original JSON to require every canonical field, not filled defaults.
    if payload != preview_stack_changes(request).model_dump():
        raise ValueError("API proposal does not match the requested normalized base and stack changes")
