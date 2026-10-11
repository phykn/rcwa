"""Canonical bytes for already normalized project JSON, shared by every boundary."""

import hashlib
import json


def canonical_hash(project: dict) -> str:
    """Preserve historical UTF-8, Unicode and signed-zero serialization exactly."""
    encoded = json.dumps(project, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
