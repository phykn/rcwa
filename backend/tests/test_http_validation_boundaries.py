"""New HTTP input types, bounded rejection output and safe legacy imports."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.contracts import ErrorResponse, FitOptions, JobRequest
from api.main import (
    MAX_ERROR_DIAGNOSTICS, MAX_ERROR_LOCATION_BYTES, MAX_ERROR_TEXT_BYTES, SaveRequest, create_app,
)
from api.storage import canonical_hash
from rcwa_core.schemas import Material, Project


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'boundary.db'}"), base_url="http://localhost") as client:
        yield client


def assert_no_side_effects(client):
    assert not client.app.state.jobs.jobs
    assert not client.app.state.jobs.running
    assert client.get("/api/projects").json() == []


def assert_rejected(response, code="invalid_input"):
    assert response.status_code == 422, response.text
    error = ErrorResponse.model_validate(response.json(), strict=True).error
    assert error.code == code
    assert len(response.content) < 64_000
    assert len(error.diagnostics) <= MAX_ERROR_DIAGNOSTICS
    for diagnostic in error.diagnostics:
        assert len(json.dumps(diagnostic.message, ensure_ascii=False).encode()) <= MAX_ERROR_TEXT_BYTES
        assert len(json.dumps(diagnostic.location, ensure_ascii=False).encode()) <= MAX_ERROR_LOCATION_BYTES
    return error


def with_table():
    project = Project().model_dump()
    project["substrate"].update(
        kind="tabulated", wavelengths_nm=[400.0, 900.0], n_values=[1.5, 1.5], k_values=[0.0, 0.0],
    )
    return project


def bodies(project):
    return [
        ("/api/validate", project),
        ("/api/jobs", {"project": project}),
        ("/api/projects", {"project": project}),
        ("/api/change-preview", {"base_project": project, "changes": {"cd_nm": 170}}),
        ("/api/stack-change-preview", {"base_project": project, "changes": {"period_nm": 410}}),
    ]


PHYSICAL_PATHS = [
    ("period_nm",), ("ambient", "n"), ("ambient", "k"), ("substrate", "n"), ("substrate", "k"),
    ("layers", 0, "thickness_nm"), ("layers", 0, "cd_nm"), ("layers", 0, "material", "n"),
    ("layers", 0, "material", "k"), ("layers", 0, "background", "n"),
    ("layers", 0, "background", "k"), ("illumination", "angle_deg"),
    ("illumination", "wavelengths_nm", 0), ("substrate", "wavelengths_nm", 0),
    ("substrate", "n_values", 0), ("substrate", "k_values", 0), ("solver", "harmonics"),
]


def replace_path(project, path, value):
    parent = project
    for key in path[:-1]:
        parent = parent[key]
    parent[path[-1]] = value


@pytest.mark.parametrize("path", PHYSICAL_PATHS)
@pytest.mark.parametrize("bad", [True, "1"])
def test_new_http_projects_reject_coercion_at_every_boundary(client, path, bad):
    project = with_table()
    replace_path(project, path, bad)
    for route, body in bodies(project):
        error = assert_rejected(client.post(route, json=body))
        assert error.diagnostics[0].message == (
            "Input should be a valid integer" if path == ("solver", "harmonics") else "Input should be a valid number"
        )
    assert_no_side_effects(client)


@pytest.mark.parametrize("field", ["target_cd_nm", "lower_cd_nm", "upper_cd_nm"])
@pytest.mark.parametrize("bad", [True, "180"])
def test_fit_options_reject_coercion_before_allocation(client, field, bad):
    fit = {"target_cd_nm": 180, "lower_cd_nm": 40, "upper_cd_nm": 360, field: bad}
    error = assert_rejected(client.post("/api/jobs", json={"kind": "fit", "project": {}, "fit": fit}))
    assert error.diagnostics[0].location == ["body", "fit", field]
    assert_no_side_effects(client)


@pytest.mark.parametrize("bad", [True, "150"])
def test_both_preview_patches_reject_coercion(client, bad):
    for field in ("cd_nm", "period_nm", "thickness_nm"):
        assert_rejected(client.post("/api/change-preview", json={"base_project": {}, "changes": {field: bad}}))
    layer = Project().model_dump()["layers"][0]
    for geometry in ("rectangle_1d", "homogeneous"):
        changed = {"geometry": geometry, "thickness_nm": bad, "material": layer["material"]}
        assert_rejected(client.post("/api/stack-change-preview", json={
            "base_project": {}, "changes": {"layers": [changed]},
        }))
    assert_rejected(client.post("/api/stack-change-preview", json={
        "base_project": {}, "changes": {"period_nm": bad},
    }))
    assert_no_side_effects(client)


def integer_numbers(value):
    if isinstance(value, dict):
        return {key: integer_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [integer_numbers(item) for item in value]
    return int(value) if isinstance(value, float) and value.is_integer() else value


@pytest.mark.parametrize("version", ["1.0", "1.1"])
def test_valid_integer_float_inputs_defaults_and_hash_are_unchanged(client, version):
    original = with_table()
    original["schema_version"] = version
    normalized = Project.model_validate(original).model_dump()
    expected_hash = canonical_hash(normalized)
    for project in (original, integer_numbers(original)):
        response = client.post("/api/validate", json=project)
        assert response.status_code == 200, response.text
        assert response.json()["valid"]
        assert response.json()["project"] == normalized
        assert response.json()["input_hash"] == expected_hash
        assert JobRequest(project=project).project.model_dump() == normalized
        for route, body in bodies(project)[3:]:
            proposal = client.post(route, json=body)
            assert proposal.status_code == 200, proposal.text
            assert proposal.json()["base_input_hash"] == expected_hash
        saved = client.post("/api/projects", json={"project": project})
        assert saved.status_code == 201, saved.text
        assert saved.json()["project"] == normalized
    default = client.post("/api/validate", json={})
    assert default.status_code == 200 and default.json()["project"] == Project().model_dump()
    assert FitOptions(target_cd_nm=180).model_dump() == {
        "target_cd_nm": 180.0, "lower_cd_nm": 40.0, "upper_cd_nm": 360.0,
    }


def test_historical_project_decoding_is_still_permissive():
    # Strict new requests must not globally change the shared historical reader.
    project = Project.model_validate({"period_nm": "400", "illumination": {"angle_deg": True}})
    assert project.period_nm == 400.0 and project.illumination.angle_deg == 1.0
    with pytest.raises(ValidationError):
        SaveRequest(project={"period_nm": "400"})


@pytest.mark.parametrize("column", ["wavelengths_nm", "n_values", "k_values"])
def test_all_material_columns_are_bounded_in_schema_and_http(client, column):
    project = Project().model_dump()
    project["substrate"][column] = ["x"] * 60_000
    assert Material.model_json_schema()["properties"][column]["anyOf"][0]["maxItems"] == 2000
    error = assert_rejected(client.post("/api/validate", json=project))
    assert len(error.diagnostics) == 1
    assert error.diagnostics[0].location == ["body", "substrate", column]
    assert "at most 2000" in error.diagnostics[0].message
    assert "60000" in error.diagnostics[0].message
    assert_no_side_effects(client)


def test_many_element_errors_are_capped_with_explicit_marker(client):
    project = with_table()
    project["substrate"]["n_values"] = ["x"] * 2000
    error = assert_rejected(client.post("/api/validate", json=project))
    assert len(error.diagnostics) == MAX_ERROR_DIAGNOSTICS
    assert error.diagnostics[0].location == ["body", "substrate", "n_values", 0]
    assert error.diagnostics[-1].code == "diagnostics_truncated"
    assert "omitted" in error.diagnostics[-1].message
    assert_no_side_effects(client)


@pytest.mark.parametrize("prefix", ["unknown", "\x00" * 1000, "界" * 1000])
def test_many_unknown_fields_and_long_locations_are_bounded(client, prefix):
    project = {f"{prefix}{index}": 0 for index in range(100)}
    error = assert_rejected(client.post("/api/validate", json=project))
    assert len(error.diagnostics) == MAX_ERROR_DIAGNOSTICS
    assert error.diagnostics[-1].code == "diagnostics_truncated"
    if prefix != "unknown":
        assert "truncated" in error.diagnostics[0].location[-1]
    assert_no_side_effects(client)


@pytest.mark.parametrize("tag", ["x" * 100_000, "\x00" * 100_000, "界" * 100_000])
def test_long_invalid_geometry_messages_are_bounded(client, tag):
    project = Project().model_dump()
    project["layers"][0]["geometry"] = tag
    error = assert_rejected(client.post("/api/validate", json=project))
    assert error.diagnostics[0].location == ["body", "layers", 0]
    assert error.diagnostics[0].message.endswith("[truncated]")
    assert_no_side_effects(client)


def test_ordinary_field_locations_and_cross_field_diagnostics_remain_exact(client):
    project = Project().model_dump()
    project["illumination"]["angle_deg"] = 76
    error = assert_rejected(client.post("/api/validate", json=project))
    assert error.diagnostics[0].location == ["body", "illumination", "angle_deg"]
    project = Project().model_dump()
    project["layers"][0]["cd_nm"] = 401
    error = assert_rejected(client.post("/api/validate", json=project))
    assert error.diagnostics[0].code == "invalid_cd"
    assert error.diagnostics[0].location == ["layers", 0, "cd_nm"]
    for number in ("NaN", "Infinity", "1e999"):
        assert_rejected(client.post("/api/validate", content='{"period_nm":' + number + '}'), "invalid_json")
    assert_no_side_effects(client)


def test_valid_2000_row_table_round_trips_without_loss(client):
    project = Project().model_dump()
    project["substrate"] = Material(
        kind="tabulated", wavelengths_nm=[200.0 + index for index in range(2000)],
        n_values=[1.5 + index / 10000 for index in range(2000)], k_values=[0.0] * 2000,
    ).model_dump()
    validated = client.post("/api/validate", json=project)
    assert validated.status_code == 200 and validated.json()["valid"]
    assert validated.json()["project"] == project
    saved = client.post("/api/projects", json={"project": project})
    assert saved.status_code == 201, saved.text
    assert client.get(f"/api/projects/{saved.json()['id']}").json()["project"] == project
    proposal = client.post("/api/stack-change-preview", json={"base_project": project, "changes": {"period_nm": 410}})
    assert proposal.status_code == 200, proposal.text
    assert proposal.json()["base_project"] == project
    assert proposal.json()["candidate_project"]["substrate"] == project["substrate"]


def legacy_import():
    fixture = json.loads((Path(__file__).parent / "fixtures" / "legacy_server_snapshot.json").read_text())
    return {key: fixture[key] for key in ("project", "result")}


@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff", "before\udc00after"])
@pytest.mark.parametrize("location", ["metadata_value", "metadata_key", "nested_key", "nested_value", "warning", "extra"])
def test_legacy_result_surrogates_never_commit_even_on_retry(client, surrogate, location):
    payload = legacy_import()
    result = payload["result"]
    if location == "metadata_value":
        result["metadata"]["note"] = surrogate
    elif location == "metadata_key":
        result["metadata"][surrogate] = "note"
    elif location == "nested_key":
        result["metadata"]["nested"] = [{"level": {surrogate: 1}}]
    elif location == "nested_value":
        result["metadata"]["nested"] = [{"level": [surrogate]}]
    elif location == "warning":
        result["warnings"].append(surrogate)
    else:
        result[surrogate] = "legacy extra field"
    for _ in range(2):
        response = client.post("/api/projects", content=json.dumps(payload), headers={"Content-Type": "application/json"})
        assert_rejected(response, "invalid_json")
        assert_no_side_effects(client)
    with pytest.raises(ValidationError, match="valid Unicode"):
        SaveRequest.model_validate(payload)


@pytest.mark.parametrize("bad", [{"name": "\ud800"}, {"\ud800": 1}, {"metadata": {"nested": ["\udfff"]}}])
def test_all_request_routes_reject_invalid_unicode_before_allocation(client, bad):
    for route, _ in bodies({}):
        assert_rejected(client.post(route, content=json.dumps(bad)), "invalid_json")
    assert_no_side_effects(client)


@pytest.mark.parametrize("ensure_ascii", [False, True])
def test_valid_unicode_and_paired_escapes_preserve_legacy_import(client, ensure_ascii):
    payload = legacy_import()
    payload["project"]["name"] = "검증 界 é 🔬"
    payload["result"]["metadata"]["🔬"] = {"note": ["검증 界 é 🔬"]}
    payload["result"]["warnings"].append("비교 🔬")
    # ensure_ascii=True sends the supplementary character as its valid surrogate pair.
    response = client.post("/api/projects", content=json.dumps(payload, ensure_ascii=ensure_ascii).encode(),
                           headers={"Content-Type": "application/json"})
    assert response.status_code == 201, response.text
    saved = response.json()
    assert saved["project"] == payload["project"] and saved["result"] == payload["result"]
    assert saved["provenance"]["source"] == "unverified_import"
    assert client.get(f"/api/projects/{saved['id']}").json() == saved


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_matching_mcp_numeric_coercions_remain_rejected_before_http():
    pytest.importorskip("mcp")
    import httpx
    from mcp import Client
    from mcp_adapter.client import LocalAPI
    from mcp_adapter.server import create_server

    calls = []
    api = LocalAPI(transport=httpx.MockTransport(lambda request: calls.append(request)))
    try:
        async with Client(create_server(api)) as client:
            for path in PHYSICAL_PATHS:
                for bad in (True, "1"):
                    project = with_table()
                    replace_path(project, path, bad)
                    response = await client.call_tool("rcwa_validate", {"project": project})
                    assert response.is_error
                    assert response.structured_content["error"]["code"] == "invalid_arguments"
            for field in ("target_cd_nm", "lower_cd_nm", "upper_cd_nm"):
                for bad in (True, "180"):
                    fit = {"target_cd_nm": 180, "lower_cd_nm": 40, "upper_cd_nm": 360, field: bad}
                    response = await client.call_tool("rcwa_submit", {"request": {
                        "kind": "fit", "project": {}, "fit": fit,
                    }})
                    assert response.is_error
                    assert response.structured_content["error"]["code"] == "invalid_arguments"
        assert not calls
    finally:
        await api.aclose()
