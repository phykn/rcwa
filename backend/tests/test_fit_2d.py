"""2D dimension fitting recovers synthetic targets and validates its request."""

import json
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from rcwa_core.fit_2d import fit_2d
from rcwa_core.preflight import SolverError
from rcwa_core.project_io import forward_project, parse_project

EXAMPLE = Path(__file__).parents[1] / "api/examples/circular-hole-2d.json"


def example():
    data = json.loads(EXAMPLE.read_text())
    data["solver"] = {"harmonics_x": 2, "harmonics_y": 2}
    return data


def synthetic(data, diameter, thickness=None):
    target = json.loads(json.dumps(data))
    target["layers"][0]["diameter_nm"] = diameter
    if thickness is not None:
        target["layers"][0]["thickness_nm"] = thickness
    target["illumination"]["wavelengths_nm"] = list(range(450, 851, 25))
    result = forward_project(parse_project(target))
    return target["illumination"]["wavelengths_nm"], result["spectra"]["s"]["R"]


def test_recovers_one_dimension():
    data = example()
    ws, values = synthetic(data, 100.0)
    out = fit_2d(parse_project(data), {
        "parameters": [{"path": ["layers", 0, "diameter_nm"], "lower": 40, "upper": 130}],
        "wavelengths_nm": ws, "values": values, "quantity": "R", "polarization": "s",
    })
    assert out["values"][0] == pytest.approx(100.0, abs=0.05)
    assert out["rms"] < 1e-6
    np.testing.assert_allclose(out["fitted"], values, atol=1e-6)


def test_recovers_two_dimensions_with_uncertainty():
    data = example()
    ws, values = synthetic(data, 90.0, 110.0)
    noisy = (np.asarray(values) + 0.002 * np.sin(np.arange(len(values)))).tolist()
    out = fit_2d(parse_project(data), {
        "parameters": [
            {"path": ["layers", 0, "diameter_nm"], "lower": 50, "upper": 130},
            {"path": ["layers", 0, "thickness_nm"], "lower": 60, "upper": 160},
        ],
        "wavelengths_nm": ws, "values": noisy, "quantity": "R", "polarization": "s",
    })
    assert out["values"][0] == pytest.approx(90.0, abs=3)
    assert out["values"][1] == pytest.approx(110.0, abs=3)
    assert all(s is not None and s > 0 for s in out["sigma"])


def test_rejects_malformed_requests():
    project = parse_project(example())
    good = {"parameters": [{"path": ["period_nm"], "lower": 140, "upper": 160}], "wavelengths_nm": [450, 500, 550],
            "values": [0.1, 0.1, 0.1], "quantity": "R", "polarization": "s"}
    with pytest.raises(ValidationError):
        fit_2d(project, {**good, "values": [0.1, 0.1]})
    with pytest.raises(ValidationError):
        fit_2d(project, {**good, "parameters": [{"path": ["period_nm"], "lower": 160, "upper": 140}]})
    with pytest.raises(ValueError):
        fit_2d(project, {**good, "parameters": [{"path": ["name"], "lower": 1, "upper": 2}]})


def test_unpolarized_fit_solves_both_polarizations_for_an_s_only_design():
    data = example()
    target = json.loads(json.dumps(data))
    target["layers"][0]["diameter_nm"] = 100.0
    target["illumination"].update(wavelengths_nm=list(range(450, 851, 50)), polarization="both")
    spectra = forward_project(parse_project(target))["spectra"]
    values = [(s + p) / 2 for s, p in zip(spectra["s"]["R"], spectra["p"]["R"])]
    data["illumination"]["polarization"] = "s"
    out = fit_2d(parse_project(data), {
        "parameters": [{"path": ["layers", 0, "diameter_nm"], "lower": 40, "upper": 130}],
        "wavelengths_nm": target["illumination"]["wavelengths_nm"], "values": values, "quantity": "R", "polarization": "avg",
    })
    assert out["values"][0] == pytest.approx(100.0, abs=0.05)


@pytest.mark.parametrize("parameters,reason", [
    ([{"path": ["layers", 0, "diameter_nm"], "lower": 40, "upper": 145}], "hole diameter must not exceed"),
    ([{"path": ["layers", 0, "diameter_nm"], "lower": 40, "upper": 120},
      {"path": ["period_nm"], "lower": 100, "upper": 160, "linked": [["period_y_nm"]]}], "hole diameter must not exceed"),
    ([{"path": ["period_nm"], "lower": 140, "upper": 1000}], "Increase harmonics"),
])
def test_bounds_admitting_an_unsolvable_design_fail_before_any_solve(parameters, reason, monkeypatch):
    import rcwa_core.fit_2d as module

    monkeypatch.setattr(module, "solve_wavelengths_2d", lambda *a: pytest.fail("solved before checking bounds"))
    with pytest.raises(SolverError, match=reason):
        fit_2d(parse_project(example()), {
            "parameters": parameters, "wavelengths_nm": [450, 500, 550], "values": [0.1, 0.1, 0.1],
            "quantity": "R", "polarization": "s",
        })


def test_slow_fit_returns_its_best_start_inside_the_evaluation_budget(monkeypatch):
    import rcwa_core.fit_2d as module

    monkeypatch.setattr(module, "MAX_EVALUATIONS", 9)
    data = example()
    ws, values = synthetic(data, 90.0, 110.0)
    out = fit_2d(parse_project(data), {
        "parameters": [
            {"path": ["layers", 0, "diameter_nm"], "lower": 50, "upper": 130},
            {"path": ["layers", 0, "thickness_nm"], "lower": 60, "upper": 160},
        ],
        "wavelengths_nm": ws, "values": values, "quantity": "R", "polarization": "s",
    })
    assert out["evaluations"] <= 9
    assert "evaluation cap" in out["note"]


def test_an_unsolvable_probe_inside_the_bounds_falls_back_to_another_start(monkeypatch):
    import rcwa_core.fit_2d as module

    data = example()
    ws, values = synthetic(data, 100.0)
    real = module.solve_wavelengths_2d
    calls = {"n": 0}

    def flaky(project, indices):
        calls["n"] += 1
        if calls["n"] == 2:  # one probe of the first start
            raise module.SolverError("probe failed")
        return real(project, indices)

    monkeypatch.setattr(module, "solve_wavelengths_2d", flaky)
    out = fit_2d(parse_project(data), {
        "parameters": [{"path": ["layers", 0, "diameter_nm"], "lower": 40, "upper": 130}],
        "wavelengths_nm": ws, "values": values, "quantity": "R", "polarization": "s",
    })
    assert out["values"][0] == pytest.approx(100.0, abs=0.05)


@pytest.mark.parametrize("change,reason", [
    ({"parameters": [{"path": ["layers", 99, "diameter_nm"], "lower": 40, "upper": 120}]}, "does not name an input"),
    ({"parameters": [{"path": ["layers", 0, "nonexistent"], "lower": 40, "upper": 120}]}, "does not name an input"),
    ({"parameters": [{"path": ["layers", -1, "diameter_nm"], "lower": 40, "upper": 120}]}, "does not name an input"),
    ({"parameters": [{"path": ["layers", 0, "diameter_nm"], "lower": 40, "upper": 120,
                      "linked": [["layers", 42, "x"]]}]}, "does not name an input"),
    ({"parameters": [{"path": ["solver", "harmonics_x"], "lower": 1, "upper": 3}]}, "not a real-valued design input"),
    ({"wavelengths_nm": [100, 150, 190]}, "measured wavelengths do not form a valid design"),
    ({"wavelengths_nm": [650, 550, 450]}, "measured wavelengths do not form a valid design"),
])
def test_bad_fit_requests_are_rejected_at_admission(change, reason):
    from api.contracts import JobRequest

    spec = {"parameters": [{"path": ["layers", 0, "diameter_nm"], "lower": 40, "upper": 120}],
            "wavelengths_nm": [450, 550, 650], "values": [0.1, 0.1, 0.1], "quantity": "R", "polarization": "s", **change}
    with pytest.raises(ValidationError, match=reason):
        JobRequest.model_validate({"kind": "fit", "project": example(), "fit_2d": spec})


def test_fit_values_are_strict_and_tabulated_scalars_are_not_fittable():
    from api.contracts import JobRequest

    spec = {"parameters": [{"path": ["layers", 0, "diameter_nm"], "lower": "40", "upper": 120}],
            "wavelengths_nm": [450, 550, 650], "values": [0.1, 0.1, 0.1], "quantity": "R", "polarization": "s"}
    with pytest.raises(ValidationError):
        JobRequest.model_validate({"kind": "fit", "project": example(), "fit_2d": spec})
    spec["parameters"] = [{"path": ["layers", True, "diameter_nm"], "lower": 40, "upper": 120}]
    with pytest.raises(ValidationError):
        JobRequest.model_validate({"kind": "fit", "project": example(), "fit_2d": spec})
    data = example()
    data["substrate"] = {"name": "t", "kind": "tabulated", "n": 1.5, "k": 0.0, "wavelengths_nm": [400, 900],
                         "n_values": [1.5, 1.5], "k_values": [0, 0]}
    spec["parameters"] = [{"path": ["substrate", "n"], "lower": 1.2, "upper": 1.8}]
    with pytest.raises(ValidationError, match="not a real-valued design input"):
        JobRequest.model_validate({"kind": "fit", "project": data, "fit_2d": spec})


def test_fit_summary_keeps_the_convergence_note(monkeypatch):
    import rcwa_core.fit_2d as module
    from api.result_summary import result_summary

    monkeypatch.setattr(module, "MAX_EVALUATIONS", 9)
    data = example()
    ws, values = synthetic(data, 90.0, 110.0)
    out = fit_2d(parse_project(data), {
        "parameters": [
            {"path": ["layers", 0, "diameter_nm"], "lower": 50, "upper": 130},
            {"path": ["layers", 0, "thickness_nm"], "lower": 60, "upper": 160},
        ],
        "wavelengths_nm": ws, "values": values, "quantity": "R", "polarization": "s",
    })
    assert result_summary(out)["note"] == out["note"] and "evaluation cap" in out["note"]
