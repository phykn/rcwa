"""Uniform stacks cannot diffract, so grating-only order checks must not reject them."""

import numpy as np
import pytest

from rcwa_core.project_io import forward_project, parse_project, preflight_project_any
from rcwa_core.schemas import Project
from rcwa_core.solver import SolverError, forward

from test_physics import analytic_film


def material(n, k=0.0):
    return {"name": f"n={n}", "kind": "constant", "n": n, "k": k}


def film_1d(period, wavelengths, angle, harmonics=5, cd=None):
    layer = {"geometry": "homogeneous", "thickness_nm": 120.0, "material": material(2.1)}
    if cd is not None:
        layer = {"cd_nm": cd, "thickness_nm": 120.0, "material": material(2.1)}
    return Project.model_validate(
        {
            "schema_version": "1.1",
            "period_nm": period,
            "substrate": material(1.5),
            "layers": [layer],
            "illumination": {"wavelengths_nm": wavelengths, "angle_deg": angle, "polarization": "both"},
            "solver": {"harmonics": harmonics},
        }
    )


def film_2d(period, wavelengths, angle, harmonics, layer):
    return parse_project(
        {
            "schema_version": "1.2",
            "name": "film",
            "period_nm": period,
            "period_y_nm": period,
            "ambient": material(1.0),
            "substrate": material(1.5),
            "layers": [layer],
            "illumination": {"wavelengths_nm": wavelengths, "angle_deg": angle, "azimuth_deg": 0, "polarization": "both"},
            "solver": {"harmonics_x": harmonics, "harmonics_y": harmonics},
        }
    )


def check_airy(result, wavelengths, angle):
    for pol in ("s", "p"):
        expected = np.array([analytic_film(w, angle, 1.0, 2.1, 1.5, 120.0, pol) for w in wavelengths])
        np.testing.assert_allclose(result["spectra"][pol]["R"], expected[:, 0], atol=2e-10)
        np.testing.assert_allclose(result["spectra"][pol]["T"], expected[:, 1], atol=2e-10)


def test_1d_film_at_nonspecular_cutoff_matches_airy():
    # Order -1 sits exactly at kx = -1 for period 400, 600 nm, 30 degrees.
    project = film_1d(400, [600.0], 30)
    check_airy(forward(project), [600.0], 30)


def test_1d_film_with_large_period_and_few_harmonics():
    project = film_1d(5000, [200.0, 400.0], 20, harmonics=1)
    check_airy(forward(project), [200.0, 400.0], 20)


def test_1d_grating_still_rejects_cutoff():
    with pytest.raises(SolverError, match="cutoff"):
        forward(film_1d(400, [600.0], 30, cd=200.0))


@pytest.mark.parametrize(
    "layer",
    [
        {"geometry": "homogeneous", "thickness_nm": 120.0, "material": material(2.1)},
        {
            "geometry": "rectangle_2d",
            "thickness_nm": 120.0,
            "cd_x_nm": 400.0,
            "cd_y_nm": 400.0,
            "material": material(2.1),
            "background": material(1.0),
        },
        {
            "geometry": "circular_hole_2d",
            "thickness_nm": 120.0,
            "diameter_nm": 0.0,
            "material": material(1.0),
            "background": material(2.1),
        },
    ],
)
def test_2d_uniform_film_at_nonspecular_cutoff_matches_airy(layer):
    project = film_2d(400, [600.0], 30, 1, layer)
    assert not [d for d in preflight_project_any(project) if d.severity == "error"]
    check_airy(forward_project(project), [600.0], 30)


def test_2d_patterned_layer_still_rejects_cutoff():
    layer = {
        "geometry": "circular_hole_2d",
        "thickness_nm": 120.0,
        "diameter_nm": 200.0,
        "material": material(1.0),
        "background": material(2.1),
    }
    codes = {d.code for d in preflight_project_any(film_2d(400, [600.0], 30, 1, layer))}
    assert "rayleigh_cutoff" in codes
