"""Multilayer power physics, independent planar TMM, and topology invariants.

The characteristic-matrix reference below does not use meent, the application
Fourier compiler, or its transfer recursion. Only finite-basis agreement is
asserted for patterned layers; a single run is never convergence certification.
"""

import numpy as np
import pytest

from rcwa_core.contracts import validate_result
from rcwa_core.schemas import HomogeneousLayer, Layer, Material, Project
from rcwa_core.solver import forward, stack_cells


def index(n):
    return Material(n=complex(n).real, k=complex(n).imag)


def film(d, n):
    return HomogeneousLayer(thickness_nm=d, material=index(n))


def rectangle(d, cd, n, background=1):
    return Layer(thickness_nm=d, cd_nm=cd, material=index(n), background=index(background))


def stack(layers, *, angle=31, substrate=1.5, ambient=1, period=400):
    return Project(
        schema_version="1.1",
        period_nm=period,
        layers=layers,
        ambient=index(ambient),
        substrate=index(substrate),
        illumination={"wavelengths_nm": [450.0, 632.8, 850.0], "angle_deg": angle},
        solver={"harmonics": 7},
    )


def planar_tmm(wavelength, angle, n0, slabs, ns, pol):
    """Independent tangential-E 2x2 characteristic matrices, exp(-i wt)."""
    transverse = n0 * np.sin(np.deg2rad(angle))
    indices = np.array([n0, *[n for _, n in slabs], ns], dtype=complex)
    q = np.sqrt(indices**2 - transverse**2)
    admittance = q if pol == "s" else indices**2 / q
    matrix = np.eye(2, dtype=complex)
    for i, (thickness, _) in enumerate(slabs, 1):
        delta = 2 * np.pi * q[i] * thickness / wavelength
        c, s, y = np.cos(delta), np.sin(delta), admittance[i]
        matrix = matrix @ np.array([[c, -1j * s / y], [-1j * y * s, c]])
    b = matrix[0, 0] + matrix[0, 1] * admittance[-1]
    c = matrix[1, 0] + matrix[1, 1] * admittance[-1]
    denominator = admittance[0] * b + c
    r = (admittance[0] * b - c) / denominator
    t = 2 * admittance[0] / denominator
    return np.array([abs(r) ** 2, admittance[-1].real / admittance[0].real * abs(t) ** 2])


PLANAR_STACKS = [
    [(80, 2.1), (125, 1.3)],
    [(71, 2.1 + 0.13j), (123, 1.4 + 0.02j), (58, 2.5)],
    [(0, 2.1 + 0.13j), (121, 1.4 + 0.02j)],
    [(0, 2.1 + 0.13j), (0, 1.4 + 0.02j)],
    [(30 + j * 3, 1.4 + j * 0.11 + 0.01j) for j in range(8)],
]


@pytest.mark.parametrize("slabs", PLANAR_STACKS)
@pytest.mark.parametrize("angle", [0, 31, 67])
@pytest.mark.parametrize("substrate", [1.5, 3.5 + 0.1j, 0.25 + 5j])
@pytest.mark.parametrize("ambient", [1.0, 1.33])
def test_planar_multilayers_against_independent_tmm(slabs, angle, substrate, ambient):
    project = stack([film(d, n) for d, n in slabs], angle=angle, substrate=substrate, ambient=ambient)
    result = forward(project)
    validate_result("forward", result, project)
    for pol in ("s", "p"):
        actual = result["spectra"][pol]
        for wi, wavelength in enumerate(project.illumination.wavelengths_nm):
            expected = planar_tmm(wavelength, angle, ambient, slabs, substrate, pol)
            np.testing.assert_allclose([actual["R"][wi], actual["T"][wi]], expected, atol=2e-10, rtol=0)
            np.testing.assert_allclose(
                [actual["R_specular"][wi], actual["T_specular"][wi]], expected, atol=2e-10, rtol=0
            )


def order_powers(result):
    return np.array(
        [
            [[(order["R"], order["T"]) for order in orders] for orders in result["spectra"][pol]["orders"]]
            for pol in ("s", "p")
        ]
    )


@pytest.mark.parametrize("loss", [0.0, 0.1])
def test_identical_pattern_split_is_invariant(loss):
    original = stack([rectangle(160, 180, 2.1 + 1j * loss)], substrate=3.5 + 0.1j)
    split = stack([rectangle(60, 180, 2.1 + 1j * loss), rectangle(100, 180, 2.1 + 1j * loss)], substrate=3.5 + 0.1j)
    np.testing.assert_allclose(order_powers(forward(original)), order_powers(forward(split)), atol=2e-10, rtol=0)


def test_identical_film_split_is_invariant():
    original = stack([film(160, 2.1 + 0.1j)])
    split = stack([film(60, 2.1 + 0.1j), film(100, 2.1 + 0.1j)])
    np.testing.assert_allclose(order_powers(forward(original)), order_powers(forward(split)), atol=2e-10, rtol=0)


@pytest.mark.parametrize("position", [0, 1, 2])
def test_zero_thickness_insertion_is_invariant(position):
    original = stack([rectangle(95, 167, 2.4), film(110, 1.8 + 0.05j)])
    inserted = original.model_copy(deep=True)
    inserted.layers.insert(position, rectangle(0, 100, 3.5 + 0.3j, 1.2 + 0.04j))
    result = forward(inserted)
    np.testing.assert_allclose(order_powers(forward(original)), order_powers(result), atol=0, rtol=0)
    assert result["metadata"]["layer_count"] == 3
    assert result["metadata"]["active_slab_count"] == 2
    assert result["metadata"]["total_thickness_nm"] == 205
    validate_result("forward", result, inserted)


def test_all_zero_layers_skip_fourier_compiler_and_eigenproblem(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("A zero-volume stack must reduce directly to its interface")

    monkeypatch.setattr("meent.on_numpy.emsolver.convolution_matrix.to_conv_mat_vector", forbidden)
    monkeypatch.setattr("meent.on_numpy.emsolver.transfer_method.transfer_1d_2", forbidden)
    project = stack([film(0, 2 + 0.2j), rectangle(0, 140, 3.4 + 0.1j)], substrate=0.25 + 5j)
    result = forward(project)
    assert result["metadata"]["active_slab_count"] == 0
    assert result["metadata"]["max_lossless_flux_error"] < 1e-12
    validate_result("forward", result, project)


@pytest.mark.parametrize("cd", [0, 400])
def test_degenerate_rectangles_equal_homogeneous_layers_and_ignore_unused_loss(cd):
    used = 1.6
    ridge, background = (used, 2.4 + 0.1j) if cd else (2.4 + 0.1j, used)
    project = stack([rectangle(123, cd, ridge, background), rectangle(80, 147, 2.2)])
    equivalent = stack([film(123, used), rectangle(80, 147, 2.2)])
    result = forward(project)
    np.testing.assert_allclose(order_powers(result), order_powers(forward(equivalent)), atol=2e-10, rtol=0)
    assert result["metadata"]["max_lossless_flux_error"] is not None
    validate_result("forward", result, project)


def test_stack_order_changes_physics_and_preserves_input():
    project = stack([film(80, 2.1), film(125, 1.3)])
    original = project.model_dump()
    computed = forward(project)
    assert project.model_dump() == original
    reversed_project = project.model_copy(deep=True)
    reversed_project.layers.reverse()
    reversed_result = forward(reversed_project)
    assert np.max(abs(order_powers(computed) - order_powers(reversed_result))) > 0.01
    assert computed["metadata"]["stack_order"] == "top_to_bottom"
    for pol in ("s", "p"):
        for wi, wl in enumerate(project.illumination.wavelengths_nm):
            expected = planar_tmm(wl, 31, 1, [(125, 1.3), (80, 2.1)], 1.5, pol)
            actual = reversed_result["spectra"][pol]
            np.testing.assert_allclose([actual["R"][wi], actual["T"][wi]], expected, atol=2e-10, rtol=0)


def test_lower_layer_tabulated_dispersion_against_independent_tmm():
    project = stack([film(80, 2.1), film(125, 1.3)])
    project.layers[1].material = Material(
        kind="tabulated", wavelengths_nm=[400, 600, 900], n_values=[1.4, 1.6, 1.8], k_values=[0.02, 0.08, 0.14]
    )
    result = forward(project)
    for wi, wl in enumerate(project.illumination.wavelengths_nm):
        # Explicit independent linear evaluation of this known table.
        n = 1.4 + (wl - 400) * 0.2 / 200 if wl <= 600 else 1.6 + (wl - 600) * 0.2 / 300
        k = 0.02 + (wl - 400) * 0.06 / 200 if wl <= 600 else 0.08 + (wl - 600) * 0.06 / 300
        for pol in ("s", "p"):
            expected = planar_tmm(wl, 31, 1, [(80, 2.1), (125, n + 1j * k)], 1.5, pol)
            actual = result["spectra"][pol]
            np.testing.assert_allclose([actual["R"][wi], actual["T"][wi]], expected, atol=2e-10, rtol=0)
    assert result["metadata"]["max_lossless_flux_error"] is None
    validate_result("forward", result, project)


def test_lower_layer_loss_uses_finite_stack_balance_even_with_absorbing_substrate():
    project = stack([rectangle(95, 167, 2.4), film(110, 1.8 + 0.05j)], substrate=3.5 + 0.1j)
    result = forward(project)
    for series in result["spectra"].values():
        assert min(series["A_balance"]) > 0.01
        np.testing.assert_allclose(series["A_balance"], 1 - np.array(series["R"]) - series["T"], atol=0, rtol=0)
        assert all(
            order["transmission_class"] == "absorbing_half_space" for orders in series["orders"] for order in orders
        )
    assert result["metadata"]["max_lossless_flux_error"] is None
    validate_result("forward", result, project)


def test_fourier_cells_have_exact_boundaries_and_top_to_bottom_order():
    project = stack([rectangle(95, 167, 2.4), film(110, 1.8 + 0.05j), rectangle(0, 100, 3.5)])
    cells, thicknesses = stack_cells(project, 632.8)
    assert thicknesses == [95, 110]
    assert len(cells) == 2
    np.testing.assert_array_equal(cells[0][1][:, 0], [116.5, 283.5, 400])
    np.testing.assert_array_equal(cells[1][0], [[1.8 - 0.05j]])
    assert all(array.dtype == np.complex128 for cell in cells for array in cell)


def test_harmonic_refinement_is_separate_from_run_certification():
    project = stack([rectangle(95, 167, 2.4), rectangle(130, 247, 1.8, 1.1)])
    results = []
    for h in (3, 7, 11, 15, 19):
        project.solver.harmonics = h
        result = forward(project)
        assert result["metadata"]["convergence_checked"] is False
        assert any("not certified" in notice for notice in result["warnings"])
        results.append(np.concatenate([result["spectra"][p][key] for p in ("s", "p") for key in ("R", "T")]))
    assert np.max(abs(results[-1] - results[-2])) < np.max(abs(results[1] - results[0]))


def test_exact_internal_homogeneous_modal_cutoff_in_a_uniform_stack_is_solved_exactly():
    # m=1 is exactly tangent inside n=1.5, while both external ports are away
    # from Rayleigh cutoffs. A uniform stack couples only the specular order, so
    # it is solved alone and the singular modal inverse never arises.
    from rcwa_core.preflight import preflight_project

    project = stack([film(100, 1.5), film(80, 1.3)], angle=0, substrate=1.7)
    project.illumination.wavelengths_nm = [600.0]
    assert preflight_project(project) == []
    result = forward(project)
    for pol in ("s", "p"):
        actual = result["spectra"][pol]
        expected = planar_tmm(600, 0, 1, [(100, 1.5), (80, 1.3)], 1.7, pol)
        np.testing.assert_allclose([actual["R"][0], actual["T"][0]], expected, atol=2e-10, rtol=0)


@pytest.mark.parametrize("offset", [-1e-6, 1e-6])
def test_near_internal_homogeneous_modal_cutoff_matches_planar_reference(offset):
    n = 1.5 + offset
    project = stack([film(100, n), film(80, 1.3)], angle=0, substrate=1.7)
    project.illumination.wavelengths_nm = [600.0]
    result = forward(project)
    for pol in ("s", "p"):
        actual = result["spectra"][pol]
        expected = planar_tmm(600, 0, 1, [(100, n), (80, 1.3)], 1.7, pol)
        np.testing.assert_allclose([actual["R"][0], actual["T"][0]], expected, atol=2e-10, rtol=0)


def test_maximum_bounded_stack_produces_finite_outputs():
    project = stack(
        [rectangle(100 + 13 * j, 100 + 27 * j, 2 + 0.13 * j + 0.02j, 1 + 0.03 * j) for j in range(8)],
        substrate=3.5 + 0.1j,
    )
    project.solver.harmonics = 20
    project.illumination.wavelengths_nm = np.linspace(450, 850, 81).tolist()
    result = forward(project)
    assert order_powers(result).shape == (2, 81, 41, 2)
    assert np.isfinite(order_powers(result)).all()
    assert result["metadata"]["active_slab_count"] == 8
    assert result["metadata"]["convergence_checked"] is False
    validate_result("forward", result, project)


def test_multilayer_total_internal_reflection_against_planar_tmm():
    project = stack([film(80, 1.2), film(125, 1.8)], angle=67, ambient=1.5, substrate=1.0)
    result = forward(project)
    for pol in ("s", "p"):
        for wi, wl in enumerate(project.illumination.wavelengths_nm):
            expected = planar_tmm(wl, 67, 1.5, [(80, 1.2), (125, 1.8)], 1.0, pol)
            actual = result["spectra"][pol]
            np.testing.assert_allclose([actual["R"][wi], actual["T"][wi]], expected, atol=2e-10, rtol=0)


@pytest.mark.parametrize("r,t", [(float("nan"), 0.0), (-0.01, 0.9), (0.6, 0.6)])
def test_invalid_stack_powers_fail_without_clipping(monkeypatch, r, t):
    from rcwa_core.solver import SolverError

    def invalid(kx, *args, **kwargs):
        reflected, transmitted = np.zeros(len(kx)), np.zeros(len(kx))
        reflected[len(kx) // 2], transmitted[len(kx) // 2] = r, t
        return {"res": {"de_ri": reflected, "de_ti": transmitted}}

    monkeypatch.setattr("rcwa_core.solver._solve_with_ports", invalid)
    with pytest.raises(SolverError):
        forward(stack([rectangle(95, 167, 2.4), film(110, 1.8)]))


def test_fourier_singularity_is_an_explicit_numerical_failure(monkeypatch):
    from rcwa_core.solver import SolverError

    def singular(*args, **kwargs):
        assert kwargs["use_pinv"] is False
        raise np.linalg.LinAlgError("Singular matrix")

    monkeypatch.setattr("meent.on_numpy.emsolver.convolution_matrix.to_conv_mat_vector", singular)
    with pytest.raises(SolverError, match="Fourier compilation failed"):
        forward(stack([rectangle(95, 167, 2.4), film(110, 1.8)]))
