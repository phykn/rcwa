#!/usr/bin/env python3
"""Bounded supplementary off-grid discovery and optional targeted circle checks.

A 2 nm H3 discovery grid cannot prove absence of sub-grid resonances. Prominent
interior extrema and a highest-curvature sample select additional wavelengths;
none are selected by whether they pass the subsequent acceptance tests.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from scipy.signal import find_peaks

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from rcwa_core.contracts_2d import validate_result_2d  # noqa: E402
from rcwa_core.schemas_2d import Project2D  # noqa: E402
from rcwa_core.solver_2d import forward_2d, input_hash_2d  # noqa: E402
from true_2d.convergence import FIELDS, compare_samples, passes, sample_from_result, REFINEMENT_TOLERANCE  # noqa: E402
from true_2d_gate import run_gate, source_hashes  # noqa: E402
from true_2d_reference import build_driver  # noqa: E402

CRITERION = (
    "H3/64 strips on every 2 nm from 450 through 850; all six total order/channel powers for each incident s,p. "
    "Select both-sign interior extrema with prominence >= 5e-5; merge centers within 2 nm keeping greatest "
    "prominence (lower wavelength breaks ties). Add maximum absolute second-difference wavelength if more "
    "than 2 nm from every chosen center. Check each center and +/-1 nm, excluding existing default-grid points. "
    "More than six centers requires review before expansion; never truncate detected features."
)


def discover(project):
    wavelengths = list(range(450, 851, 2))
    arrays = {f"{pol}_{field}": [] for pol in ("s", "p") for field in FIELDS}
    chunks = []
    for begin in range(0, len(wavelengths), 31):
        p = project.model_copy(deep=True)
        p.illumination.wavelengths_nm = wavelengths[begin:begin + 31]
        result = forward_2d(p, reference_basis=(3, 3))
        validate_result_2d(result, p, reference_basis=(3, 3))
        chunks.append(result)
        for pol in ("s", "p"):
            for field in FIELDS:
                arrays[f"{pol}_{field}"].extend(
                    sum(order[field] for order in orders) for orders in result["spectra"][pol]["orders"]
                )
    features = []
    for field, values in arrays.items():
        for sign in (1, -1):
            indices, properties = find_peaks(sign * np.asarray(values), prominence=5e-5)
            features.extend({"wavelength_nm": wavelengths[int(i)], "field": field, "sign": sign,
                             "prominence": float(prominence)}
                            for i, prominence in zip(indices, properties["prominences"], strict=True))
    selected = []
    for feature in sorted(features, key=lambda row: (-row["prominence"], row["wavelength_nm"], row["field"])):
        if all(abs(feature["wavelength_nm"] - row["wavelength_nm"]) > 2 for row in selected):
            selected.append(feature)
    curvature = max(
        ({"field": field, "wavelength_nm": wavelengths[i + 1], "absolute_second_difference": abs(float(value))}
         for field, values in arrays.items() for i, value in enumerate(np.diff(values, n=2))),
        key=lambda row: (row["absolute_second_difference"], -row["wavelength_nm"]),
    )
    if all(abs(curvature["wavelength_nm"] - row["wavelength_nm"]) > 2 for row in selected):
        selected.append(curvature)
    selected.sort(key=lambda row: row["wavelength_nm"])
    targets = sorted({row["wavelength_nm"] + shift for row in selected for shift in (-1, 0, 1)}
                     - set(project.illumination.wavelengths_nm))
    return {"criterion": CRITERION, "wavelengths_nm": wavelengths, "series": arrays, "chunks": chunks,
            "all_features": features, "selected_centers": selected, "maximum_curvature": curvature,
            "new_target_wavelengths_nm": targets, "requires_scope_review": len(selected) > 6}


def targeted_gate(project, discovery, binary):
    if discovery["requires_scope_review"]:
        raise ValueError("More than six feature centers detected: report scope before a targeted sweep")
    p = project.model_copy(deep=True)
    p.illumination.wavelengths_nm = discovery["new_target_wavelengths_nm"]
    if not p.illumination.wavelengths_nm:
        return {"passed": True, "scope": "No new targets selected by the predeclared criterion"}
    gate = run_gate(p, binary)
    spatial, comparisons = [gate["production"][0]], {}
    for strips in (128, 256):
        result = forward_2d(p, reference_circle_strips=strips)
        validate_result_2d(result, p, reference_circle_strips=strips)
        spatial.append(result)
    for a, b in ((0, 1), (1, 2), (0, 2)):
        rows = []
        for wi, wavelength in enumerate(p.illumination.wavelengths_nm):
            comparison = compare_samples(sample_from_result(spatial[a], wi), sample_from_result(spatial[b], wi))
            rows.append({"wavelength_nm": wavelength, "passed": passes(comparison, REFINEMENT_TOLERANCE), **comparison})
        comparisons[f"{(64,128,256)[a]}_to_{(64,128,256)[b]}"] = {
            "tolerance": REFINEMENT_TOLERANCE, "passed": all(row["passed"] for row in rows), "rows": rows}
    return {"harmonic_gate": gate, "spatial_results": spatial, "spatial_comparisons": comparisons,
            "passed": gate["passed"] and all(row["passed"] for row in comparisons.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--discovery", type=Path, help="Reuse and verify an existing discovery report")
    parser.add_argument("--s4-source", type=Path, help="When supplied, run targeted independent checks after discovery")
    args = parser.parse_args()
    before = source_hashes()
    harness_paths = [Path(__file__), ROOT / "scripts/true_2d_gate.py", ROOT / "scripts/true_2d_reference.py",
                     ROOT / "scripts/true_2d/s4_driver.cpp", ROOT / "scripts/true_2d/convergence.py"]
    harness = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in harness_paths}
    project = Project2D.model_validate_json((ROOT / "backend/tests/fixtures/true-2d/circular-project.json").read_text())
    if args.discovery:
        previous = json.loads(gzip.decompress(args.discovery.read_bytes()))
        if previous["production_source_sha256"] != before or previous["input_hash"] != input_hash_2d(project):
            raise ValueError("Discovery source or input no longer matches")
        if previous["harness_sha256"] != harness or previous["discovery"]["criterion"] != CRITERION:
            raise ValueError("Discovery harness or predeclared criterion differs")
        discovery = previous["discovery"]
    else:
        discovery = discover(project)
    report = {"scope": "Sampled feature discovery only; does not exclude sub-2-nm features or certify arbitrary edits",
              "input_hash": input_hash_2d(project), "production_source_sha256": before,
              "harness_sha256": harness, "discovery": discovery}
    print(json.dumps({"centers": discovery["selected_centers"], "targets": discovery["new_target_wavelengths_nm"],
                      "requires_scope_review": discovery["requires_scope_review"]}), flush=True)
    if args.s4_source:
        binary, provenance = build_driver(args.s4_source, reuse_verified_library=True)
        report["reference_provenance"] = provenance
        report["targeted"] = targeted_gate(project, discovery, binary)
        report["passed"] = report["targeted"]["passed"]
    if before != source_hashes() or harness != {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in harness_paths
    }:
        raise RuntimeError("Sources changed during off-grid checks")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(gzip.compress(json.dumps(report, allow_nan=False, separators=(",", ":")).encode(), mtime=0))
    return 0 if report.get("passed", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
