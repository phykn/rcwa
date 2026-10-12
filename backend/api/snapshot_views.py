"""Read-only discovery and exact input projections, with independent byte limits.

The caller validates the complete stored record before projecting inputs. An index
only discovers records; it deliberately does not read or validate stored results.
Never trim names, tables or provenance to fit either envelope.
"""

import json

from .contracts import MAX_SNAPSHOT_INDEX_BYTES, MAX_SNAPSHOT_INPUT_BYTES, SnapshotIndex, SnapshotInputs
from rcwa_core.project_io import normalized_project_and_hash


class SnapshotViewUnavailable(ValueError):
    """A complete, valid discovery/input envelope cannot fit its advertised bound."""


def bounded_snapshot_view(model, limit):
    payload = model.model_dump(mode="json")
    try:
        size = len(json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))
    except (ValueError, UnicodeError, RecursionError) as error:
        raise SnapshotViewUnavailable("Saved metadata is not valid finite UTF-8 JSON") from error
    if size > limit:
        raise SnapshotViewUnavailable(
            f"Saved {payload['view']} view exceeds its {limit} byte UTF-8 JSON limit; "
            "no fields were shortened. Use the existing full HTTP route."
        )
    return payload


def snapshot_index(records):
    return bounded_snapshot_view(SnapshotIndex.model_validate({
        "view": "index", "snapshots": records, "limit": 100, "may_have_more": len(records) == 100,
    }, strict=True), MAX_SNAPSHOT_INDEX_BYTES)


def snapshot_inputs(saved):
    _, normalized, input_hash = normalized_project_and_hash(saved["project"], strict=False)
    return bounded_snapshot_view(SnapshotInputs.model_validate({
        **{key: value for key, value in saved.items() if key not in {"project", "result"}},
        "view": "inputs", "status": "stored", "input_hash": input_hash, "project": normalized,
    }, strict=True), MAX_SNAPSHOT_INPUT_BYTES)
