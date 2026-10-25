"""Canonical bytes for already normalized project JSON, shared by every boundary."""

import hashlib
import json


def canonical_hash(project: dict) -> str:
    """Preserve historical UTF-8, Unicode and signed-zero serialization exactly."""
    encoded = json.dumps(project, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def same_canonical(left, right) -> bool:
    """Equal as canonical JSON, so a diff is empty exactly when the hash is unchanged (-0.0 != 0.0)."""
    def encode(value):
        value = value.model_dump(mode="json") if hasattr(value, "model_dump") else value
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)

    return encode(left) == encode(right)
