"""Exact numerical default regression, without exposing an application default."""

import gzip
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import importlib.util
import tarfile

import numpy as np

from rcwa_core.contracts_2d import validate_result_2d
from rcwa_core.schemas_2d import Project2D
from rcwa_core.solver_2d import forward_2d, input_hash_2d

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / "fixtures/true-2d"
INPUT_HASH = "eeb26da3484602221944f1784b4b93ce2ed76f89b61e95d34bb68730be7bddc7"
spec = importlib.util.spec_from_file_location("convergence", ROOT / "scripts/true_2d/convergence.py")
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


def load_result(name):
    return json.loads(gzip.decompress((FIXTURES / name).read_bytes()))


def test_exact_synthetic_default_actual_h5_all_wavelengths_and_channels():
    project = Project2D.model_validate_json((FIXTURES / "default-project.json").read_text())
    expected = load_result("default-result-H5-adapter-1.4.json.gz")
    assert input_hash_2d(project) == INPUT_HASH
    actual = forward_2d(project)
    validate_result_2d(expected, project)
    validate_result_2d(actual, project)
    assert actual["wavelengths_nm"] == expected["wavelengths_nm"] == list(range(450, 851, 20))
    assert actual["metadata"]["input_hash"] == INPUT_HASH
    assert actual["metadata"]["harmonics_x"] == actual["metadata"]["harmonics_y"] == 5
    assert actual["metadata"]["factorization"] == "directional_inverse_rule"
    assert not actual["metadata"]["offline_reference_override"]
    # Evidence is input-specific; normal results never inherit certification.
    assert not actual["metadata"]["convergence_checked"]
    for pol in ("s", "p"):
        a, e = actual["spectra"][pol], expected["spectra"][pol]
        for field in ("R", "T", "R_specular", "T_specular", "A_balance"):
            np.testing.assert_allclose(a[field], e[field], rtol=0, atol=1e-10)
        for a_orders, e_orders in zip(a["orders"], e["orders"], strict=True):
            assert [(o["m"], o["n"]) for o in a_orders] == [(o["m"], o["n"]) for o in e_orders]
            for field in ("R", "T", "R_s", "R_p", "T_s", "T_p", "kx_over_k0", "ky_over_k0"):
                np.testing.assert_allclose(
                    [o[field] for o in a_orders], [o[field] for o in e_orders], rtol=0, atol=1e-10
                )


def test_current_and_archived_default_meet_the_accepted_independent_s4_gate():
    """Adapter 1.4.0 changed the epy factorization; the archived S4 H9 samples still bound both results."""
    project = Project2D.model_validate_json((FIXTURES / "default-project.json").read_text())
    current = load_result("default-result-H5-adapter-1.4.json.gz")
    archived = load_result("default-result-H5.json.gz")
    wanted = {f"accepted/samples/default/S4/H9/{w:.9f}.json": w for w in project.illumination.wavelengths_nm}
    references = {}
    with tarfile.open(ROOT / "docs/true-2d/default-convergence-evidence.tar.gz", "r|gz") as tar:
        for member in tar:
            if member.name in wanted:
                references[wanted[member.name]] = json.loads(tar.extractfile(member).read())
    assert sorted(references) == project.illumination.wavelengths_nm
    for wi, wavelength in enumerate(project.illumination.wavelengths_nm):
        assert references[wavelength]["engine"] == "S4" and references[wavelength]["H"] == 9
        for result in (current, archived):
            gap = comparison.compare_samples(comparison.sample_from_result(result, wi), references[wavelength])
            assert comparison.passes(gap, comparison.INDEPENDENT_TOLERANCE)


def test_default_evidence_package_integrity_and_frozen_core_binding():
    docs = ROOT / "docs/true-2d"
    manifest = json.loads((docs / "default-evidence-package.json").read_text())
    archive = docs / "default-convergence-evidence.tar.gz"
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest["archive_sha256"]
    assert archive.stat().st_size == manifest["archive_bytes"]
    hashes, selected = {}, {}
    wanted = {
        "accepted/acceptance.json",
        "accepted/provenance-final.json",
        "accepted/candidate-project.json",
        "accepted/candidate-result-H5.json",
        "SHA256SUMS.json",
    }
    with tarfile.open(archive, "r|gz") as tar:
        for member in tar:
            assert member.isfile() and member.name not in hashes
            payload = tar.extractfile(member).read()
            hashes[member.name] = hashlib.sha256(payload).hexdigest()
            if member.name in wanted:
                selected[member.name] = payload
    inventory = json.loads(selected["SHA256SUMS.json"])["files"]
    del hashes["SHA256SUMS.json"]
    assert hashes == inventory
    assert len(inventory) == manifest["file_count"]
    assert selected["accepted/candidate-project.json"] == (FIXTURES / "default-project.json").read_bytes()
    assert selected["accepted/candidate-result-H5.json"] == gzip.decompress(
        (FIXTURES / "default-result-H5.json.gz").read_bytes()
    )
    accepted = json.loads(selected["accepted/acceptance.json"])
    assert accepted["accepted"] and all(gate["pass"] for gate in accepted["gates"])
    assert accepted["exact_candidate_input_hash"] == INPUT_HASH
    assert accepted["default_samples"] == 21
    assert accepted["dense_samples"] == 40
    assert accepted["unique_default_and_dense_samples"] == 60
    assert accepted["cache_audit_verified_samples"] == 438
    for gate in accepted["gates"]:
        if "tolerance" in gate and gate["scope"] != "exact_candidate_input":
            independent = gate["comparison"] == "meent_H5_S4_H9"
            assert gate["tolerance"] == (2e-3 if independent else 5e-4)
    provenance = json.loads(selected["accepted/provenance-final.json"])
    assert provenance["S4_commit"] == "7fd00a231610bff51f5c7de5f723e3956eab7453"
    assert not provenance["S4_tracked_diff"]
    core_hashes = {k: v for k, v in provenance["hashes"].items() if "/backend/rcwa_core/" in k}
    assert len(core_hashes) >= 4
    for path, expected_hash in core_hashes.items():
        local = FIXTURES / "historical-core" / Path(path).name
        assert hashlib.sha256(local.read_bytes()).hexdigest() == expected_hash
    # Portable package versions and recorded source bytes must still match.
    # Platform-specific compiled BLAS hashes remain generation provenance;
    # real H5 and independent reference CI separately check numerical behavior.
    for dependency in ("meent", "numpy"):
        assert version(dependency) == provenance[dependency]
    import meent
    meent_root = Path(meent.__file__).parent
    dependency_hashes = {k: v for k, v in provenance["hashes"].items() if "/site-packages/meent/" in k}
    assert len(dependency_hashes) >= 4
    for path, expected_hash in dependency_hashes.items():
        local = meent_root / path.split("/site-packages/meent/", 1)[1]
        assert hashlib.sha256(local.read_bytes()).hexdigest() == expected_hash
