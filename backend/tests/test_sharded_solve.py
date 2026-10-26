import json
from pathlib import Path

import pytest

from rcwa_core.project_io import parse_project
from rcwa_core.solver_2d import assemble_forward_2d, forward_2d, solve_wavelengths_2d

EXAMPLE = Path(__file__).parents[1] / "api/examples/circular-hole-2d.json"


def example(**illumination):
    data = json.loads(EXAMPLE.read_text())
    data["illumination"].update(illumination)
    data["solver"] = {"harmonics_x": 2, "harmonics_y": 2}
    return parse_project(data)


def strip_elapsed(result):
    result["metadata"].pop("elapsed_seconds")
    return result


@pytest.mark.parametrize("polarization", ["both", "s", "p"])
def test_sharded_partials_assemble_to_whole_result(polarization):
    project = example(wavelengths_nm=[450.0, 520.0, 610.0, 700.0, 850.0], polarization=polarization)
    shards = [solve_wavelengths_2d(project, [0, 3]), solve_wavelengths_2d(project, [4, 1, 2])]
    partials = sorted((p for shard in shards for p in shard), key=lambda p: p["wavelength_nm"])
    assert json.loads(json.dumps(partials)) == partials
    assembled = assemble_forward_2d(project, partials, elapsed_seconds=0.0)
    assert strip_elapsed(assembled) == strip_elapsed(forward_2d(project))


def test_assemble_rejects_missing_or_reordered_partials():
    project = example(wavelengths_nm=[450.0, 600.0])
    partials = solve_wavelengths_2d(project, [0, 1])
    with pytest.raises(ValueError):
        assemble_forward_2d(project, partials[:1], elapsed_seconds=0.0)
    with pytest.raises(ValueError):
        assemble_forward_2d(project, partials[::-1], elapsed_seconds=0.0)
