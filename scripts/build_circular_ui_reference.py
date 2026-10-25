#!/usr/bin/env python3
"""Package the real, immutable circular-hole H5 result without solving physics.

The frozen rectangular example remains untouched and independently importable.
The result itself never acquires a convergence certificate; sampled accuracy
is documented only in separate, source- and exact-input-bound gate evidence.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from rcwa_core.project_io import normalized_project_and_hash, validate_result_for_project  # noqa: E402

INPUT_SHA = "98e7bd338022579f086c8c82732e53356f42994ec66b37ece42f40cc5ab7eaf8"
RESULT_SHA = "1d68537aa2fb13ba346f696fec0fffa30e554ffbbb0c88a10d28d84a2e06fe0a"
INPUT_HASH = "e625443a782c0d57f5d8a5597d5410812bf8fb541249303ace49c051c66a6931"


def generate(check=False):
    fixtures = ROOT / "backend/tests/fixtures/true-2d"
    project_bytes = (fixtures / "circular-project.json").read_bytes()
    result_bytes = (fixtures / "circular-result-H5-adapter-1.4.json.gz").read_bytes()
    assert hashlib.sha256(project_bytes).hexdigest() == INPUT_SHA
    assert hashlib.sha256(result_bytes).hexdigest() == RESULT_SHA
    project, result = json.loads(project_bytes), json.loads(gzip.decompress(result_bytes))
    _, normalized, digest = normalized_project_and_hash(project)
    assert normalized == project and digest == INPUT_HASH
    validate_result_for_project("forward", result, project)
    assert result["metadata"]["convergence_checked"] is False
    assert result["metadata"]["adapter_version"] == "1.4.0"
    bundle = (json.dumps({"project": project, "result": result}, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
    manifest = {
        "project_fixture_sha256": INPUT_SHA,
        "result_fixture_gzip_sha256": RESULT_SHA,
        "input_hash": INPUT_HASH,
        "bundle_sha256": hashlib.sha256(bundle).hexdigest(),
        "bundle_bytes": len(bundle),
        "public_shared_result_binding": "passed",
        "origin": "precomputed synthetic circular-hole example; not a new job or server snapshot",
    }
    for path, content in {
        ROOT / "frontend/public/reference-circular.json": bundle,
        ROOT / "frontend/src/core/fixtures/default-project-circular.json": project_bytes,
        ROOT / "frontend/src/core/fixtures/reference-circular-manifest.json": (json.dumps(manifest, indent=2) + "\n").encode(),
    }.items():
        if check:
            assert path.read_bytes() == content, f"Circle reference packaging differs: {path.name}"
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    generate(parser.parse_args().check)
