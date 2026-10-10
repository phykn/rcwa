"""Versioned stack schema, material coverage, output binding and fitting guards."""

import copy

import pytest
from pydantic import TypeAdapter, ValidationError

from rcwa_core.contracts import ForwardResult, ForwardResult1_0, StoredForwardResult, validate_result
from rcwa_core.fitting import fit_cd
from rcwa_core.preflight import PreflightError, preflight_project
from rcwa_core.schemas import FitRequest, HomogeneousLayer, Layer, Material, Project
from rcwa_core.solver import forward


def project(layers=None):
    return Project(
        schema_version="1.1",
        layers=layers or [Layer(), HomogeneousLayer()],
        illumination={"wavelengths_nm": [510, 650, 810]},
        solver={"harmonics": 3},
    )


def test_legacy_default_normalization_and_missing_rectangle_tag_are_preserved():
    expected = Project().model_dump()
    assert expected["schema_version"] == "1.0"
    assert len(expected["layers"]) == 1
    assert set(expected["layers"][0]) == {"name", "geometry", "thickness_nm", "cd_nm", "material", "background"}
    legacy = copy.deepcopy(expected)
    legacy["layers"][0].pop("geometry")
    before = copy.deepcopy(legacy)
    assert Project.model_validate(legacy).model_dump() == expected
    assert legacy == before
    assert Project.model_validate({}).model_dump() == expected


def test_explicit_schema_version_controls_expansion():
    for layers in ([Layer(), Layer()], [HomogeneousLayer()]):
        with pytest.raises(ValidationError, match="Schema 1.0"):
            Project(layers=layers)
        assert Project(schema_version="1.1", layers=layers).layers == layers
    for count in (0, 9):
        with pytest.raises(ValidationError):
            Project(schema_version="1.1", layers=[Layer()] * count)
    assert len(Project(schema_version="1.1", layers=[Layer()] * 8).layers) == 8


@pytest.mark.parametrize(
    "extra",
    [
        {"cd_nm": 100},
        {"background": {"n": 1.0}},
        {"id": "layer-1"},
        {"offset_nm": 1},
        {"slope_deg": 90},
        {"geometry": "trapezoid"},
        {"period_nm": 400},
    ],
)
def test_homogeneous_layer_forbids_pattern_fields_and_unapproved_geometry(extra):
    data = HomogeneousLayer().model_dump()
    data.update(extra)
    with pytest.raises(ValidationError):
        Project(schema_version="1.1", layers=[data])


@pytest.mark.parametrize("thickness", [-1, 2001, float("nan"), float("inf")])
def test_layer_thickness_limits_apply_to_every_layer(thickness):
    data = project().model_dump()
    data["layers"][1]["thickness_nm"] = thickness
    with pytest.raises(ValidationError):
        Project.model_validate(data)


def test_lower_rectangle_cd_error_is_layer_indexed():
    data = project([HomogeneousLayer(), Layer()]).model_dump()
    data["layers"][1]["cd_nm"] = 401
    with pytest.raises(ValidationError) as error:
        Project.model_validate(data)
    cause = error.value.errors()[0]["ctx"]["error"]
    assert isinstance(cause, PreflightError)
    assert cause.diagnostics[0].location == ["layers", 1, "cd_nm"]


@pytest.mark.parametrize(
    "kind,field", [("homogeneous", "material"), ("rectangle_1d", "material"), ("rectangle_1d", "background")]
)
def test_lower_layer_table_coverage_is_layer_indexed_even_if_unused(kind, field):
    lower = HomogeneousLayer(thickness_nm=0) if kind == "homogeneous" else Layer(thickness_nm=0, cd_nm=0)
    p = project([Layer(), lower])
    setattr(
        p.layers[1], field, Material(kind="tabulated", wavelengths_nm=[600, 800], n_values=[2, 2.1], k_values=[0, 0])
    )
    diagnostics = preflight_project(p)
    assert len(diagnostics) == 1
    assert diagnostics[0].code == "material_coverage"
    assert diagnostics[0].location == ["layers", 1, field, "wavelengths_nm"]
    with pytest.raises(ValidationError, match="extrapolation"):
        Project.model_validate(p.model_dump())


def test_multiple_table_diagnostics_keep_all_layer_locations():
    p = project([Layer(), HomogeneousLayer()])
    for layer in p.layers:
        layer.material = Material(kind="tabulated", wavelengths_nm=[600, 800], n_values=[2, 2.1], k_values=[0, 0])
    assert [d.location for d in preflight_project(p)] == [
        ["layers", 0, "material", "wavelengths_nm"],
        ["layers", 1, "material", "wavelengths_nm"],
    ]


def test_lower_layer_dispersive_loss_is_accounted_per_wavelength():
    p = project()
    p.layers[1].material = Material(
        kind="tabulated", wavelengths_nm=[510, 650, 810], n_values=[1.6, 1.7, 1.8], k_values=[0.1, 0, 0]
    )
    result = forward(p)
    assert result["metadata"]["max_lossless_flux_error"] is None
    validate_result("forward", result, p)
    for series in result["spectra"].values():
        assert series["A_balance"][0] > 0.01
        assert max(map(abs, series["A_balance"][1:])) < 1e-9


@pytest.mark.parametrize(
    "mutation",
    [
        {"layer_count": 1},
        {"active_slab_count": 1},
        {"total_thickness_nm": 321.0},
        {"stack_order": "bottom_to_top"},
        {"layer_count": True},
        {"total_thickness_nm": "320"},
        {"active_slab_count": 0},
        {"convergence_checked": True},
        {"adapter_version": "1.0.0"},
    ],
)
def test_stack_metadata_tampering_is_rejected(mutation):
    p = project()
    result = forward(p)
    result["metadata"].update(mutation)
    with pytest.raises((ValidationError, ValueError)):
        validate_result("forward", result, p)


def test_historical_reader_does_not_relax_current_worker_boundary():
    p = project([Layer()])
    current = forward(p)
    stored = copy.deepcopy(current)
    stored["schema_version"] = "1.0"
    stored["metadata"]["adapter_version"] = "1.0.0"
    for key in ("layer_count", "active_slab_count", "total_thickness_nm", "stack_order"):
        stored["metadata"].pop(key)
    reader = TypeAdapter(StoredForwardResult)
    assert isinstance(reader.validate_python(stored), ForwardResult1_0)
    assert isinstance(reader.validate_python(current), ForwardResult)
    assert reader.validate_python(stored).model_dump() == stored
    with pytest.raises(ValidationError):
        validate_result("forward", stored, p)
    with pytest.raises(ValidationError):
        ForwardResult1_0.model_validate(current)


@pytest.mark.parametrize("layers", [[Layer(), Layer()], [HomogeneousLayer()], [Layer(), HomogeneousLayer()]])
def test_unsupported_synthetic_fit_fails_before_forward_compute(monkeypatch, layers):
    def forbidden(*args, **kwargs):
        raise AssertionError("Unsupported fit must fail before computing a target")

    monkeypatch.setattr("rcwa_core.fitting.forward", forbidden)
    p = Project(schema_version="1.1", layers=layers)
    with pytest.raises(ValidationError, match="exactly one rectangular"):
        fit_cd(p, {"target_cd_nm": 207})


def test_schema_1_1_single_rectangle_remains_fit_eligible():
    p = Project(
        schema_version="1.1", solver={"harmonics": 3}, illumination={"wavelengths_nm": [450, 530, 610, 690, 770]}
    )
    parameters = {"target_cd_nm": 207, "lower_cd_nm": 100, "upper_cd_nm": 300}
    request = FitRequest(project=p, **parameters)
    assert request.project.schema_version == "1.1"
    result = fit_cd(p, parameters)
    assert result["status"] == "converged"
    assert result["fit_cd_nm"] == pytest.approx(207, abs=0.001)
    assert validate_result("fit", result, p, parameters).fitted_project.schema_version == "1.1"


def test_generated_schema_preserves_legacy_one_rectangle_condition():
    schema = Project.model_json_schema()
    condition = schema["allOf"][0]
    assert condition["if"] == {"properties": {"schema_version": {"const": "1.0"}}}
    assert "required" not in condition["if"]  # Omitted version is also legacy.
    restriction = condition["then"]["properties"]["layers"]
    assert restriction["maxItems"] == 1
    assert restriction["items"]["properties"]["geometry"]["const"] == "rectangle_1d"
    assert schema["properties"]["layers"]["maxItems"] == 8
    assert "oneOf" not in schema["properties"]["layers"]["items"]
    assert len(schema["properties"]["layers"]["items"]["anyOf"]) == 2
    assert set(schema["properties"]["layers"]["items"]["discriminator"]["mapping"]) == {
        "rectangle_1d",
        "homogeneous",
    }
