"""Field maps reproduce analytic thin-film fields and refuse unverifiable cases."""

import json
from pathlib import Path

import numpy as np
import pytest

from rcwa_core.field_2d import FieldUnavailable, field_2d
from rcwa_core.project_io import parse_project

EXAMPLE = Path(__file__).parents[1] / "api/examples/circular-hole-2d.json"


def material(n, k=0.0):
    return {"name": f"n={n}", "kind": "constant", "n": n, "k": k}


def film(nf=2.0, ns=1.5, ks=0.0, thickness=100.0):
    return parse_project({
        "schema_version": "1.2", "name": "film", "period_nm": 300, "period_y_nm": 300,
        "ambient": material(1.0), "substrate": material(ns, ks),
        "layers": [{"geometry": "homogeneous", "thickness_nm": thickness, "material": material(nf)}],
        "illumination": {"wavelengths_nm": [600.0], "angle_deg": 0, "azimuth_deg": 0, "polarization": "both"},
        "solver": {"harmonics_x": 1, "harmonics_y": 1},
    })


def film_field(z, wavelength, nf, ns, d):
    """Exact |E|^2 inside a film at normal incidence (exp(-iwt), unit incident amplitude)."""
    k = 2 * np.pi / wavelength
    r12 = (nf - ns) / (nf + ns)
    # Field inside: A exp(i k nf z) + B exp(-i k nf z), z from the top; B/A fixed by the bottom interface.
    ratio = r12 * np.exp(2j * k * nf * d)
    # Match tangential E and H at the top: 1 + r = A + B, 1 - r = nf (A - B).
    a = 2 / ((1 + nf) + (1 - nf) * ratio)
    return np.abs(a * (np.exp(1j * k * nf * z) + ratio * np.exp(-1j * k * nf * z))) ** 2


@pytest.mark.parametrize("pol", ["s", "p"])
def test_uniform_film_field_matches_analytic(pol):
    project = film()
    out = field_2d(project, 600.0, pol, resolution=16)
    column = np.asarray(out["xz"])[:, 8]
    expected = film_field(np.asarray(out["depth_nm"]), 600.0, 2.0, 1.5, 100.0)
    np.testing.assert_allclose(column, expected, rtol=1e-6, atol=1e-8)


def test_patterned_example_field_is_finite_and_bound_to_its_powers():
    project = parse_project(json.loads(EXAMPLE.read_text()))
    out = field_2d(project, 600.0, "s", resolution=24)
    assert np.isfinite(out["max_intensity"]) and out["max_intensity"] > 0
    assert len(out["xy"]) == 3 and np.asarray(out["xz"]).shape == (39, 24)
    # Cuts pass exactly through the cell centre line and each layer's mid-plane.
    assert out["y_nm"][len(out["y_nm"]) // 2] == pytest.approx(out["xz_y_nm"]) == project.period_y_nm / 2
    tops = out["layer_tops_nm"]
    assert out["xy_depth_nm"] == pytest.approx([(a + b) / 2 for a, b in zip(tops, tops[1:])])
    assert 0 < out["R"] < 1 and 0 < out["T"] < 1


def test_rejects_bad_requests():
    with pytest.raises(ValueError):
        field_2d(film(), 600.0, "both")
    with pytest.raises(ValueError):
        field_2d(film(), 600.0, "s", resolution=200)


def test_absorbing_substrate_is_mapped_only_when_powers_agree():
    try:
        out = field_2d(film(ns=3.9, ks=0.02), 600.0, "s", resolution=16)
    except FieldUnavailable:
        return
    expected = film_field(np.asarray(out["depth_nm"]), 600.0, 2.0, complex(3.9, 0.02), 100.0)
    np.testing.assert_allclose(np.asarray(out["xz"])[:, 8], expected, rtol=1e-5)
