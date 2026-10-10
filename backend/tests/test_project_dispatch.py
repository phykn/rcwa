"""One explicit project dispatch policy across runtime and published schemas."""

from copy import deepcopy

import pytest
from jsonschema import Draft202012Validator
from pydantic import TypeAdapter, ValidationError

from api.contracts import JobRequest
from api.main import SaveRequest, create_app
from rcwa_core.project_io import InputProject, ProjectDocument, parse_project, preflight_project_any
from rcwa_core.schemas import Project
from rcwa_core.schemas_2d import Project2D


ABSENT = object()


def small_2d_project():
    """Small, real, non-planar solve; no archived numerical metadata is reused."""
    return {
        "schema_version": "1.2", "name": "작은 2D 🧪 e\u0301", "period_nm": 460.0, "period_y_nm": 420.0,
        "ambient": {"n": 1.0}, "substrate": {"n": 1.5},
        "layers": [{"geometry": "rectangle_2d", "thickness_nm": 90.0,
                    "cd_x_nm": 220.0, "cd_y_nm": 180.0,
                    "material": {"n": 1.65}, "background": {"n": 1.45}}],
        "illumination": {"wavelengths_nm": [650.0], "angle_deg": 20.0,
                         "azimuth_deg": 25.0, "polarization": "both"},
        "solver": {"harmonics_x": 1, "harmonics_y": 1},
    }


def layer_for(geometry):
    if geometry == "rectangle_2d":
        return small_2d_project()["layers"][0]
    if geometry == "rectangle_1d":
        return {"geometry": geometry, "thickness_nm": 90.0, "cd_nm": 220.0,
                "material": {"n": 1.65}, "background": {"n": 1.45}}
    return {"geometry": geometry, "thickness_nm": 90.0, "material": {"n": 1.65}}


def project_cases():
    cases = [("omitted-legacy", {}, True), ("explicit-1.0", {"schema_version": "1.0"}, True),
             ("explicit-1.1", {"schema_version": "1.1"}, True),
             ("explicit-1.2", small_2d_project(), True)]
    for version in (None, True, 1.2, 1, "1.3", "", "1.2.0"):
        project = small_2d_project()
        project["schema_version"] = version
        cases.append((f"bad-version-{version!r}", project, False))
    implicit_2d = small_2d_project()
    del implicit_2d["schema_version"]
    cases.append(("2d-never-inferred", implicit_2d, False))
    for geometry in ("rectangle_2d", "rectangle_1d", "homogeneous"):
        for tag in (geometry, ABSENT, None, "unknown"):
            project = small_2d_project()
            project["layers"] = [layer_for(geometry)]
            if tag is ABSENT:
                del project["layers"][0]["geometry"]
            else:
                project["layers"][0]["geometry"] = tag
            name = "missing" if tag is ABSENT else str(tag)
            cases.append((f"{geometry}-tag-{name}", project, tag == geometry))
    for path, value in (("period_y_nm", True), ("period_nm", "460"), ("period_y_nm", None)):
        project = small_2d_project()
        project[path] = value
        cases.append((f"invalid-{path}-{value}", project, False))
    return cases


PROJECT_CASES = project_cases()


@pytest.fixture(scope="module")
def schema_boundaries():
    """Validate actual exports independently; preserve their own reference roots."""
    app_schema = create_app().openapi()
    result = [
        ("core", TypeAdapter(InputProject).json_schema(), lambda value: value),
        ("jobs", JobRequest.model_json_schema(), lambda value: {"project": value}),
        ("imports", SaveRequest.model_json_schema(), lambda value: {"project": value}),
    ]
    for route in ("/api/validate", "/api/jobs", "/api/projects"):
        route_schema = app_schema["paths"][route]["post"]["requestBody"]["content"]["application/json"]["schema"]
        schema = {**route_schema, "components": app_schema["components"]}
        wrapper = (lambda value: value) if route == "/api/validate" else (lambda value: {"project": value})
        result.append((f"OpenAPI:{route}", schema, wrapper))
    for _, schema, _ in result:
        Draft202012Validator.check_schema(schema)
    return result


@pytest.mark.parametrize("name,project,accepted", PROJECT_CASES, ids=[case[0] for case in PROJECT_CASES])
def test_explicit_dispatch_matches_independent_exported_schemas(schema_boundaries, name, project, accepted):
    original = deepcopy(project)
    for boundary, schema, wrap in schema_boundaries:
        errors = list(Draft202012Validator(schema).iter_errors(wrap(project)))
        assert (not errors) == accepted, (boundary, name, [error.message for error in errors])
    for parse in (parse_project, lambda value: TypeAdapter(InputProject).validate_python(value, strict=True),
                  lambda value: JobRequest(project=value).project, lambda value: SaveRequest(project=value).project):
        if accepted:
            result = parse(project)
            assert isinstance(result, Project2D if project.get("schema_version") == "1.2" else Project)
            assert result.schema_version == project.get("schema_version", "1.0")
        else:
            with pytest.raises((ValueError, ValidationError)):
                parse(project)
    assert project == original


@pytest.mark.parametrize("version", ["1.0", "1.1"])
def test_legacy_missing_rectangle_tag_is_still_accepted(version, schema_boundaries):
    project = Project(schema_version=version).model_dump(mode="json")
    del project["layers"][0]["geometry"]
    for name, schema, wrap in schema_boundaries:
        assert Draft202012Validator(schema).is_valid(wrap(project)), name
    assert parse_project(project).layers[0].geometry == "rectangle_1d"


@pytest.mark.parametrize("version,key", [("1.0", "harmonics"), ("1.1", "harmonics"),
                                        ("1.2", "harmonics_x"), ("1.2", "harmonics_y")])
def test_integral_float_harmonics_is_documented_schema_representation_exception(schema_boundaries, version, key):
    project = small_2d_project() if version == "1.2" else Project(schema_version=version).model_dump(mode="json")
    project["solver"][key] = 3.0
    for name, schema, wrap in schema_boundaries:
        assert Draft202012Validator(schema).is_valid(wrap(project)), name
    with pytest.raises(ValidationError, match="valid integer"):
        parse_project(project)
    for value in (True, "3", 3.5):
        project["solver"][key] = value
        for name, schema, wrap in schema_boundaries:
            assert not Draft202012Validator(schema).is_valid(wrap(project)), name
        with pytest.raises(ValidationError):
            parse_project(project)


def test_historical_reader_is_separate_and_does_not_weaken_explicit_2d():
    legacy = {"period_nm": "400", "illumination": {"angle_deg": True}}
    parsed = TypeAdapter(ProjectDocument).validate_python(legacy)
    assert parsed.period_nm == 400.0 and parsed.illumination.angle_deg == 1.0
    with pytest.raises(ValidationError):
        parse_project(legacy)
    project = small_2d_project()
    project["period_y_nm"] = "420"
    with pytest.raises(ValidationError):
        parse_project(project, strict=False)
    with pytest.raises(ValidationError):
        TypeAdapter(ProjectDocument).validate_python(project)


def test_structural_schema_does_not_claim_cross_field_physical_admissibility(schema_boundaries):
    project = small_2d_project()
    project["layers"][0]["cd_y_nm"] = project["period_y_nm"] + 1
    for name, schema, wrap in schema_boundaries:
        assert Draft202012Validator(schema).is_valid(wrap(project)), name
    with pytest.raises(ValidationError, match="widths must not exceed"):
        parse_project(project)
    project = small_2d_project()
    project["period_y_nm"] = 5000.0
    assert any(d.severity == "error" for d in preflight_project_any(project))
