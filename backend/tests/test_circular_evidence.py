import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np

from rcwa_core.contracts_2d import validate_result_2d
from rcwa_core.schemas_2d import Project2D
from rcwa_core.solver_2d import forward_2d, input_hash_2d

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / "fixtures/true-2d"
spec = importlib.util.spec_from_file_location("circle_comparison", ROOT / "scripts/true_2d/convergence.py")
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)
INPUT_HASH = "e625443a782c0d57f5d8a5597d5410812bf8fb541249303ace49c051c66a6931"


def load(path):
    return json.loads(gzip.decompress(path.read_bytes()))


def s4_sample(reference):
    return {"polarizations": {
        pol: {"orders": series["orders"],
              "totals": {**{field: sum(o[field] for o in series["orders"]) for field in comparison.FIELDS},
                         "R": series["R"], "T": series["T"]}}
        for pol, series in reference["spectra"].items()
    }}


def check_frozen_circular_core(digests):
    """Evidence binds to the archived source that generated it, not to later production edits.

    test_exact_real_circular_default_all_wavelengths_and_channels separately requires
    current production to reproduce its adapter-1.4 circular result within 1e-10.
    """
    directory = FIXTURES / "circular-core"
    manifest = json.loads((directory / "manifest.json").read_text())
    assert manifest["files"] == digests
    for path, digest in digests.items():
        assert hashlib.sha256((directory / Path(path).name).read_bytes()).hexdigest() == digest


def check_harmonic_gate(gate):
    project = Project2D.model_validate(gate["input"])
    assert gate["passed"] and gate["input_hash"] == input_hash_2d(project)
    check_frozen_circular_core(gate["production_source_sha256"])
    for index, result in enumerate(gate["production"]):
        validate_result_2d(result, project, reference_basis=None if index == 0 else tuple(gate["bases"][index]))
    for key, ae, ai, be, bi, tolerance in (
        ("production_shipped_to_first_refinement", "p", 0, "p", 1, 5e-4),
        ("production_first_to_second_refinement", "p", 1, "p", 2, 5e-4),
        ("reference_shipped_to_first_refinement", "r", 0, "r", 1, 5e-4),
        ("reference_first_to_second_refinement", "r", 1, "r", 2, 5e-4),
        ("production_shipped_to_highest", "p", 0, "p", 2, 2e-3),
        ("production_shipped_to_converged_reference", "p", 0, "r", 2, 2e-3),
        ("production_highest_to_converged_reference", "p", 2, "r", 2, 2e-3),
    ):
        check = gate["comparisons"][key]
        assert check["passed"] and check["tolerance"] == tolerance
        for wi, wavelength in enumerate(project.illumination.wavelengths_nm):
            samples = [comparison.sample_from_result(gate["production"][i], wi) if engine == "p"
                       else s4_sample(gate["reference"][i][wi]) for engine, i in ((ae, ai), (be, bi))]
            computed = comparison.compare_samples(*samples)
            assert check["rows"][wi]["wavelength_nm"] == wavelength
            assert computed == {key: check["rows"][wi][key] for key in computed}
            assert comparison.passes(computed, tolerance)
    return project


def test_exact_real_circular_default_all_wavelengths_and_channels():
    project = Project2D.model_validate_json((FIXTURES / "circular-project.json").read_text())
    expected = load(FIXTURES / "circular-result-H5-adapter-1.4.json.gz")
    actual = forward_2d(project)
    assert input_hash_2d(project) == INPUT_HASH
    for result in (expected, actual):
        validate_result_2d(result, project)
        assert result["wavelengths_nm"] == list(range(450, 851, 20))
        assert result["metadata"]["circular_geometry"]["strips"] == 64
        assert result["metadata"]["convergence_checked"] is False
    for pol in ("s", "p"):
        for field in ("R", "T", "R_specular", "T_specular", "A_balance"):
            np.testing.assert_allclose(actual["spectra"][pol][field], expected["spectra"][pol][field], rtol=0, atol=1e-10)
        for a, b in zip(actual["spectra"][pol]["orders"], expected["spectra"][pol]["orders"], strict=True):
            assert [(o["m"], o["n"]) for o in a] == [(o["m"], o["n"]) for o in b]
            for field in comparison.FIELDS:
                np.testing.assert_allclose([o[field] for o in a], [o[field] for o in b], rtol=0, atol=1e-10)


def test_current_circular_default_meets_the_archived_converged_s4_gate():
    """Adapter 1.4.0 changed the epy factorization after this evidence was archived."""
    gate = load(ROOT / "docs/true-2d/circular-convergence.json.gz")["harmonic_gate"]
    project = Project2D.model_validate(gate["input"])
    current = load(FIXTURES / "circular-result-H5-adapter-1.4.json.gz")
    validate_result_2d(current, project)
    for wi in range(len(project.illumination.wavelengths_nm)):
        gap = comparison.compare_samples(comparison.sample_from_result(current, wi), s4_sample(gate["reference"][-1][wi]))
        assert comparison.passes(gap, comparison.INDEPENDENT_TOLERANCE)


def test_fresh_circle_harmonic_and_separate_spatial_evidence():
    report = load(ROOT / "docs/true-2d/circular-convergence.json.gz")
    assert report["passed"]
    assert report["reference_provenance"]["source_commit"] == "7fd00a231610bff51f5c7de5f723e3956eab7453"
    assert report["reference_provenance"]["tracked_source_clean"]
    for path, digest in report["harness_sha256"].items():
        assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == digest
    project = check_harmonic_gate(report["harmonic_gate"])
    assert input_hash_2d(project) == INPUT_HASH
    assert report["harmonic_gate"]["bases"] == [[5, 5], [7, 7], [9, 9]]
    gate = report["spatial_gate"]
    assert gate["passed"] and gate["strips"] == [64, 128, 256] and gate["basis"] == [5, 5]
    for index, result in enumerate(gate["production"]):
        validate_result_2d(result, project, reference_circle_strips=None if index == 0 else gate["strips"][index])
    frozen = load(FIXTURES / "circular-result-H5.json.gz")
    assert frozen["spectra"] == gate["production"][0]["spectra"] == report["harmonic_gate"]["production"][0]["spectra"]
    for a, b in ((0, 1), (1, 2), (0, 2)):
        recorded = gate["comparisons"][f'strips_{gate["strips"][a]}_to_{gate["strips"][b]}']
        assert recorded["passed"] and recorded["tolerance"] == 5e-4
        for wi, wavelength in enumerate(project.illumination.wavelengths_nm):
            computed = comparison.compare_samples(
                comparison.sample_from_result(gate["production"][a], wi), comparison.sample_from_result(gate["production"][b], wi)
            )
            assert recorded["rows"][wi]["wavelength_nm"] == wavelength
            assert computed == {key: recorded["rows"][wi][key] for key in computed}
            assert comparison.passes(computed, 5e-4)


def test_historical_core_is_explicit_frozen_baseline():
    directory = FIXTURES / "historical-core"
    manifest = json.loads((directory / "manifest.json").read_text())
    assert manifest["source_commit"] == "e4a51973fc4880cfb599659be4fa7c15c1f8b834"
    assert len(manifest["files"]) == 11
    for path, digest in manifest["files"].items():
        assert hashlib.sha256((directory / Path(path).name).read_bytes()).hexdigest() == digest


def test_circle_dependency_source_provenance_matches_pinned_environment():
    from importlib.metadata import version
    import meent

    report = json.loads((ROOT / "docs/true-2d/circular-environment.json").read_text())
    for name in ("meent", "numpy", "scipy", "pydantic"):
        assert version(name) == report["dependencies"][name]
    site = Path(meent.__file__).parent.parent
    assert len(report["package_source_sha256"]) >= 50
    for path, digest in report["package_source_sha256"].items():
        assert hashlib.sha256((site / path).read_bytes()).hexdigest() == digest
    for required in ("convolution_matrix.py", "fourier_analysis.py", "transfer_method.py"):
        assert any(path.endswith("/" + required) for path in report["package_source_sha256"])
    assert report["numerical_sweep_blas_threads"] == {"OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
    assert len(report["generation_binary_sha256"]) >= 4


def test_supplementary_offgrid_discovery_and_targeted_evidence():
    report = load(ROOT / "docs/true-2d/circular-offgrid.json.gz")
    discovery = report["discovery"]
    assert report["passed"] and report["input_hash"] == INPUT_HASH
    assert discovery["wavelengths_nm"] == list(range(450, 851, 2))
    assert len(discovery["series"]) == 12
    assert all(len(values) == 201 for values in discovery["series"].values())
    assert not discovery["requires_scope_review"]
    check_frozen_circular_core(report["production_source_sha256"])
    for path, digest in report["harness_sha256"].items():
        assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == digest
    from scipy.signal import find_peaks

    features = []
    for field, values in discovery["series"].items():
        for sign in (1, -1):
            indices, props = find_peaks(sign * np.asarray(values), prominence=5e-5)
            features.extend({"wavelength_nm": discovery["wavelengths_nm"][int(i)], "field": field, "sign": sign,
                             "prominence": float(prominence)}
                            for i, prominence in zip(indices, props["prominences"], strict=True))
    assert features == discovery["all_features"]
    project = Project2D.model_validate_json((FIXTURES / "circular-project.json").read_text())
    rebuilt_series = {f"{pol}_{field}": [] for pol in ("s", "p") for field in comparison.FIELDS}
    for chunk in discovery["chunks"]:
        p = project.model_copy(deep=True)
        p.illumination.wavelengths_nm = chunk["wavelengths_nm"]
        validate_result_2d(chunk, p, reference_basis=(3, 3))
        for pol in ("s", "p"):
            for field in comparison.FIELDS:
                rebuilt_series[f"{pol}_{field}"].extend(
                    sum(order[field] for order in orders) for orders in chunk["spectra"][pol]["orders"]
                )
    assert rebuilt_series == discovery["series"]
    targeted = report["targeted"]
    p = check_harmonic_gate(targeted["harmonic_gate"])
    assert p.illumination.wavelengths_nm == discovery["new_target_wavelengths_nm"] == [451, 452, 453, 587, 588, 589]
    spatial = targeted["spatial_results"]
    for index, result in enumerate(spatial):
        validate_result_2d(result, p, reference_circle_strips=None if index == 0 else (64, 128, 256)[index])
    for a, b in ((0, 1), (1, 2), (0, 2)):
        recorded = targeted["spatial_comparisons"][f"{(64, 128, 256)[a]}_to_{(64, 128, 256)[b]}"]
        assert recorded["passed"] and recorded["tolerance"] == 5e-4
        for wi, wavelength in enumerate(p.illumination.wavelengths_nm):
            computed = comparison.compare_samples(comparison.sample_from_result(spatial[a], wi),
                                                 comparison.sample_from_result(spatial[b], wi))
            assert recorded["rows"][wi]["wavelength_nm"] == wavelength
            assert computed == {key: recorded["rows"][wi][key] for key in computed}
            assert comparison.passes(computed, 5e-4)
