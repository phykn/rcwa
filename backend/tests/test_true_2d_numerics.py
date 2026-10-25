"""Actual new coupled adapter: analytic reductions, invariants and failures."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from rcwa_core.contracts_2d import validate_result_2d
from rcwa_core.preflight import PreflightError, SolverError
from rcwa_core.preflight_2d import active_materials_2d, preflight_2d
from rcwa_core.schemas import HomogeneousLayer, Layer, Material, Project
from rcwa_core.schemas_2d import CircularHole2D, Project2D, Rectangle2D
from rcwa_core.solver import forward
from rcwa_core.solver_2d import forward_2d, input_hash_2d, stack_cells_2d
from test_stack_physics import planar_tmm


def material(n):
    return Material(n=complex(n).real, k=complex(n).imag)


def film(d, n):
    return HomogeneousLayer(thickness_nm=d, material=material(n))


def rect(d=90, wx=220, wy=180, n=1.65, bg=1.45):
    return Rectangle2D(thickness_nm=d, cd_x_nm=wx, cd_y_nm=wy, material=material(n), background=material(bg))


def project(layers=None, *, theta=20, phi=25, n0=1, ns=1.5, hx=2, hy=3, wavelengths=(450, 632.8, 850)):
    return Project2D(
        schema_version="1.2",
        period_nm=460,
        period_y_nm=420,
        ambient=material(n0),
        substrate=material(ns),
        layers=layers or [rect()],
        illumination={"wavelengths_nm": list(wavelengths), "angle_deg": theta, "azimuth_deg": phi},
        solver={"harmonics_x": hx, "harmonics_y": hy},
    )


def powers(result):
    return np.array(
        [
            [[[o[k] for k in ("R_s", "R_p", "T_s", "T_p")] for o in rows] for rows in result["spectra"][p]["orders"]]
            for p in ("s", "p")
        ]
    )


@pytest.mark.parametrize("n0", [1, 1.33])
@pytest.mark.parametrize("ns", [1.5, 3.5 + 0.1j, 0.25 + 5j])
@pytest.mark.parametrize("theta", [0, 31, 67])
@pytest.mark.parametrize("phi", [0, 45, 90, 225])
@pytest.mark.parametrize(
    "slabs",
    [
        [(80, 2.1), (125, 1.3)],
        [(70, 2.1 + 0.13j), (123, 1.4 + 0.02j)],
        [(0, 2.1 + 0.13j), (0, 1.4)],
        [(30 + j * 3, 1.4 + j * 0.11 + 0.01j) for j in range(8)],
    ],
)
def test_planar_tmm_all_ports_axes_and_eight_layers(n0, ns, theta, phi, slabs):
    p = project([film(d, n) for d, n in slabs], n0=n0, ns=ns, theta=theta, phi=phi, hx=1, hy=2, wavelengths=(632.8,))
    r = forward_2d(p)
    validate_result_2d(r, p)
    for pol in ("s", "p"):
        s = r["spectra"][pol]
        np.testing.assert_allclose(
            [s["R"][0], s["T"][0]], planar_tmm(632.8, theta, n0, slabs, ns, pol), atol=2e-10, rtol=0
        )
        for o in s["orders"][0]:
            if o["m"] or o["n"]:
                assert max(o["R"], o["T"]) < 1e-10
            assert o["R_p" if pol == "s" else "R_s"] < 1e-10
            assert o["T_p" if pol == "s" else "T_s"] < 1e-10


@pytest.mark.parametrize("axis", ["x", "y"])
@pytest.mark.parametrize("theta", [0, 31, 67])
@pytest.mark.parametrize("ns", [1.5, 0.25 + 5j])
def test_actual_2d_reduces_to_legacy_1d_both_axes(axis, theta, ns):
    layers = [rect(95, 220, 420, 2.2), film(80, 1.4), rect(65, 310, 420, 1.8 + 0.03j)]
    p = project(layers, theta=theta, phi=0 if axis == "x" else 90, n0=1.33, ns=ns, hx=3, hy=3)
    period = p.period_nm if axis == "x" else p.period_y_nm
    if axis == "y":
        p.layers[0].cd_x_nm, p.layers[0].cd_y_nm = p.period_nm, 220
        p.layers[2].cd_x_nm, p.layers[2].cd_y_nm = p.period_nm, 310
    old_layers = [
        Layer(thickness_nm=95, cd_nm=220, material=material(2.2), background=material(1.45)),
        film(80, 1.4),
        Layer(thickness_nm=65, cd_nm=310, material=material(1.8 + 0.03j), background=material(1.45)),
    ]
    old = Project(
        schema_version="1.1",
        period_nm=period,
        layers=old_layers,
        ambient=material(1.33),
        substrate=material(ns),
        illumination={"angle_deg": theta, "wavelengths_nm": [450, 632.8, 850]},
        solver={"harmonics": 3},
    )
    a, b = forward_2d(p), forward(old)
    for pol in ("s", "p"):
        for wi, rows in enumerate(a["spectra"][pol]["orders"]):
            reference = {o["m"]: o for o in b["spectra"][pol]["orders"][wi]}
            for o in rows:
                varying, forbidden = (o["m"], o["n"]) if axis == "x" else (o["n"], o["m"])
                if forbidden:
                    assert max(o["R"], o["T"]) < 1e-10
                else:
                    np.testing.assert_allclose(
                        [o["R"], o["T"]], [reference[varying]["R"], reference[varying]["T"]], atol=1e-9, rtol=0
                    )


@pytest.mark.parametrize("transform", ["mirror_x", "mirror_y", "rotate180"])
def test_exact_centered_mirror_and_180_symmetries(transform):
    p = project(
        [rect(), film(80, 2.1), rect(75, 290, 240, 1.45 + 0.01j, 1.6)], n0=1.33, ns=0.4 + 3.1j, wavelengths=(632.8,)
    )
    q = p.model_copy(deep=True)
    phi = p.illumination.azimuth_deg
    q.illumination.azimuth_deg = {
        "mirror_x": (180 - phi) % 360,
        "mirror_y": (-phi) % 360,
        "rotate180": (phi + 180) % 360,
    }[transform]
    a, b = forward_2d(p), forward_2d(q)
    for pol in ("s", "p"):
        bmap = {(o["m"], o["n"]): o for o in b["spectra"][pol]["orders"][0]}
        for o in a["spectra"][pol]["orders"][0]:
            label = (-o["m"] if transform != "mirror_y" else o["m"], -o["n"] if transform != "mirror_x" else o["n"])
            np.testing.assert_allclose(
                [o[k] for k in ("R_s", "R_p", "T_s", "T_p")],
                [bmap[label][k] for k in ("R_s", "R_p", "T_s", "T_p")],
                atol=1e-9,
                rtol=0,
            )


@pytest.mark.parametrize("phi", [0, 45, 90, 180, 270])
def test_normal_incidence_keeps_requested_reference_axis(phi):
    p = project(theta=0, phi=phi, wavelengths=(632.8,))
    r = forward_2d(p)
    validate_result_2d(r, p)
    zero = r["spectra"]["s"]["orders"][0][r["metadata"]["basis_size"] // 2]
    assert zero["kx_over_k0"] == zero["ky_over_k0"] == 0
    assert r["metadata"]["convergence_checked"] is False


@pytest.mark.parametrize("wx,wy", [(0, 180), (220, 0), (0, 0), (460, 420)])
def test_homogeneous_degeneracies_ignore_unoccupied_loss(wx, wy):
    used = 1.6
    inclusion, background = (used, 2.2 + 0.1j) if wx and wy else (2.2 + 0.1j, used)
    p = project([rect(90, wx, wy, inclusion, background)], wavelengths=(632.8,))
    q = project([film(90, used)], wavelengths=(632.8,))
    np.testing.assert_allclose(powers(forward_2d(p)), powers(forward_2d(q)), atol=2e-10, rtol=0)
    assert [m.k for m in active_materials_2d(p)] == [0]


def test_cells_exact_boundaries_split_zero_and_equal_regions():
    p = project([rect(90, 221, 181, 1.65 + 0.03j), film(80, 2.1)], wavelengths=(632.8,))
    cells, heights = stack_cells_2d(p, 632.8)
    np.testing.assert_array_equal(cells[0][1].ravel(), [119.5, 340.5, 460])
    np.testing.assert_array_equal(cells[0][2].ravel(), [119.5, 300.5, 420])
    assert cells[0][0][1, 1] == 1.65 - 0.03j and heights == [90, 80]
    q = p.model_copy(deep=True)
    q.layers[0].thickness_nm = 40
    q.layers.insert(1, rect(50, 221, 181, 1.65 + 0.03j))
    q.layers.insert(2, rect(0, 100, 150, 3 + 0.5j))
    np.testing.assert_allclose(powers(forward_2d(p)), powers(forward_2d(q)), atol=2e-10, rtol=0)
    a, b = project([rect(n=1.5, bg=1.5)], wavelengths=(632.8,)), project([film(90, 1.5)], wavelengths=(632.8,))
    np.testing.assert_allclose(powers(forward_2d(a)), powers(forward_2d(b)), atol=2e-10, rtol=0)


def test_mixed_1d_2d_holes_pillars_lower_loss_and_stack_reversal():
    p = project(
        [rect(), Layer(thickness_nm=80, cd_nm=170, material=material(1.8)), rect(90, 290, 240, 1.45, 1.6 + 0.03j)],
        wavelengths=(632.8,),
    )
    r = forward_2d(p)
    validate_result_2d(r, p)
    assert min(s["A_balance"][0] for s in r["spectra"].values()) > 0.001
    q = p.model_copy(deep=True)
    q.layers.reverse()
    assert np.max(abs(powers(r) - powers(forward_2d(q)))) > 1e-4


def test_all_zero_bypasses_fourier_and_eigensolver(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("No zero-volume eigensolve")

    monkeypatch.setattr("meent.on_numpy.emsolver.convolution_matrix.to_conv_mat_vector", forbidden)
    monkeypatch.setattr("meent.on_numpy.emsolver.transfer_method.transfer_2d_2", forbidden)
    p = project([rect(0), film(0, 2)], ns=0.25 + 5j, wavelengths=(632.8,))
    validate_result_2d(forward_2d(p), p)


def test_external_cutoffs_near_cutoffs_and_missing_full_light_cone():
    p = project(theta=0, phi=0, wavelengths=(460,), ns=1.7)
    assert "rayleigh_cutoff" in [d.code for d in preflight_2d(p)]
    with pytest.raises(PreflightError):
        forward_2d(p)
    p.illumination.wavelengths_nm = [460.001]
    assert "near_rayleigh_cutoff" in [d.code for d in preflight_2d(p)]
    p.period_nm, p.period_y_nm = 1800, 1700
    p.illumination.angle_deg, p.illumination.azimuth_deg = 37, 45
    p.illumination.wavelengths_nm = [632.8]
    assert "insufficient_harmonics" in [d.code for d in preflight_2d(p)]
    # Only y omitted: legacy x-edge checks would miss this case.
    p.period_nm, p.period_y_nm = 300, 1700
    assert "insufficient_harmonics" in [d.code for d in preflight_2d(p)]


@pytest.mark.parametrize("k", [0.0, 1e-12, 1e-4, 0.1])
def test_substrate_absorption_does_not_hide_its_open_2d_orders(k):
    p = project(ns=complex(3.6, k), hx=1, hy=1, wavelengths=(632.8,))
    assert "insufficient_harmonics" in [d.code for d in preflight_2d(p)]
    p.substrate = material(0.2 + 3.5j)
    assert "insufficient_harmonics" not in [d.code for d in preflight_2d(p)]


def test_exact_internal_cutoff_in_uniform_stack_is_solved_exactly():
    # wavelength / Px = 1.5: orders (±1, 0) graze inside the film. A uniform stack
    # couples only the specular order, so it is solved alone, without perturbation.
    p = project([film(100, 1.5)], theta=0, phi=0, ns=1.7, wavelengths=(690,))
    assert preflight_2d(p) == []
    r = forward_2d(p)
    for pol in ("s", "p"):
        np.testing.assert_allclose(
            [r["spectra"][pol][k][0] for k in ("R", "T")], planar_tmm(690, 0, 1, [(100, 1.5)], 1.7, pol), atol=2e-10, rtol=0
        )


@pytest.mark.parametrize(
    "uniform", [film(100, 1.5), rect(100, 0, 180, n=2.0, bg=1.5), rect(100, 460, 420, n=1.5), rect(100, n=1.5, bg=1.5)]
)
def test_exact_internal_cutoff_in_a_uniform_slab_of_a_patterned_stack_is_rejected(uniform):
    # Orders (±1, 0) graze inside the uniform slab, where the eigenproblem is singular.
    p = project([rect(), uniform], theta=0, phi=0, ns=1.7, wavelengths=(690,))
    assert [(d.code, d.severity) for d in preflight_2d(p)] == [("rayleigh_cutoff", "error")]
    with pytest.raises(PreflightError, match="grazes inside a uniform layer"):
        forward_2d(p)


@pytest.mark.parametrize("offset", [-1e-6, 1e-6])
def test_near_internal_cutoff_planar_reference(offset):
    p = project([film(100, 1.5 + offset)], theta=0, phi=0, ns=1.7, wavelengths=(690,))
    r = forward_2d(p)
    for pol in ("s", "p"):
        np.testing.assert_allclose(
            [r["spectra"][pol][k][0] for k in ("R", "T")],
            planar_tmm(690, 0, 1, [(100, 1.5 + offset)], 1.7, pol),
            atol=2e-10,
            rtol=0,
        )


@pytest.mark.parametrize("field,value", [("harmonics_x", 6), ("harmonics_y", 0), ("harmonics_x", True)])
def test_provisional_bounded_schema(field, value):
    p = project().model_dump()
    p["solver"][field] = value
    with pytest.raises(ValidationError):
        Project2D.model_validate(p)


def test_schema_and_material_coverage_boundaries():
    p = project().model_dump()
    with pytest.raises(ValidationError):
        Project.model_validate(p)  # No silent public API expansion.
    no_version = deepcopy(p)
    del no_version["schema_version"]
    with pytest.raises(ValidationError):
        Project2D.model_validate(no_version)
    for changes in ({"cd_x_nm": 461}, {"cd_y_nm": 421}):
        q = deepcopy(p)
        q["layers"][0].update(changes)
        with pytest.raises(ValidationError):
            Project2D.model_validate(q)
    p["layers"][0]["thickness_nm"] = 0
    p["layers"][0]["background"] = {
        "kind": "tabulated",
        "wavelengths_nm": [500, 700],
        "n_values": [1.4, 1.5],
        "k_values": [0, 0],
    }
    with pytest.raises(ValidationError, match="extrapolation"):
        Project2D.model_validate(p)  # Unoccupied regions still require coverage.


@pytest.mark.parametrize(
    "tamper",
    [
        "channel",
        "label",
        "wavevector",
        "geometry_hash",
        "basis",
        "classification",
        "convergence",
        "total",
        "factorization",
        "extra",
    ],
)
def test_result_rejects_tampering(tamper):
    p = project(wavelengths=(632.8,))
    r = forward_2d(p)
    zero = r["spectra"]["s"]["orders"][0][r["metadata"]["basis_size"] // 2]
    if tamper == "channel":
        zero["R_s"] += 0.01
    elif tamper == "label":
        zero["n"] = 1
    elif tamper == "wavevector":
        zero["ky_over_k0"] += 0.01
    elif tamper == "geometry_hash":
        p.layers[0].cd_y_nm += 1
    elif tamper == "basis":
        r["metadata"]["harmonics_y"] += 1
    elif tamper == "classification":
        zero["transmission_class"], zero["transmission_propagating"] = "absorbing_half_space", None
    elif tamper == "convergence":
        r["metadata"]["convergence_checked"] = True
    elif tamper == "total":
        r["spectra"]["s"]["R"][0] += 0.01
    elif tamper == "factorization":
        r["metadata"]["factorization"] = "diagnostic_laurent"
    else:
        r["extra"] = 1
    with pytest.raises(ValueError):
        validate_result_2d(r, p)


@pytest.mark.parametrize("value", [float("nan"), -0.01, 0.8])
def test_invalid_raw_channels_fail_without_clipping(monkeypatch, value):
    def bad(kx, ky, *args, **kwargs):
        a = np.zeros((len(ky), len(kx)))
        a[len(ky) // 2, len(kx) // 2] = value
        raw = {key: a for key in ("de_ri_s", "de_ri_p", "de_ti_s", "de_ti_p")}
        return {"res_te_inc": raw, "res_tm_inc": raw}

    monkeypatch.setattr("rcwa_core.solver_2d._solve_2d_with_ports", bad)
    with pytest.raises(SolverError):
        forward_2d(project(wavelengths=(632.8,)))


def test_frozen_legacy_normalization_hashes_and_power_arrays_unchanged():
    fixture = json.loads((Path(__file__).parent / "fixtures/true-2d/legacy-frozen.json").read_text())
    for case in fixture["cases"]:
        p = Project.model_validate(case["raw"])
        canonical = json.dumps(p.model_dump(), sort_keys=True, separators=(",", ":"), allow_nan=False)
        assert p.model_dump() == case["normalized"]
        assert canonical == case["canonical_json"]
        assert hashlib.sha256(canonical.encode()).hexdigest() == case["sha256"]
        actual = forward(p)["spectra"]
        for pol in actual:
            for key in ("R", "T", "R_specular", "T_specular", "A_balance"):
                np.testing.assert_allclose(actual[pol][key], case["spectra"][pol][key], atol=2e-12, rtol=0)
            for rows, frozen_rows in zip(actual[pol]["orders"], case["spectra"][pol]["orders"]):
                for order, frozen in zip(rows, frozen_rows):
                    assert order.keys() == frozen.keys()
                    for field in order:
                        if field in ("R", "T", "kx_over_k0"):
                            assert abs(order[field] - frozen[field]) < 2e-12
                        else:
                            assert order[field] == frozen[field]


def test_editing_y_changes_exact_input_hash_and_real_spectrum():
    p = project(wavelengths=(632.8,))
    q = p.model_copy(deep=True)
    q.layers[0].cd_y_nm += 40
    assert input_hash_2d(p) != input_hash_2d(q)
    assert np.max(abs(powers(forward_2d(p)) - powers(forward_2d(q)))) > 1e-5


def test_xy_transpose_is_an_exact_symmetry_at_every_basis():
    p = project([rect(110, 220, 180, 2.2, 1), film(80, 1.45), rect(130, 290, 240, 1.9, 1)], wavelengths=(632.8,))
    q = p.model_copy(deep=True)
    q.period_nm, q.period_y_nm = p.period_y_nm, p.period_nm
    q.illumination.azimuth_deg = 90 - p.illumination.azimuth_deg
    for layer in q.layers:
        if layer.geometry == "rectangle_2d":
            layer.cd_x_nm, layer.cd_y_nm = layer.cd_y_nm, layer.cd_x_nm
    for h in (1, 2, 3):
        p.solver.harmonics_x = p.solver.harmonics_y = h
        q.solver.harmonics_x = q.solver.harmonics_y = h
        a, b = forward_2d(p), forward_2d(q)
        for pol in ("s", "p"):
            mapped = {(o["m"], o["n"]): o for o in b["spectra"][pol]["orders"][0]}
            for order in a["spectra"][pol]["orders"][0]:
                # Mirroring x and y swaps the local s/p basis sign only, so powers map exactly.
                for key in ("R_s", "R_p", "T_s", "T_p"):
                    assert abs(order[key] - mapped[(order["n"], order["m"])][key]) < 1e-11


def square_cell(layer):
    p = project([layer], theta=0, phi=0, ns=1.45, hx=5, hy=5, wavelengths=(633,))
    p.period_y_nm = p.period_nm = 400
    return Project2D.model_validate(p.model_dump())


def polarization_gap(result):
    return max(abs(result["spectra"]["s"][key][0] - result["spectra"]["p"][key][0]) for key in ("R", "T"))


def test_square_rectangle_at_normal_incidence_is_polarization_independent():
    """C4 symmetry: E along x and E along y see the same square cell."""
    assert polarization_gap(forward_2d(square_cell(rect(220, 200, 200, 3.6, 1)))) < 1e-11


def test_square_circle_polarization_gap_is_only_the_strip_approximation():
    # Horizontal midpoint strips are not C4 symmetric; the gap must vanish as they refine.
    p = square_cell(CircularHole2D(thickness_nm=220, diameter_nm=240, material=material(1), background=material(3.6)))
    gaps = [polarization_gap(forward_2d(p, reference_circle_strips=strips)) for strips in (64, 128, 256)]
    assert gaps[0] > gaps[1] > gaps[2] and gaps[2] < 1e-4


def test_both_incident_polarizations_share_one_layer_cascade(monkeypatch):
    import meent.on_numpy.emsolver.transfer_method as tm

    original, calls = tm.transfer_2d_2, []

    def tracked(*args, **kwargs):
        calls.append(True)
        return original(*args, **kwargs)

    monkeypatch.setattr(tm, "transfer_2d_2", tracked)
    p = project([rect(), film(80, 1.45), rect(0)], wavelengths=(632.8,))
    result = forward_2d(p)
    assert set(result["spectra"]) == {"s", "p"}
    assert len(calls) == 2


@pytest.mark.parametrize("basis", [(0, 0), (3, 0), (0, 3)])
def test_explicit_offline_zero_axis_basis_planar_reduction(basis):
    p = project([film(90, 1.65 + 0.01j)], theta=31, phi=25, n0=1.33, ns=3.5 + 0.1j, wavelengths=(632.8,))
    p.period_nm, p.period_y_nm = 150.0, 140.0
    result = forward_2d(p, reference_basis=basis)
    validate_result_2d(result, p, reference_basis=basis)
    assert result["metadata"]["offline_reference_override"] is True
    for pol in ("s", "p"):
        np.testing.assert_allclose(
            [result["spectra"][pol][key][0] for key in ("R", "T")],
            planar_tmm(632.8, 31, 1.33, [(90, 1.65 + 0.01j)], 3.5 + 0.1j, pol),
            atol=2e-10,
            rtol=0,
        )
