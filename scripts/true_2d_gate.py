#!/usr/bin/env python3
"""Full bounded fixture gate for the ACTUAL proposed shipped basis.

This optional expensive offline command rebuilds pinned S4, independently solves
all requested wavelengths and both polarizations, and preserves every component
and signed common-order/tail comparison. It cannot certify arbitrary edits or
continuous spectra between the sampled wavelengths.

Example: OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python
scripts/true_2d_gate.py --project path.json --s4-source /tmp/rcwa-s4-upstream
--output /tmp/gate.json.gz
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
from rcwa_core.solver_2d import forward_2d, input_hash_2d  # noqa: E402
from true_2d.convergence import (  # noqa: E402
    FIELDS,
    INDEPENDENT_TOLERANCE,
    REFINEMENT_TOLERANCE,
    compare_samples,
    passes,
    sample_from_result,
)
from true_2d_reference import build_driver, s4_solve  # noqa: E402


def as_sample(ref):
    return {
        "polarizations": {
            pol: {
                "orders": series["orders"],
                "totals": {
                    **{field: sum(o[field] for o in series["orders"]) for field in FIELDS},
                    "R": series["R"],
                    "T": series["T"],
                },
            }
            for pol, series in ref["spectra"].items()
        }
    }


def source_hashes():
    return {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted((ROOT / "backend/rcwa_core").glob("*.py"))
    }


def run_gate(project, binary, *, refinements=((7, 7), (9, 9))):
    if project.illumination.polarization != "both":
        raise ValueError("Fixture acceptance requires both incident polarizations")
    actual_basis = (project.solver.harmonics_x, project.solver.harmonics_y)
    bases = (actual_basis, *refinements)
    if (
        len(bases) != 3
        or any(len(b) != 2 or any(type(h) is not int or not 0 <= h <= 15 for h in b) for b in bases)
        or any(not (b[0] > a[0] and b[1] > a[1]) for a, b in zip(bases, bases[1:]))
    ):
        raise ValueError("Exactly two strictly larger x/y bases are required")
    before = source_hashes()
    production, reference = [], []
    started = perf_counter()
    for i, basis in enumerate(bases):
        override = None if i == 0 else basis
        computed = forward_2d(project, reference_basis=override)
        validate_result_2d(computed, project, reference_basis=override)
        production.append(computed)
        reference.append([s4_solve(binary, project, wl, *basis) for wl in project.illumination.wavelengths_nm])
        print(f"Completed actual production and independent S4 basis {basis}", flush=True)
    comparisons = {}
    for key, a_engine, a_basis, b_engine, b_basis, tolerance in (
        ("production_shipped_to_first_refinement", "production", 0, "production", 1, REFINEMENT_TOLERANCE),
        ("production_first_to_second_refinement", "production", 1, "production", 2, REFINEMENT_TOLERANCE),
        ("reference_shipped_to_first_refinement", "reference", 0, "reference", 1, REFINEMENT_TOLERANCE),
        ("reference_first_to_second_refinement", "reference", 1, "reference", 2, REFINEMENT_TOLERANCE),
        ("production_shipped_to_highest", "production", 0, "production", 2, INDEPENDENT_TOLERANCE),
        ("production_shipped_to_converged_reference", "production", 0, "reference", 2, INDEPENDENT_TOLERANCE),
        ("production_highest_to_converged_reference", "production", 2, "reference", 2, INDEPENDENT_TOLERANCE),
    ):
        rows = []
        for wi, wl in enumerate(project.illumination.wavelengths_nm):
            a = (
                sample_from_result(production[a_basis], wi)
                if a_engine == "production"
                else as_sample(reference[a_basis][wi])
            )
            b = (
                sample_from_result(production[b_basis], wi)
                if b_engine == "production"
                else as_sample(reference[b_basis][wi])
            )
            comparison = compare_samples(a, b)
            rows.append({"wavelength_nm": wl, "passed": passes(comparison, tolerance), **comparison})
        comparisons[key] = {"tolerance": tolerance, "passed": all(row["passed"] for row in rows), "rows": rows}
    if source_hashes() != before:
        raise RuntimeError("Production source changed during the gate")
    return {
        "input": project.model_dump(),
        "input_hash": input_hash_2d(project),
        "bases": bases,
        "production_source_sha256": before,
        "production": production,
        "reference": reference,
        "comparisons": comparisons,
        "passed": all(c["passed"] for c in comparisons.values()),
        "seconds": perf_counter() - started,
        "scope": "Only this exact synthetic input/basis/wavelength grid; no metrology or between-sample guarantee",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--s4-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--first-refinement", default="7,7")
    parser.add_argument("--second-refinement", default="9,9")
    args = parser.parse_args()
    project = Project2D.model_validate_json(args.project.read_text())
    bases = tuple(tuple(map(int, value.split(","))) for value in (args.first_refinement, args.second_refinement))
    binary, provenance = build_driver(args.s4_source)
    result = {"reference_provenance": provenance, "gate": run_gate(project, binary, refinements=bases)}
    data = json.dumps(result, allow_nan=False, separators=(",", ":")).encode()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(gzip.compress(data, mtime=0) if args.output.suffix == ".gz" else data)
    print(
        json.dumps(
            {
                "passed": result["gate"]["passed"],
                "input_hash": result["gate"]["input_hash"],
                "seconds": result["gate"]["seconds"],
            }
        )
    )
    return 0 if result["gate"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
