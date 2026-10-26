"""Canonical bytes for already normalized project JSON, shared by every boundary."""

import hashlib
import json


def canonical_json(value) -> str:
    """Preserve historical UTF-8, Unicode and signed-zero serialization exactly."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def canonical_hash(project: dict) -> str:
    return hashlib.sha256(canonical_json(project).encode("utf-8")).hexdigest()


def same_canonical(left, right) -> bool:
    """Equal as canonical JSON, so a diff is empty exactly when the hash is unchanged (-0.0 != 0.0)."""
    def encode(value):
        return canonical_json(value.model_dump(mode="json") if hasattr(value, "model_dump") else value)

    return encode(left) == encode(right)
