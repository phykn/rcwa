import json
from pathlib import Path

import numpy as np

from rcwa_core.schemas import Project
from rcwa_core.solver import forward


def test_public_reference_fixture_matches_solver():
    fixture_path = Path(__file__).parent / "fixtures/reference-example.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    project = Project.model_validate(fixture["project"])
    actual = forward(project)
    expected = fixture["result"]
    assert actual["wavelengths_nm"] == expected["wavelengths_nm"]
    assert actual["metadata"]["version"] == expected["metadata"]["version"]
    for polarization, series in actual["spectra"].items():
        for observable in ("R", "T", "R_specular", "T_specular", "A_balance"):
            np.testing.assert_allclose(
                series[observable], expected["spectra"][polarization][observable], rtol=0, atol=1e-10
            )
