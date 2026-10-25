"""Circle schema, genuine disk approximation, exact identity and public boundaries."""
from copy import deepcopy
import math
from pathlib import Path

import numpy as np
from pydantic import ValidationError
import pytest
from scipy.special import j1

from rcwa_core.circular_geometry import CIRCLE_STRIPS, circular_cell_2d, circle_widths
from rcwa_core.contracts_2d import PublicForwardResult2D, validate_result_2d
from rcwa_core.preflight_2d import active_materials_2d
from rcwa_core.project_io import normalized_project_and_hash, validate_result_for_project
from rcwa_core.schemas_2d import Project2D
from rcwa_core.solver_2d import forward_2d, input_hash_2d

FIXTURE = Path(__file__).parent / "fixtures/true-2d/circular-project.json"


def circle_project():
    project = Project2D.model_validate_json(FIXTURE.read_text()).model_dump(mode="json")
    project["illumination"]["wavelengths_nm"] = [650.0]
    project["solver"] = {"harmonics_x": 1, "harmonics_y": 1}
    return project


@pytest.mark.parametrize("diameter", [True, "65", None, float("nan"), float("inf"), -1, 140.01])
def test_circle_strict_diameter_and_period_bound(diameter):
    p = circle_project()
    p["layers"][0]["diameter_nm"] = diameter
    with pytest.raises(ValueError):
        normalized_project_and_hash(p)


def test_circle_unknown_fields_and_no_implicit_legacy_migration():
    for key, value in (("cd_x_nm", 65), ("cd_y_nm", 65), ("circle_strips", 128)):
        p = circle_project()
        p["layers"][0][key] = value
        with pytest.raises(ValueError):
            normalized_project_and_hash(p)
    for version in ("1.0", "1.1"):
        p = circle_project()
        p["schema_version"] = version
        with pytest.raises(ValueError):
            normalized_project_and_hash(p)


def test_circle_inactive_diameter_thickness_and_tangent_host_corners():
    p = circle_project()
    p["layers"] = p["layers"][:1]
    p["period_nm"] = p["period_y_nm"] = 140.0
    p["layers"][0]["diameter_nm"] = 140.0
    model = Project2D.model_validate(p)
    assert list(active_materials_2d(model)) == [model.layers[0].material, model.layers[0].background]
    model.layers[0].diameter_nm = 0
    assert list(active_materials_2d(model)) == [model.layers[0].background]
    model.layers[0].thickness_nm = 0
    assert list(active_materials_2d(model)) == []


@pytest.mark.parametrize("strips", [8, 64, 128, 256])
def test_circle_cell_is_centered_not_its_square_bounding_box(strips):
    values, x, y = circular_cell_2d(140, 140, 140, 1, 1.5, strips=strips)
    assert values[0, 0] == values[0, -1] == values[-1, 0] == values[-1, -1] == 1.5
    np.testing.assert_array_equal(values, values[::-1, :])
    np.testing.assert_array_equal(values, values[:, ::-1])
    dx, dy = np.diff(np.r_[0, x.ravel().real]), np.diff(np.r_[0, y.ravel().real])
    area = np.sum((values.real == 1) * dy[:, None] * dx[None, :])
    expected = np.sum(circle_widths(140, strips)) * 140 / strips
    assert area == pytest.approx(expected)
    assert abs(area - math.pi * 70**2) < 140**2 / strips
    assert area < 0.8 * 140**2


def test_zero_diameter_exactly_uniform_host():
    cell = circular_cell_2d(150, 140, 0, 1, 1.5)
    assert np.all(cell[0] == 1.5)
    assert cell[1][-1] == 150 and cell[2][-1] == 140


def test_continuous_circle_fourier_coefficients_converge_to_analytic_disk():
    from meent.on_numpy.emsolver.fourier_analysis import cfs2d

    px, py, diameter, contrast = 150, 140, 95, 1 - 1.5**2
    error = []
    for strips in (32, 64, 128):
        values, x, y = circular_cell_2d(px, py, diameter, 1, 1.5, strips=strips)
        matrix = cfs2d(values**2, x, y, 1, 1, 2, 2)
        analytic = []
        for n in range(-2, 3):
            for m in range(-2, 3):
                q = math.pi * diameter * math.hypot(m / px, n / py)
                disk = math.pi * (diameter / 2)**2 / (px * py) * (1 if q == 0 else 2 * j1(q) / q)
                analytic.append((1.5**2 if m == n == 0 else 0) + contrast * disk * (-1)**(m+n))
        error.append(max(abs(matrix[12, :] - analytic)))
    assert error[2] < error[1] < error[0]
    assert error[-1] < 1e-4


@pytest.fixture(scope="module")
def solved_circle():
    p = Project2D.model_validate(circle_project())
    return p, forward_2d(p)


def test_actual_circle_result_hash_geometry_and_public_binding(solved_circle):
    project, result = solved_circle
    assert result["metadata"]["input_hash"] == input_hash_2d(project)
    assert result["metadata"]["adapter_version"] == "1.4.0"
    assert result["metadata"]["circular_geometry"]["strips"] == CIRCLE_STRIPS
    assert not result["metadata"]["convergence_checked"]
    assert validate_result_for_project("forward", result, project).model_dump(mode="json") == result
    changed = project.model_copy(deep=True)
    changed.layers[0].diameter_nm += 1
    assert input_hash_2d(changed) != input_hash_2d(project)
    with pytest.raises(ValueError, match="hash"):
        validate_result_2d(result, changed)


@pytest.mark.parametrize("mutation", ["old_adapter", "missing", "strips", "override", "area", "layers"])
def test_circle_metadata_cannot_be_forged_or_misbound(solved_circle, mutation):
    project, original = solved_circle
    result = deepcopy(original)
    meta = result["metadata"]
    if mutation == "old_adapter":
        meta["adapter_version"] = "1.2.0"
    elif mutation == "missing":
        del meta["circular_geometry"]
    elif mutation == "area":
        meta["circular_geometry"]["layers"][0]["exact_area_nm2"] += 1
    elif mutation == "layers":
        meta["circular_geometry"]["layers"].reverse()
    else:
        meta["circular_geometry"]["strips" if mutation == "strips" else "offline_spatial_override"] = (
            128 if mutation == "strips" else True
        )
    with pytest.raises(ValueError):
        validate_result_for_project("forward", result, project)


def test_offline_spatial_refinement_cannot_be_served_as_public(solved_circle):
    project, _ = solved_circle
    result = forward_2d(project, reference_circle_strips=128)
    validate_result_2d(result, project, reference_circle_strips=128)
    with pytest.raises(ValidationError):
        PublicForwardResult2D.model_validate(result)
    with pytest.raises(ValueError):
        validate_result_2d(result, project)


def test_circle_unused_material_tables_still_require_coverage():
    p = circle_project()
    p["layers"][0].update(diameter_nm=0, thickness_nm=0)
    for slot in ("material", "background"):
        changed = deepcopy(p)
        changed["layers"][0][slot] = {
            "kind": "tabulated", "wavelengths_nm": [700, 800], "n_values": [1, 1], "k_values": [0, 0]
        }
        with pytest.raises(ValueError, match="outside material table"):
            normalized_project_and_hash(changed)


def test_circle_zero_diameter_solution_matches_uniform_host():
    p = circle_project()
    p["layers"] = p["layers"][:1]
    p["layers"][0]["diameter_nm"] = 0
    a = forward_2d(Project2D.model_validate(p))
    layer = p["layers"][0]
    p["layers"] = [{"geometry": "homogeneous", "thickness_nm": layer["thickness_nm"], "material": layer["background"]}]
    b = forward_2d(Project2D.model_validate(p))
    for pol in ("s", "p"):
        for field in ("R", "T", "R_specular", "T_specular"):
            np.testing.assert_allclose(a["spectra"][pol][field], b["spectra"][pol][field], rtol=0, atol=1e-12)


def test_tangent_circle_with_lossy_host_keeps_absorbing_corners():
    p = circle_project()
    p["period_nm"] = p["period_y_nm"] = 140.0
    p["layers"] = p["layers"][:1]
    p["layers"][0]["diameter_nm"] = 140.0
    p["layers"][0]["background"]["k"] = 0.03
    model = Project2D.model_validate(p)
    result = forward_2d(model)
    validate_result_2d(result, model)
    assert result["metadata"]["max_lossless_flux_error"] is None
    assert min(series["A_balance"][0] for series in result["spectra"].values()) > 0.001
