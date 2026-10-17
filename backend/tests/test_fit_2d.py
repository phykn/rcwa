"""2D dimension fitting recovers synthetic targets and validates its request."""

import json
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from rcwa_core.fit_2d import fit_2d
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
