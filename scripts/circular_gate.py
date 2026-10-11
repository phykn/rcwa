#!/usr/bin/env python3
"""Fresh circle-only exact-input gate: harmonic and independent spatial refinement.

Production uses deterministic midpoint strips and directional inverse rules.
S4 independently constructs analytical circles. Power residuals and summed
added-order tails are all checked; flux balance alone is never acceptance.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from rcwa_core.contracts_2d import validate_result_2d  # noqa: E402
from rcwa_core.schemas_2d import Project2D  # noqa: E402
from rcwa_core.solver_2d import forward_2d  # noqa: E402
from true_2d.convergence import compare_samples, passes, sample_from_result, REFINEMENT_TOLERANCE  # noqa: E402
from true_2d_gate import run_gate, source_hashes  # noqa: E402
from true_2d_reference import build_driver  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=ROOT / "backend/tests/fixtures/true-2d/circular-project.json")
    parser.add_argument("--s4-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reuse-verified-library", action="store_true")
    args = parser.parse_args()
    project = Project2D.model_validate_json(args.project.read_text())
    if not any(layer.geometry == "circular_hole_2d" for layer in project.layers):
        raise ValueError("This dedicated gate requires circular geometry")
    before = source_hashes()
    start = perf_counter()
    binary, provenance = build_driver(args.s4_source, reuse_verified_library=args.reuse_verified_library)
    harmonic = run_gate(project, binary)
    spatial = [harmonic["production"][0]]
    for strips in (128, 256):
        computed = forward_2d(project, reference_circle_strips=strips)
        validate_result_2d(computed, project, reference_circle_strips=strips)
        spatial.append(computed)
        print(f"Completed fixed-H5 spatial refinement with {strips} circle strips", flush=True)
    comparisons = {}
    for a, b in ((0, 1), (1, 2), (0, 2)):
        rows = []
        for wi, wavelength in enumerate(project.illumination.wavelengths_nm):
            comparison = compare_samples(sample_from_result(spatial[a], wi), sample_from_result(spatial[b], wi))
            rows.append({"wavelength_nm": wavelength, "passed": passes(comparison, REFINEMENT_TOLERANCE), **comparison})
        comparisons[f"strips_{(64,128,256)[a]}_to_{(64,128,256)[b]}"] = {
            "tolerance": REFINEMENT_TOLERANCE,
            "passed": all(row["passed"] for row in rows),
            "rows": rows,
        }
    if before != source_hashes():
        raise RuntimeError("Production source changed during circular gate")
    report = {
        "scope": "Only the exact synthetic circle input and sampled wavelengths; not metrology or an optical error bound for edits",
        "reference_provenance": provenance,
        "harmonic_gate": harmonic,
        "spatial_gate": {"basis": [project.solver.harmonics_x, project.solver.harmonics_y],
                         "strips": [64, 128, 256], "production": spatial, "comparisons": comparisons,
                         "passed": all(row["passed"] for row in comparisons.values())},
        "passed": harmonic["passed"] and all(row["passed"] for row in comparisons.values()),
        "seconds": perf_counter() - start,
        "harness_sha256": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (
            Path(__file__), ROOT / "scripts/true_2d_gate.py", ROOT / "scripts/true_2d_reference.py",
            ROOT / "scripts/true_2d/s4_driver.cpp", ROOT / "scripts/true_2d/convergence.py")},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(gzip.compress(json.dumps(report, allow_nan=False, separators=(",", ":")).encode(), mtime=0))
    print(json.dumps({"passed": report["passed"], "seconds": report["seconds"], "output": str(args.output)}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
