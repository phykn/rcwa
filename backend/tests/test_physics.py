"""Power-observable validation, independent analytic references, and scope guards.

These tests validate the numerical prototype, not measured-sample accuracy.
"""

import copy

import numpy as np
import pytest
from pydantic import ValidationError

from rcwa_core.schemas import Material, Project
from rcwa_core.solver import SolverError, forward, rectangle_cell, refractive_index


def project_at(wavelengths=(532.0, 632.8, 780.0), angle=0, cd=230.0, height=137.0, n=2.1, k=0.0):
    return Project.model_validate(
        {
            "period_nm": 230.0,
            "layers": [{"cd_nm": cd, "thickness_nm": height, "material": {"n": n, "k": k}}],
            "illumination": {"wavelengths_nm": list(wavelengths), "angle_deg": angle, "polarization": "both"},
            "solver": {"harmonics": 5},
        }
    )


def analytic_film(wavelength, angle, n0, nf, ns, thickness, pol):
    """Independent Airy/Fresnel equations; exp(-i wt), n+i*k, tangential E basis."""
    transverse = n0 * np.sin(np.deg2rad(angle))
    q = np.sqrt(np.asarray([n0, nf, ns], complex) ** 2 - transverse**2)
    admittance = q if pol == "s" else np.asarray([n0, nf, ns], complex) ** 2 / q
    y0, yf, ys = admittance
    r01, r12 = (y0 - yf) / (y0 + yf), (yf - ys) / (yf + ys)
    t01, t12 = 2 * y0 / (y0 + yf), 2 * yf / (yf + ys)
    phase = np.exp(2j * np.pi * q[1] * thickness / wavelength)
    denominator = 1 + r01 * r12 * phase**2
    r = (r01 + r12 * phase**2) / denominator
    t = t01 * t12 * phase / denominator
    return abs(r) ** 2, (ys.real / y0.real) * abs(t) ** 2


@pytest.mark.parametrize("angle", [0, 31, 67])
@pytest.mark.parametrize("height,k", [(0.0, 0.0), (137.0, 0.0), (137.0, 0.2), (1500.0, 0.8)])
def test_planar_film_against_independent_airy(angle, height, k):
    project = project_at(angle=angle, height=height, k=k)
    result = forward(project)
    for pol in ("s", "p"):
        expected = [
            analytic_film(w, angle, 1.0, complex(2.1, k), 1.5, height, pol) for w in project.illumination.wavelengths_nm
        ]
        np.testing.assert_allclose(result["spectra"][pol]["R"], np.array(expected)[:, 0], atol=2e-10, rtol=2e-10)
        np.testing.assert_allclose(result["spectra"][pol]["T"], np.array(expected)[:, 1], atol=2e-10, rtol=2e-10)
        np.testing.assert_allclose(result["spectra"][pol]["R"], result["spectra"][pol]["R_specular"], atol=2e-10)


def test_identity_medium():
    project = project_at(n=1.0)
    project.substrate.n = 1.0
    result = forward(project)
    for series in result["spectra"].values():
        np.testing.assert_allclose(series["R"], 0, atol=1e-12)
        np.testing.assert_allclose(series["T"], 1, atol=1e-12)


def test_brewster_angle_and_total_internal_reflection():
    brewster = project_at(angle=np.rad2deg(np.arctan(1.5)), height=0)
    assert max(forward(brewster)["spectra"]["p"]["R"]) < 1e-12
    tir = project_at(angle=55, height=0)
    tir.ambient.n, tir.substrate.n = 1.5, 1.0
    for series in forward(tir)["spectra"].values():
        np.testing.assert_allclose(series["R"], 1, atol=1e-12)
        np.testing.assert_allclose(series["T"], 0, atol=1e-12)


@pytest.mark.parametrize("loss", [0, 0.15])
def test_patterned_diffraction_powers_and_passivity(loss):
    project = Project.model_validate(
        {
            "period_nm": 780,
            "layers": [{"cd_nm": 320, "thickness_nm": 190, "material": {"n": 2.4, "k": loss}}],
            "illumination": {"wavelengths_nm": [450, 520, 670], "angle_deg": 12},
            "solver": {"harmonics": 11},
        }
    )
    result = forward(project)
    for series in result["spectra"].values():
        assert min(series["A_balance"]) >= -1e-9
        if not loss:
            np.testing.assert_allclose(np.array(series["R"]) + series["T"], 1, atol=1e-9)
        assert any(total > zero + 1e-3 for total, zero in zip(series["T"], series["T_specular"]))
        for wi, orders in enumerate(series["orders"]):
            assert [order["m"] for order in orders] == list(range(-11, 12))
            assert sum(order["R"] for order in orders) == pytest.approx(series["R"][wi])
            assert sum(order["T"] for order in orders) == pytest.approx(series["T"][wi])
            for order in orders:
                if not order["reflection_propagating"]:
                    assert abs(order["R"]) < 1e-12
                if not order["transmission_propagating"]:
                    assert abs(order["T"]) < 1e-12


def test_exact_rectangle_geometry_and_topology_limits():
    project = Project()
    values, ends, _ = rectangle_cell(project, 2.1, 1.0)[0]
    np.testing.assert_allclose(ends[:, 0], [110, 290, 400])
    np.testing.assert_allclose(values, [[1, 2.1, 1]])
    for cd, material in [(0, 1.0), (400, 2.1)]:
        project.layers[0].cd_nm = cd
        values, ends, _ = rectangle_cell(project, 2.1, 1.0)[0]
        np.testing.assert_allclose(values, [[material]])
        np.testing.assert_allclose(ends, [[400]])
    p0 = project_at(cd=0)
    reference = project_at(n=1)
    for pol in ("s", "p"):
        np.testing.assert_allclose(
            forward(p0)["spectra"][pol]["R"], forward(reference)["spectra"][pol]["R"], atol=1e-12
        )


def test_harmonic_refinement_sequence():
    project = Project()
    project.illumination.wavelengths_nm = [510, 650, 810]
    results = []
    for harmonics in [3, 7, 11, 15, 19]:
        project.solver.harmonics = harmonics
        result = forward(project)
        results.append(np.concatenate([result["spectra"][pol]["R"] for pol in ("s", "p")]))
    assert np.max(abs(results[-1] - results[-2])) < 3e-4
    assert np.max(abs(results[-1] - results[-2])) < np.max(abs(results[1] - results[0]))


def test_scale_invariance_and_fresh_repeated_evaluations():
    project = Project()
    project.illumination.wavelengths_nm = [510, 650, 810]
    before = forward(project)
    different = project.model_copy(deep=True)
    different.layers[0].cd_nm += 5
    assert forward(different)["spectra"] != before["spectra"]
    assert forward(project)["spectra"] == before["spectra"]
    scaled = project.model_copy(deep=True)
    scaled.period_nm *= 1.2
    scaled.layers[0].cd_nm *= 1.2
    scaled.layers[0].thickness_nm *= 1.2
    scaled.illumination.wavelengths_nm = [w * 1.2 for w in scaled.illumination.wavelengths_nm]
    after = forward(scaled)
    for pol in ("s", "p"):
        np.testing.assert_allclose(after["spectra"][pol]["R"], before["spectra"][pol]["R"], atol=1e-11)


def test_material_interpolation_and_no_extrapolation():
    material = Material(kind="tabulated", wavelengths_nm=[400, 800], n_values=[2, 3], k_values=[0.1, 0.3])
    assert refractive_index(material, 600) == pytest.approx(2.5 + 0.2j)
    with pytest.raises(SolverError, match="extrapolation"):
        refractive_index(material, 900)
    value = Project().model_dump()
    value["layers"][0]["material"] = material.model_dump()
    with pytest.raises(ValidationError, match="extrapolation"):
        Project.model_validate(value)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda p: p["layers"].append(copy.deepcopy(p["layers"][0])),
        lambda p: p["layers"][0].update(cd_nm=401),
        lambda p: p["ambient"].update(k=0.1),
        lambda p: p["solver"].update(harmonics=21),
        lambda p: p["illumination"].update(wavelengths_nm=[600, 500]),
        lambda p: p["layers"][0]["material"].update(n=float("nan")),
        lambda p: p["layers"][0].update(geometry="trapezoid"),
    ],
)
def test_unsupported_inputs_fail(mutation):
    data = Project().model_dump()
    mutation(data)
    with pytest.raises(ValidationError):
        Project.model_validate(data)


def test_cutoff_and_missing_propagating_orders_fail():
    project = Project()
    project.illumination.angle_deg = 0
    project.illumination.wavelengths_nm = [600]
    with pytest.raises(SolverError, match="cutoff"):
        forward(project)
    project.period_nm = 4000
    project.illumination.wavelengths_nm = [450]
    project.solver.harmonics = 1
    with pytest.raises(SolverError, match="propagating"):
        forward(project)


def test_cd_sensitivity_is_stable_across_step_sizes():
    project = Project()
    project.illumination.wavelengths_nm = [510, 650, 810]
    derivatives = []
    for step in [0.2, 0.05, 0.01]:
        low, high = project.model_copy(deep=True), project.model_copy(deep=True)
        low.layers[0].cd_nm -= step
        high.layers[0].cd_nm += step
        r_low, r_high = forward(low), forward(high)
        derivatives.append(
            np.concatenate(
                [
                    (np.array(r_high["spectra"][pol]["R_specular"]) - r_low["spectra"][pol]["R_specular"]) / (2 * step)
                    for pol in ("s", "p")
                ]
            )
        )
    assert np.linalg.norm(derivatives[-1]) > 1e-4
    np.testing.assert_allclose(derivatives[0], derivatives[-1], rtol=3e-4, atol=1e-7)


def test_synthetic_cd_recovery_and_no_input_mutation():
    from rcwa_core.fitting import fit_cd

    project = Project()
    project.illumination.wavelengths_nm = [470, 530, 610, 710, 830]
    before = project.model_dump()
    result = fit_cd(project, {"target_cd_nm": 207, "lower_cd_nm": 80, "upper_cd_nm": 300})
    assert result["status"] == "converged"
    assert result["fit_cd_nm"] == pytest.approx(207, abs=0.001)
    assert result["rmse"] < 1e-7
    assert len(result["diagnostics"]["starts"]) == 3
    assert project.model_dump() == before
    assert "inverse-crime" in result["warnings"][0]


def test_synthetic_fit_rejects_flat_response():
    from rcwa_core.fitting import fit_cd

    project = Project()
    project.layers[0].material.n = 1
    project.illumination.wavelengths_nm = [470, 530, 610, 710, 830]
    with pytest.raises(SolverError, match="sensitivity"):
        fit_cd(project, {"target_cd_nm": 207, "lower_cd_nm": 80, "upper_cd_nm": 300})


@pytest.mark.parametrize("angle", [0, 31, 67])
@pytest.mark.parametrize("substrate", [3.5 + 0.1j, 0.8 + 2j])
@pytest.mark.parametrize("height,k", [(0.0, 0.0), (137.0, 0.2)])
def test_absorbing_substrate_against_airy(angle, substrate, height, k):
    project = project_at(angle=angle, height=height, k=k)
    project.substrate.n, project.substrate.k = substrate.real, substrate.imag
    result = forward(project)
    for pol in ("s", "p"):
        expected = [
            analytic_film(w, angle, 1.0, complex(2.1, k), substrate, height, pol)
            for w in project.illumination.wavelengths_nm
        ]
        np.testing.assert_allclose(result["spectra"][pol]["R"], np.array(expected)[:, 0], atol=2e-10, rtol=2e-10)
        np.testing.assert_allclose(result["spectra"][pol]["T"], np.array(expected)[:, 1], atol=2e-10, rtol=2e-10)
        assert result["spectra"][pol]["orders"][0][0]["transmission_propagating"] is None
