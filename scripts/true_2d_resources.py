#!/usr/bin/env python3
"""Standalone provisional cap profiling; does NOT test application workers.

Run with single-thread BLAS and an external 120-second timeout per invocation.
Worker admission, cancellation and deployed memory headroom remain separate gates.
"""

import argparse
import json
from pathlib import Path
import resource
import sys
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from rcwa_core.contracts_2d import validate_result_2d  # noqa: E402
from rcwa_core.schemas_2d import Project2D  # noqa: E402
from rcwa_core.solver_2d import forward_2d  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=["high_contrast", "extreme"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    layers = []
    for i in range(8):
        layers.append(
            {
                "geometry": "rectangle_2d",
                "thickness_nm": 2000,
                "cd_x_nm": 100 + 37 * i,
                "cd_y_nm": 90 + 35 * i,
                "material": {
                    "n": 10 if args.case == "extreme" else 2.5 + 0.17 * i,
                    "k": 10 if args.case == "extreme" else 0.03 + 0.01 * i,
                },
                "background": {"n": 1 + 0.07 * i, "k": 0.01 + 0.003 * i},
            }
        )
    project = Project2D.model_validate(
        {
            "schema_version": "1.2",
            "name": f"Numerical resource {args.case}",
            "period_nm": 460,
            "period_y_nm": 420,
            "substrate": {"n": 0.4, "k": 3.1},
            "layers": layers,
            "illumination": {
                "angle_deg": 37,
                "azimuth_deg": 25,
                "wavelengths_nm": [450 + i * (400 / 30) for i in range(31)],
            },
            "solver": {"harmonics_x": 5, "harmonics_y": 5},
        }
    )
    started = perf_counter()
    result = forward_2d(project)
    validate_result_2d(result, project)
    data = json.dumps(result, allow_nan=False, separators=(",", ":")).encode()
    elapsed = perf_counter() - started
    report = {
        "case": args.case,
        "input": project.model_dump(),
        "seconds": elapsed,
        "peak_RSS_KiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "serialized_bytes": len(data),
        "target_seconds": 90,
        "target_bytes": 6_000_000,
        "passed_standalone_targets": elapsed < 90 and len(data) < 6_000_000,
        "worker_admission_cancellation_timeout_restart": "not tested; deferred application gate",
        "deployed_resource_class": "not established; local observation only",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "input"}))
    return 0 if report["passed_standalone_targets"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
