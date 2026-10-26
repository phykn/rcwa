from copy import deepcopy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("convergence", ROOT / "scripts/true_2d/convergence.py")
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


def sample(labels):
    return {
        "polarizations": {
            p: {
                "orders": [{"m": m, "n": n, **dict.fromkeys(comparison.FIELDS, 0.0)} for m, n in labels],
                "totals": dict.fromkeys(comparison.FIELDS, 0.0),
            }
            for p in ("s", "p")
        }
    }


def test_summed_added_order_tail_can_fail_when_each_order_is_small():
    a = sample([(0, 0)])
    b = sample([(0, 0)] + [(m, 1) for m in range(20)])
    # Keep totals at zero deliberately to isolate the independent tail check.
    for order in b["polarizations"]["s"]["orders"][1:]:
        order["T_s"] = order["T"] = 4e-5
    c = comparison.compare_samples(a, b)
    assert c["maximum"]["absolute"] == 0
    assert c["added_order_tail_maximum"]["absolute"] == pytest.approx(8e-4)
    assert not comparison.passes(c, comparison.REFINEMENT_TOLERANCE)


def test_comparison_retains_cross_channels_and_signed_residuals():
    a, b = sample([(0, 0)]), sample([(0, 0)])
    b["polarizations"]["s"]["orders"][0]["R_p"] = -0.001
    c = comparison.compare_samples(a, b)
    assert c["maximum"]["field"] == "R_p"
    assert c["maximum"]["signed_delta"] == -0.001
    assert not comparison.passes(c, comparison.REFINEMENT_TOLERANCE)


@pytest.mark.parametrize("bad", ["duplicate", "missing", "nonfinite", "polarization"])
def test_comparison_rejects_broken_evidence(bad):
    a, b = sample([(0, 0)]), sample([(0, 0)])
    if bad == "duplicate":
        b["polarizations"]["s"]["orders"] *= 2
    elif bad == "missing":
        b["polarizations"]["s"]["orders"].clear()
    elif bad == "nonfinite":
        b["polarizations"]["s"]["totals"]["R"] = float("nan")
    else:
        del b["polarizations"]["p"]
    with pytest.raises(ValueError):
        comparison.compare_samples(a, b)


def test_saved_laurent_diagnostic_is_not_production_convergence():
    path = ROOT / "docs/true-2d/laurent-diagnostic-results.json.gz"
    report = json.loads(gzip.decompress(path.read_bytes()))
    for source, expected in report["production_source_sha256"].items():
        assert hashlib.sha256((ROOT / "backend/tests/fixtures/true-2d/historical-core" / Path(source).name).read_bytes()).hexdigest() == expected
    assert report["reference"]["source_commit"] == "7fd00a231610bff51f5c7de5f723e3956eab7453"
    assert report["reference"]["tracked_source_clean"] is True
    assert report["diagnostics"]["passed"]
    assert report["diagnostics"]["tolerance"] == 1e-9
    for case in report["diagnostics"]["cases"]:
        actual = case["diagnostic_laurent"]
        assert actual["metadata"]["factorization"] == "diagnostic_laurent"
        assert actual["metadata"]["convergence_checked"] is False
        for wi, row in enumerate(case["comparison"]):
            a = comparison.sample_from_result(actual, wi)
            b = deepcopy(a)
            for pol, ref in row["S4"]["spectra"].items():
                b["polarizations"][pol]["orders"] = ref["orders"]
                b["polarizations"][pol]["totals"] = {
                    field: sum(o[field] for o in ref["orders"]) for field in comparison.FIELDS
                }
                b["polarizations"][pol]["totals"].update(R=ref["R"], T=ref["T"])
            assert comparison.passes(comparison.compare_samples(a, b), 1e-9)


@pytest.mark.parametrize("name", ["multiple-open-channels", "lossy-mixed-eight-layer"])
def test_archived_representative_production_convergence(name):
    from rcwa_core.contracts_2d import validate_result_2d
    from rcwa_core.schemas_2d import Project2D
    from rcwa_core.solver_2d import input_hash_2d

    report = json.loads(gzip.decompress((ROOT / f"docs/true-2d/{name}-gate.json.gz").read_bytes()))
    gate = report["gate"]
    for path, sha256 in gate["production_source_sha256"].items():
        assert hashlib.sha256((ROOT / "backend/tests/fixtures/true-2d/historical-core" / Path(path).name).read_bytes()).hexdigest() == sha256
    project = Project2D.model_validate(gate["input"])
    assert gate["input_hash"] == input_hash_2d(project)
    assert report["reference_provenance"]["source_commit"] == "7fd00a231610bff51f5c7de5f723e3956eab7453"
    assert report["reference_provenance"]["tracked_source_clean"]
    assert len(gate["bases"]) == len(gate["production"]) == len(gate["reference"]) == 3
    for i, actual in enumerate(gate["production"]):
        validate_result_2d(actual, project, reference_basis=None if i == 0 else tuple(gate["bases"][i]))
    for key, ae, ai, be, bi, tolerance in (
        ("production_shipped_to_first_refinement", "p", 0, "p", 1, 5e-4),
        ("production_first_to_second_refinement", "p", 1, "p", 2, 5e-4),
        ("reference_shipped_to_first_refinement", "r", 0, "r", 1, 5e-4),
        ("reference_first_to_second_refinement", "r", 1, "r", 2, 5e-4),
        ("production_shipped_to_highest", "p", 0, "p", 2, 2e-3),
        ("production_shipped_to_converged_reference", "p", 0, "r", 2, 2e-3),
        ("production_highest_to_converged_reference", "p", 2, "r", 2, 2e-3),
    ):
        recorded = gate["comparisons"][key]
        assert recorded["tolerance"] == tolerance
        for wi, wl in enumerate(project.illumination.wavelengths_nm):
            samples = []
            for engine, index in ((ae, ai), (be, bi)):
                if engine == "p":
                    sample = comparison.sample_from_result(gate["production"][index], wi)
                else:
                    reference = gate["reference"][index][wi]["spectra"]
                    hx, hy = gate["bases"][index]
                    sample = {"polarizations": {}}
                    for pol, series in reference.items():
                        labels = {(o["m"], o["n"]) for o in series["orders"]}
                        assert labels == {(m, n) for n in range(-hy, hy + 1) for m in range(-hx, hx + 1)}
                        assert len(series["orders"]) == len(labels)
                        totals = {field: sum(o[field] for o in series["orders"]) for field in comparison.FIELDS}
                        assert abs(totals["R"] - series["R"]) < 1e-9
                        assert abs(totals["T"] - series["T"]) < 1e-9
                        for order in series["orders"]:
                            assert abs(order["R"] - order["R_s"] - order["R_p"]) < 1e-9
                            assert abs(order["T"] - order["T_s"] - order["T_p"]) < 1e-9
                        totals.update(R=series["R"], T=series["T"])
                        sample["polarizations"][pol] = {"totals": totals, "orders": series["orders"]}
                samples.append(sample)
            computed = comparison.compare_samples(*samples)
            assert recorded["rows"][wi]["wavelength_nm"] == wl
            assert computed == {k: recorded["rows"][wi][k] for k in computed}
            assert comparison.passes(computed, tolerance)
    first = gate["production"][0]
    if name == "multiple-open-channels":
        for spectrum in first["spectra"].values():
            assert sum(o["transmission_propagating"] for o in spectrum["orders"][0]) >= 4
            assert sum(o["T"] for o in spectrum["orders"][0] if o["m"] or o["n"]) > 1e-4
    else:
        assert len(project.layers) == 8
        assert project.solver.harmonics_x != project.solver.harmonics_y
        assert min(s["A_balance"][0] for s in first["spectra"].values()) > 0
        for spectrum in first["spectra"].values():
            assert all(o["transmission_class"] == "absorbing_half_space" for o in spectrum["orders"][0])
        assert (
            max(
                row["added_order_tail_maximum"]["absolute"]
                for row in gate["comparisons"]["reference_shipped_to_first_refinement"]["rows"]
            )
            > 0
        )
