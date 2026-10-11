"""Package the accepted synthetic 2D reference without running new physics.

This prototype generator copies the complete result. Its public/shared binder
and immutable fixture hashes guard against pairing a picture with other inputs.
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

INPUT_SHA = "8dbe8260fa61ba3ec8f82ffefc5a5749ea75587b035d9f381edf66b695755294"
RESULT_SHA = "8a978f155cdbeb5a74e258253b1aae52bf8bc0f6513e934564d725d7715cd36c"
INPUT_HASH = "eeb26da3484602221944f1784b4b93ce2ed76f89b61e95d34bb68730be7bddc7"


def generate(check: bool) -> None:
    fixtures = ROOT / "backend/tests/fixtures/true-2d"
    project_bytes = (fixtures / "default-project.json").read_bytes()
    result_bytes = (fixtures / "default-result-H5.json.gz").read_bytes()
    assert hashlib.sha256(project_bytes).hexdigest() == INPUT_SHA
    assert hashlib.sha256(result_bytes).hexdigest() == RESULT_SHA
    project = json.loads(project_bytes)
    result = json.loads(gzip.decompress(result_bytes))
    _, normalized, input_hash = normalized_project_and_hash(project)
    assert input_hash == INPUT_HASH
    assert normalized == project
    validate_result_for_project("forward", result, project)
    assert result["metadata"]["convergence_checked"] is False
    bundle = (json.dumps({"project": project, "result": result}, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
    manifest = {
        "project_fixture_sha256": INPUT_SHA,
        "result_fixture_gzip_sha256": RESULT_SHA,
        "input_hash": INPUT_HASH,
        "bundle_sha256": hashlib.sha256(bundle).hexdigest(),
        "bundle_bytes": len(bundle),
        "public_shared_result_binding": "passed",
        "origin": "precomputed synthetic example; not a new job or server snapshot",
    }
    outputs = {
        ROOT / "frontend/public/prototype-2d-reference.json": bundle,
        ROOT / "frontend/src/prototype2d/default-project.json": project_bytes,
        ROOT / "frontend/src/prototype2d/reference-manifest.json": (json.dumps(manifest, indent=2) + "\n").encode(),
    }
    for path, content in outputs.items():
        if check:
            assert path.read_bytes() == content, f"Reference packaging differs: {path.name}"
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    generate(parser.parse_args().check)
