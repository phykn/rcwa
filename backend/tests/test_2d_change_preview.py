"""Strict, atomic, read-only schema-1.2 dimension proposal boundaries."""

from copy import deepcopy
import json
import math
from pathlib import Path

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError
from sqlalchemy import event

from api.dimension_change_preview import (
    DimensionChangePreviewRequest, DimensionChangeProposal, preview_2d_changes,
    validate_2d_proposal_binding,
)
from api.main import create_app
from api.stack_change_preview import MAX_PROPOSAL_BYTES, ProposalTooLarge, bounded_proposal
from rcwa_core.identity import canonical_hash
from rcwa_core.preflight_2d import preflight_2d
from rcwa_core.schemas import Material, Project
from rcwa_core.schemas_2d import Project2D

ROUTE = "/api/2d-change-preview"


def dimension_project():
    material = {"name": "Synthetic pattern", "n": 1.8}
    background = {"name": "Synthetic background", "n": 1.0}
    return Project2D.model_validate({
        "schema_version": "1.2", "name": "All supported 2D dimension targets",
        "period_nm": 600.0, "period_y_nm": 500.0,
        "layers": [
            {"geometry": "circular_hole_2d", "diameter_nm": 100.0, "thickness_nm": 80.0,
             "material": material, "background": background},
            {"geometry": "rectangle_2d", "cd_x_nm": 160.0, "cd_y_nm": 120.0,
             "thickness_nm": 90.0, "material": material, "background": background},
            {"geometry": "rectangle_1d", "cd_nm": 180.0, "thickness_nm": 100.0,
             "material": material, "background": background},
            {"geometry": "homogeneous", "thickness_nm": 120.0, "material": material},
        ],
        "illumination": {"wavelengths_nm": [650.0], "angle_deg": 20.0, "azimuth_deg": 25.0},
        "solver": {"harmonics_x": 3, "harmonics_y": 2},
    }, strict=True).model_dump()


def dimension_arguments():
    return {"base_project": dimension_project(), "changes": {"period_nm": 610.0}}


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def dense_dimension_arguments():
    """Near-limit real tables, with eight patterned layers and both port tables."""
    from test_stack_api import table_material

    project = dimension_project()
    material = table_material(loss=True).model_dump()
    project["layers"] = [deepcopy(project["layers"][1]) for _ in range(8)]
    for layer in project["layers"]:
        layer["material"] = deepcopy(material)
        layer["background"] = deepcopy(material)
    project["ambient"] = table_material().model_dump()
    project["substrate"] = deepcopy(material)
    return {"base_project": project, "changes": {"period_nm": 610.0}}


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(f"sqlite:///{tmp_path / 'dimensions.db'}"), base_url="http://localhost") as client:
        yield client


def test_atomic_all_geometry_resize_is_deterministic_and_has_no_side_effects(client, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Dimension preview cannot inspect engines, compute, submit jobs or save")

    monkeypatch.setattr("api.main.engine_info", forbidden)
    monkeypatch.setattr("rcwa_core.preflight.engine_info", forbidden)
    monkeypatch.setattr("rcwa_core.project_io.forward_project", forbidden)
    monkeypatch.setattr(client.app.state.jobs, "submit", forbidden)
    monkeypatch.setattr(client.app.state.store, "save", forbidden)
    queries = []
    event.listen(client.app.state.store.engine, "before_cursor_execute", lambda *args: queries.append(args))
    body = {"base_project": dimension_project(), "changes": {
        "period_nm": 100.0, "period_y_nm": 90.0,
        # Caller ordering must not affect canonical diff ordering.
        "layers": [
            {"index": 3, "geometry": "homogeneous", "thickness_nm": 70.0},
            {"index": 1, "geometry": "rectangle_2d", "cd_y_nm": 70.0, "cd_x_nm": 80.0, "thickness_nm": 60.0},
            {"index": 0, "geometry": "circular_hole_2d", "diameter_nm": 80.0},
            {"index": 2, "geometry": "rectangle_1d", "cd_nm": 90.0},
        ],
    }}
    original = compact(body)
    response = client.post(ROUTE, json=body)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["schema_version"] == "rcwa-change-proposal/1.2"
    assert payload["valid"] and payload["diagnostics"] == []
    assert response.content == client.post(ROUTE, json=body).content
    assert compact(body) == original
    assert [entry["path"] for entry in payload["diff"]] == [
        "period_nm", "period_y_nm", "layers[0].diameter_nm", "layers[1].thickness_nm",
        "layers[1].cd_x_nm", "layers[1].cd_y_nm", "layers[2].cd_nm", "layers[3].thickness_nm",
    ]
    restored = deepcopy(payload["candidate_project"])
    restored["period_nm"], restored["period_y_nm"] = 600.0, 500.0
    for before, after in zip(payload["base_project"]["layers"], restored["layers"]):
        for field in ("thickness_nm", "diameter_nm", "cd_nm", "cd_x_nm", "cd_y_nm"):
            if field in before:
                after[field] = before[field]
    assert restored == payload["base_project"] == body["base_project"]
    for role in ("base", "candidate"):
        assert payload[f"{role}_input_hash"] == canonical_hash(payload[f"{role}_project"])
    validate_2d_proposal_binding(payload, DimensionChangePreviewRequest.model_validate(body, strict=True))
    assert not queries and not client.app.state.jobs.jobs and not client.app.state.jobs.inputs


@pytest.mark.parametrize("changes", [
    {}, None, [], {"layers": []}, {"layers": None},
    {"period_nm": None}, {"period_nm": True}, {"period_nm": "400"}, {"period_nm": 19.999}, {"period_nm": 5000.01},
    {"period_y_nm": False}, {"period_y_nm": "400"}, {"period_y_nm": 0},
    {"name": "not a dimension"}, {"apply": True}, {"solver": {"harmonics_x": 5}}, {"ambient": {"n": 2}},
    {"layers": [{"index": 0, "geometry": "circular_hole_2d"}]},
    {"layers": [{"geometry": "circular_hole_2d", "diameter_nm": 50}]},
    {"layers": [{"index": 0, "diameter_nm": 50}]},
    {"layers": [{"index": True, "geometry": "circular_hole_2d", "diameter_nm": 50}]},
    {"layers": [{"index": 0.0, "geometry": "circular_hole_2d", "diameter_nm": 50}]},
    {"layers": [{"index": "0", "geometry": "circular_hole_2d", "diameter_nm": 50}]},
    {"layers": [{"index": -1, "geometry": "circular_hole_2d", "diameter_nm": 50}]},
    {"layers": [{"index": 4, "geometry": "circular_hole_2d", "diameter_nm": 50}]},
    {"layers": [{"index": 8, "geometry": "circular_hole_2d", "diameter_nm": 50}]},
    {"layers": [{"index": 0, "geometry": "rectangle_2d", "cd_x_nm": 50}]},
    {"layers": [{"index": 0, "geometry": "triangle", "diameter_nm": 50}]},
    {"layers": [{"index": 0, "geometry": "circular_hole_2d", "cd_x_nm": 50}]},
    {"layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": "50"}]},
    {"layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": True}]},
    {"layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": -0.01}]},
    {"layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": 5000.01}]},
    {"layers": [{"index": 0, "geometry": "circular_hole_2d", "material": {"n": 2}, "diameter_nm": 50}]},
    {"layers": [{"index": 1, "geometry": "rectangle_2d", "cd_nm": 50}]},
    {"layers": [{"index": 1, "geometry": "rectangle_2d", "cd_y_nm": False}]},
    {"layers": [{"index": 2, "geometry": "rectangle_1d", "cd_x_nm": 50}]},
    {"layers": [{"index": 3, "geometry": "homogeneous", "cd_nm": 50}]},
    {"layers": [{"index": 3, "geometry": "homogeneous", "thickness_nm": "50"}]},
    {"layers": [{"index": 3, "geometry": "homogeneous", "thickness_nm": 2000.01}]},
    {"layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": 50}] * 2},
    {"layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": 50}] * 9},
])
def test_invalid_patch_is_rejected_with_a_valid_base(client, changes):
    response = client.post(ROUTE, json={"base_project": dimension_project(), "changes": changes})
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "invalid_input"
    assert not client.app.state.jobs.jobs


@pytest.mark.parametrize("changes", [
    {"period_nm": 100.0}, {"period_y_nm": 90.0},
    {"layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": 501.0}]},
    {"layers": [{"index": 1, "geometry": "rectangle_2d", "cd_x_nm": 601.0}]},
    {"layers": [{"index": 1, "geometry": "rectangle_2d", "cd_y_nm": 501.0}]},
    {"layers": [{"index": 2, "geometry": "rectangle_1d", "cd_nm": 601.0}]},
])
def test_combined_candidate_is_validated_without_clamping(client, changes):
    response = client.post(ROUTE, json={"base_project": dimension_project(), "changes": changes})
    assert response.status_code == 422, response.text
    assert any("candidate_project" in item["location"] for item in response.json()["error"]["diagnostics"])


@pytest.mark.parametrize("version", [None, "1.0", "1.1", "9.0", 1.2, True])
def test_explicit_12_base_required(client, version):
    body = dimension_arguments()
    if version is None:
        body["base_project"].pop("schema_version")
    else:
        body["base_project"]["schema_version"] = version
    assert client.post(ROUTE, json=body).status_code == 422


def test_no_legacy_route_or_schema_is_silently_promoted(client):
    body = dimension_arguments()
    assert client.post("/api/change-preview", json=body).status_code == 422
    assert client.post("/api/stack-change-preview", json=body).status_code == 422
    body["base_project"] = Project().model_dump()
    assert client.post(ROUTE, json=body).status_code == 422


def test_noop_retains_identity_and_integer_dimensions_normalize(client):
    body = dimension_arguments()
    body["changes"] = {"period_nm": 600, "period_y_nm": 500,
                       "layers": [{"index": 0, "geometry": "circular_hole_2d", "diameter_nm": 100}]}
    response = client.post(ROUTE, json=body)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["diff"] == []
    assert payload["base_input_hash"] == payload["candidate_input_hash"]
    assert payload["base_project"] == payload["candidate_project"]
    assert type(payload["changes"]["period_nm"]) is float
    assert type(payload["changes"]["layers"][0]["index"]) is int


def test_all_eight_rectangles_allow_the_maximum_26_dimension_diff(client):
    body = dimension_arguments()
    body["base_project"]["layers"] = [deepcopy(body["base_project"]["layers"][1]) for _ in range(8)]
    body["changes"] = {
        "period_nm": 620.0, "period_y_nm": 510.0,
        "layers": [{"index": index, "geometry": "rectangle_2d", "thickness_nm": 100.0,
                    "cd_x_nm": 170.0, "cd_y_nm": 130.0} for index in reversed(range(8))],
    }
    response = client.post(ROUTE, json=body)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload["diff"]) == 26
    assert [entry["path"] for entry in payload["diff"]] == ["period_nm", "period_y_nm"] + [
        f"layers[{index}].{field}" for index in range(8) for field in ("thickness_nm", "cd_x_nm", "cd_y_nm")]
    validate_2d_proposal_binding(payload, DimensionChangePreviewRequest.model_validate(body, strict=True))


@pytest.mark.parametrize("index,field", [(0, "diameter_nm"), (1, "cd_x_nm"), (1, "cd_y_nm"),
                                         (2, "cd_nm"), (3, "thickness_nm")])
def test_signed_zero_is_a_real_diff_and_hash_change(index, field):
    body = dimension_arguments()
    body["base_project"]["layers"][index][field] = 0.0
    body["changes"] = {"layers": [{"index": index, "geometry": body["base_project"]["layers"][index]["geometry"],
                                  field: -0.0}]}
    request = DimensionChangePreviewRequest.model_validate(body, strict=True)
    payload = preview_2d_changes(request).model_dump()
    assert payload["base_input_hash"] != payload["candidate_input_hash"]
    assert len(payload["diff"]) == 1 and payload["diff"][0]["path"] == f"layers[{index}].{field}"
    assert math.copysign(1, payload["diff"][0]["before"]) == 1
    assert math.copysign(1, payload["diff"][0]["after"]) == -1
    validate_2d_proposal_binding(json.loads(compact(payload)), request)
    # Ordinary Python equality would miss both of these raw-canonical forgeries.
    for tamper in (lambda p: p["diff"][0].update(after=0.0),
                   lambda p: p["candidate_project"]["layers"][index].update({field: 0.0}),
                   lambda p: p["changes"]["layers"][0].update({field: 0.0})):
        forged = deepcopy(payload)
        tamper(forged)
        assert forged == payload
        with pytest.raises(ValueError, match="does not match"):
            validate_2d_proposal_binding(forged, request)


@pytest.mark.parametrize("tamper", [
    lambda p: p.update(schema_version="rcwa-change-proposal/1.1"), lambda p: p.pop("valid"),
    lambda p: p.update(extra=True), lambda p: p.update(valid=False),
    lambda p: p.update(base_input_hash="0" * 64), lambda p: p.update(candidate_input_hash="0" * 64),
    lambda p: p["base_project"].update(name="Other input"),
    lambda p: p["candidate_project"]["layers"][0].update(diameter_nm=99.0),
    lambda p: p["base_project"]["ambient"].pop("source"),
    lambda p: p["candidate_project"]["ambient"].pop("k"),
    lambda p: p["candidate_project"]["layers"][0].pop("name"),
    lambda p: p["candidate_project"]["illumination"].pop("polarization"),
    lambda p: p["base_project"].update(period_nm=600),
    lambda p: p["candidate_project"].update(period_nm=610),
    lambda p: p["changes"].update(period_nm=610), lambda p: p.update(diff=[]),
    lambda p: p["diff"][0].update(after=610), lambda p: p["diff"][0].update(path="period_y_nm"),
    lambda p: p["diagnostics"].append({"code": "fake", "severity": "warning", "location": [], "message": "Forged"}),
])
def test_raw_binding_rejects_tampering_and_missing_defaults(tamper):
    request = DimensionChangePreviewRequest.model_validate(dimension_arguments(), strict=True)
    payload = preview_2d_changes(request).model_dump()
    tamper(payload)
    with pytest.raises((ValidationError, ValueError)):
        DimensionChangeProposal.model_validate(payload, strict=True)
        validate_2d_proposal_binding(payload, request)


@pytest.mark.parametrize("wavelength,expected", [(650.0, "rayleigh_cutoff"), (650.001, "near_rayleigh_cutoff")])
def test_cutoff_diagnostics_match_backend_without_engine_checks(client, wavelength, expected):
    body = dimension_arguments()
    body["base_project"]["illumination"].update(wavelengths_nm=[wavelength], angle_deg=0.0, azimuth_deg=0.0)
    body["changes"] = {"period_nm": 650.0}
    payload = client.post(ROUTE, json=body).json()
    assert expected in [item["code"] for item in payload["diagnostics"]]
    assert payload["diagnostics"] == [item.model_dump() for item in preflight_2d(
        Project2D.model_validate(payload["candidate_project"], strict=True))]
    assert payload["valid"] is (expected == "near_rayleigh_cutoff")


def test_oblique_unequal_basis_and_lossless_substrate_diagnostics(client):
    body = dimension_arguments()
    body["base_project"]["illumination"].update(wavelengths_nm=[632.8], angle_deg=37.0, azimuth_deg=45.0)
    body["base_project"]["solver"].update(harmonics_x=1, harmonics_y=2)
    body["changes"] = {"period_nm": 1800.0, "period_y_nm": 1700.0}
    payload = client.post(ROUTE, json=body).json()
    assert not payload["valid"]
    assert any(d["code"] == "insufficient_harmonics" and d["location"] == ["solver"] for d in payload["diagnostics"])
    body["base_project"]["substrate"]["k"] = 0.1
    lossy = client.post(ROUTE, json=body).json()
    assert lossy["diagnostics"] == [item.model_dump() for item in preflight_2d(
        Project2D.model_validate(lossy["candidate_project"], strict=True))]
    assert payload["diagnostics"] != lossy["diagnostics"]


def test_coverage_in_unused_material_is_not_bypassed(client):
    body = dimension_arguments()
    body["base_project"]["layers"][0]["thickness_nm"] = 0.0
    body["base_project"]["layers"][0]["material"] = Material(
        kind="tabulated", wavelengths_nm=[400.0, 600.0], n_values=[1.5, 1.6], k_values=[0.0, 0.0],
    ).model_dump()
    response = client.post(ROUTE, json=body)
    assert response.status_code == 422
    assert any(d["code"] == "material_coverage" for d in response.json()["error"]["diagnostics"])


def test_capabilities_and_openapi_advertise_version_accurate_readonly_scope(client):
    capabilities = client.get("/api/capabilities").json()
    assert "preview_2d_changes" in capabilities["operations"]
    for version, profile in capabilities["project_profiles"].items():
        assert ("preview_2d_changes" in profile["operations"]) is (version == "1.2")
        if version == "1.2":
            assert "preview_stack_changes" not in profile["operations"]
            assert "preview_changes" not in profile["operations"]
            assert "synthetic_fit" not in profile["operations"]
            assert profile["harmonics"] == {"x": [1, 5], "y": [1, 5]}
            assert profile["wavelength_count"] == 31
    assert capabilities["limits"]["request_bytes"] == 2_000_000
    assert capabilities["limits"]["proposal_bytes"] == MAX_PROPOSAL_BYTES == 8_000_000
    schemas = client.get("/openapi.json").json()["components"]["schemas"]
    changes = schemas["DimensionChanges"]
    assert changes["additionalProperties"] is False
    assert set(changes["properties"]) == {"period_nm", "period_y_nm", "layers"}
    assert changes["properties"]["layers"]["maxItems"] == 8
    assert schemas["DimensionChangeProposal"]["properties"]["schema_version"]["const"] == "rcwa-change-proposal/1.2"


def test_dense_tables_roundtrip_and_exact_http_byte_limits(client, monkeypatch):
    body = dense_dimension_arguments()
    encoded = compact(body)
    assert 1_800_000 < len(encoded) < 2_000_000, len(encoded)
    response = client.post(ROUTE, content=encoded)
    assert response.status_code == 200, response.text[:1000]
    assert 2_000_000 < len(response.content) < MAX_PROPOSAL_BYTES
    payload = response.json()
    DimensionChangeProposal.model_validate(payload, strict=True)
    validate_2d_proposal_binding(payload, DimensionChangePreviewRequest.model_validate(body, strict=True))
    assert len(payload["candidate_project"]["layers"]) == 8
    assert len(payload["candidate_project"]["layers"][7]["background"]["n_values"]) == 2000
    assert len(payload["diff"]) == 1
    padded = encoded + b" " * (2_000_000 - len(encoded))
    assert client.post(ROUTE, content=padded).status_code == 200
    rejected = client.post(ROUTE, content=padded + b" ")
    assert rejected.status_code == 413 and rejected.json()["error"]["code"] == "body_too_large"
    # The shared 8 MB bound uses the exact serialized UTF-8 response, accepting equality.
    monkeypatch.setattr("api.stack_change_preview.MAX_PROPOSAL_BYTES", len(response.content))
    assert client.post(ROUTE, content=encoded).status_code == 200
    monkeypatch.setattr("api.stack_change_preview.MAX_PROPOSAL_BYTES", len(response.content) - 1)
    rejected = client.post(ROUTE, content=encoded)
    assert rejected.status_code == 413 and rejected.json()["error"]["code"] == "proposal_too_large"
    monkeypatch.setattr("api.stack_change_preview.MAX_PROPOSAL_BYTES", MAX_PROPOSAL_BYTES)

    class TooLarge:
        def model_dump(self, **kwargs):
            return {"padding": "界" * (MAX_PROPOSAL_BYTES // 3)}

    with pytest.raises(ProposalTooLarge, match="8 MB"):
        bounded_proposal(TooLarge())


def test_http_host_origin_and_nonfinite_boundaries(client):
    body = dimension_arguments()
    assert client.post(ROUTE, json=body, headers={"Host": "remote.example"}).status_code == 400
    assert client.post(ROUTE, json=body, headers={"Origin": "https://remote.example"}).status_code == 403
    for token in ("NaN", "Infinity", "-Infinity", "1e999"):
        raw = compact(body).replace(b'"period_nm":610.0', b'"period_nm":' + token.encode())
        response = client.post(ROUTE, content=raw)
        assert response.status_code == 422 and response.json()["error"]["code"] == "invalid_json"


@pytest.mark.parametrize("member,replacement", [
    (b'"base_project":', b'"base_project":{},"base_project":'),
    (b'"changes":', b'"changes":{},"changes":'),
    (b'"base_project":', b'"base_\\u0070roject":{},"base_project":'),
    (b'"changes":', b'"change\\u0073":{},"changes":'),
    (b'"period_nm":610.0', b'"period_nm":600.0,"period_nm":610.0'),
    (b'"period_y_nm":510.0', b'"period_y_nm":500.0,"period_y_nm":510.0'),
    (b'"period_nm":610.0', b'"period\\u005fnm":600.0,"period_nm":610.0'),
    (b'"index":0', b'"index":1,"index":0'),
    (b'"index":0', b'"ind\\u0065x":1,"index":0'),
    (b'"diameter_nm":90.0', b'"diameter_nm":80.0,"diameter_nm":90.0'),
    (b'"n":1.0', b'"n":2.0,"n":1.0'),
    (b'"n":1.0', b'"\\u006e":2.0,"n":1.0'),
    (b'"geometry":"circular_hole_2d"', b'"geometry":"homogeneous","geometry":"circular_hole_2d"'),
])
def test_dimension_http_rejects_duplicate_members_including_escaped_equivalents(client, member, replacement):
    body = dimension_arguments()
    body["changes"].update(period_y_nm=510.0, layers=[
        {"index": 0, "geometry": "circular_hole_2d", "diameter_nm": 90.0},
    ])
    encoded = compact(body)
    assert member in encoded
    raw = encoded.replace(member, replacement, 1)
    assert json.loads(raw) == body  # Last-member-wins decoding would conceal the ambiguity.
    response = client.post(ROUTE, content=raw)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_json"
    assert not client.app.state.jobs.jobs and not client.app.state.jobs.inputs


@pytest.mark.parametrize("route", ["/api/change-preview", "/api/stack-change-preview"])
def test_duplicate_member_rejection_does_not_change_legacy_http_decoding(client, route):
    body = {"base_project": Project().model_dump(), "changes": {"period_nm": 390.0}}
    expected = client.post(route, json=body)
    assert expected.status_code == 200, expected.text
    raw = compact(body).replace(b'"changes":', b'"changes":{},"changes":', 1)
    raw = raw.replace(b'"period_nm":390.0', b'"period\\u005fnm":380.0,"period_nm":390.0', 1)
    assert json.loads(raw) == body
    response = client.post(route, content=raw)
    assert response.status_code == 200, response.text
    assert response.json() == expected.json()


def test_frontend_dimension_proposal_fixtures_are_exact_backend_outputs():
    fixtures = json.loads((Path(__file__).resolve().parents[2] /
                           "frontend/src/fixtures/dimension-proposals-2d.json").read_text(encoding="utf-8"))
    names = {fixture["name"] for fixture in fixtures}
    assert {"circle", "noop", "signed-zero", "numerical-failure", "mixed-atomic"} <= names
    for fixture in fixtures:
        payload = fixture["proposal"]
        request = DimensionChangePreviewRequest.model_validate({
            "base_project": payload["base_project"], "changes": payload["changes"],
        }, strict=True)
        expected = preview_2d_changes(request).model_dump()
        # Plain dict equality would hide signed zero and integer/float identity drift.
        assert json.dumps(payload, sort_keys=True, ensure_ascii=False, allow_nan=False) == json.dumps(
            expected, sort_keys=True, ensure_ascii=False, allow_nan=False), fixture["name"]
        validate_2d_proposal_binding(payload, request)
