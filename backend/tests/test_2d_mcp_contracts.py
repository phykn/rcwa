"""Real stdio/HTTP 2D workflows and independently checked MCP schema/binding."""

from copy import deepcopy
import json

import anyio
import httpx
import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

pytest.importorskip("mcp")
from mcp import Client

from mcp_adapter.client import LocalAPI
from mcp_adapter.server import OPERATIONS, create_server
from rcwa_core.project_io import normalized_project_and_hash
import test_2d_api_contracts as api_tests
import test_mcp_protocol as protocol_tests
from test_2d_api_contracts import snapshot_for
from test_project_dispatch import PROJECT_CASES, small_2d_project
from test_project_identity import PHYSICAL_PATHS_2D, integral_float_fields, replace_path, table_project


solved_2d = api_tests.solved_2d
real_api = protocol_tests.real_api
anyio_backend = protocol_tests.anyio_backend
call = protocol_tests.call
parameters = protocol_tests.parameters

BY_NAME = {operation.name: operation for operation in OPERATIONS}


@pytest.mark.parametrize("name,project,accepted", PROJECT_CASES, ids=[case[0] for case in PROJECT_CASES])
def test_mcp_published_project_schemas_match_explicit_runtime_dispatch(name, project, accepted):
    for tool, arguments in (("rcwa_validate", {"project": project}),
                            ("rcwa_submit", {"request": {"project": project}})):
        operation = BY_NAME[tool]
        schema = operation.tool().input_schema
        Draft202012Validator.check_schema(schema)
        assert Draft202012Validator(schema).is_valid(arguments) == accepted, (name, tool)
        if accepted:
            operation.arguments.model_validate(arguments, strict=True)
        else:
            with pytest.raises(ValidationError):
                operation.arguments.model_validate(arguments, strict=True)


@pytest.mark.parametrize("version,key", [("1.0", "harmonics"), ("1.1", "harmonics"),
                                        ("1.2", "harmonics_x"), ("1.2", "harmonics_y")])
def test_mcp_advertises_integral_float_representation_exception(version, key):
    project = small_2d_project() if version == "1.2" else {"schema_version": version, "solver": {}}
    project["solver"][key] = 3.0
    for tool, arguments in (("rcwa_validate", {"project": project}),
                            ("rcwa_submit", {"request": {"project": project}})):
        operation = BY_NAME[tool]
        assert Draft202012Validator(operation.tool().input_schema).is_valid(arguments)
        with pytest.raises(ValidationError):
            operation.arguments.model_validate(arguments, strict=True)
    assert "3.0" in BY_NAME["rcwa_validate"].description


@pytest.mark.anyio
async def test_invalid_2d_tool_requests_never_reach_http():
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            project = small_2d_project()
            cases = [
                ("rcwa_submit", {"request": {"kind": "fit", "project": project, "fit": {"target_cd_nm": 180}}}),
                ("rcwa_preview_changes", {"base_project": project, "changes": {"cd_nm": 180}}),
                ("rcwa_preview_stack_changes", {"base_project": project, "changes": {"period_nm": 480}}),
                ("rcwa_submit", {"request": {"project": project, "reference_basis": [7, 7]}}),
                ("rcwa_submit", {"request": {"project": project, "laurent_diagnostic": True}}),
            ]
            for path in PHYSICAL_PATHS_2D:
                for value in (True, "1"):
                    invalid = table_project()
                    replace_path(invalid, path, value)
                    cases.append(("rcwa_validate", {"project": invalid}))
                    cases.append(("rcwa_submit", {"request": {"project": invalid}}))
            for tool, arguments in cases:
                response = await call(client, tool, arguments, error=True)
                assert response["error"]["code"] == "invalid_arguments"
            assert not requests
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["rcwa_validate", "rcwa_submit"])
@pytest.mark.parametrize("tamper", ["wrong_hash", "different_project"])
async def test_mcp_rejects_response_input_identity_substitution_without_retry(operation, tamper):
    project = small_2d_project()
    _, normalized, digest = normalized_project_and_hash(project)
    if operation == "rcwa_submit":
        payload = {"id": "job-1", "kind": "forward", "status": "running", "created_at": "now",
                   "completed_at": None, "input_hash": digest, "result": None, "error": None, "error_code": None}
        if tamper == "different_project":
            other = deepcopy(normalized)
            other["layers"][0]["cd_y_nm"] += 1
            payload["input_hash"] = normalized_project_and_hash(other)[2]
    else:
        payload = {"valid": True, "project": deepcopy(normalized), "input_hash": digest, "diagnostics": []}
        if tamper == "different_project":
            payload["project"]["illumination"]["azimuth_deg"] += 1
    if tamper == "wrong_hash":
        payload["input_hash"] = "0" * 64
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json=payload)
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            arguments = {"project": project} if operation == "rcwa_validate" else {"request": {"project": project}}
            error = await call(client, operation, arguments, error=True)
            assert error["error"]["code"] == "invalid_api_response"
            assert error.get("outcome_unknown", False) == (operation == "rcwa_submit")
            assert len(requests) == 1
            transmitted = json.loads(requests[0].content)
            transmitted_project = transmitted if operation == "rcwa_validate" else transmitted["project"]
            assert transmitted_project == normalized
    finally:
        await api.aclose()


SNAPSHOT_TAMPERS = [
    (("project", "layers", 0, "cd_y_nm"), 181.0),
    (("project", "illumination", "azimuth_deg"), 26.0),
    (("project", "layers", 0, "material", "n"), 1.66),
    (("result", "metadata", "input_hash"), "0" * 64),
    (("provenance", "input_hash"), "0" * 64),
    (("provenance", "project_schema_version"), "1.1"),
    (("provenance", "result_schema_version"), "1.1"),
    (("provenance", "adapter_version"), "1.1.0"),
]


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["rcwa_save_snapshot", "rcwa_get_snapshot"])
@pytest.mark.parametrize("path,value", SNAPSHOT_TAMPERS)
async def test_mcp_snapshot_responses_are_bound_to_input_and_provenance(solved_2d, operation, path, value):
    snapshot = snapshot_for(*solved_2d)
    replace_path(snapshot, path, value)
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(201 if operation == "rcwa_save_snapshot" else 200, json=snapshot)
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            arguments = {"job_id": snapshot["provenance"]["job_id"]} if operation == "rcwa_save_snapshot" else {
                "snapshot_id": snapshot["id"]}
            error = await call(client, operation, arguments, error=True)
            assert error["error"]["code"] == "invalid_api_response"
            assert error.get("outcome_unknown", False) == (operation == "rcwa_save_snapshot")
            assert len(requests) == 1
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_real_stdio_2d_compute_snapshot_and_reload(real_api, mode):
    async with Client(parameters(real_api), mode=mode, read_timeout_seconds=15) as client:
        tools = {tool.name: tool for tool in (await client.list_tools()).tools}
        assert len(tools) == 12
        caps = await call(client, "rcwa_capabilities")
        Draft202012Validator(tools["rcwa_capabilities"].output_schema).validate(caps)
        assert caps["project_profiles"]["1.2"]["adapter_version"] == "1.4.0"
        assert (await call(client, "rcwa_example"))["schema_version"] in {"1.0", "1.1"}
        project = integral_float_fields(small_2d_project())
        valid = await call(client, "rcwa_validate", {"project": project})
        assert valid["valid"] and valid["project"]["schema_version"] == "1.2"
        Draft202012Validator(tools["rcwa_validate"].output_schema).validate(valid)
        expected_hash = normalized_project_and_hash(project)[2]
        assert valid["input_hash"] == expected_hash
        started = await call(client, "rcwa_submit", {"request": {"project": project}})
        assert started["status"] == "running" and started["input_hash"] == expected_hash
        with anyio.fail_after(30):
            while True:
                await anyio.sleep(0.08)
                finished = await call(client, "rcwa_get_job", {"job_id": started["id"]})
                if finished["status"] != "running":
                    break
        assert finished["status"] == "succeeded", finished
        Draft202012Validator(tools["rcwa_get_job"].output_schema).validate(finished)
        assert finished["input_hash"] == finished["result"]["metadata"]["input_hash"] == expected_hash
        assert finished["result"]["metadata"]["adapter_version"] == "1.4.0"
        assert finished["result"]["metadata"]["stage"] == "bounded_forward"
        assert finished["result"]["metadata"]["basis_size"] == 9
        saved = await call(client, "rcwa_save_snapshot", {"job_id": started["id"]})
        Draft202012Validator(tools["rcwa_save_snapshot"].output_schema).validate(saved)
        assert saved["project"] == valid["project"] and saved["result"] == finished["result"]
        assert saved["provenance"]["source"] == "server_computed"
        assert saved["provenance"]["input_hash"] == expected_hash
        assert saved["provenance"]["project_schema_version"] == "1.2"
        assert saved["provenance"]["result_schema_version"] == "1.2"
        assert saved["provenance"]["adapter_version"] == "1.4.0"
        assert await call(client, "rcwa_save_snapshot", {"job_id": started["id"]}) == saved
        reloaded = await call(client, "rcwa_get_snapshot", {"snapshot_id": saved["id"]})
        assert reloaded == saved
        Draft202012Validator(tools["rcwa_get_snapshot"].output_schema).validate(reloaded)
        with httpx.Client(trust_env=False) as http:
            assert http.get(real_api + "/api/projects/" + saved["id"]).json() == saved
            assert http.get(real_api + "/api/jobs/" + started["id"]).json() == finished
        # 2D fitting stays explicitly unsupported through the real protocol too.
        rejected = await call(client, "rcwa_submit", {"request": {
            "kind": "fit", "project": project, "fit": {"target_cd_nm": 180},
        }}, error=True)
        assert rejected["error"]["code"] == "invalid_arguments"
    # Adapter restarts retain no private result state; reload must come from HTTP.
    async with Client(parameters(real_api), mode=mode, read_timeout_seconds=15) as client:
        assert await call(client, "rcwa_get_snapshot", {"snapshot_id": saved["id"]}) == saved


def assert_bounded_tool_error(response):
    """Both MCP representations carry the same bounded JSON error payload."""
    from api.diagnostics import (
        MAX_ERROR_CODE_BYTES, MAX_ERROR_DIAGNOSTICS, MAX_ERROR_LOCATION_BYTES, MAX_ERROR_TEXT_BYTES,
    )

    assert response.is_error
    payload = response.structured_content
    assert json.loads(response.content[0].text) == payload
    assert len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) < 64_000
    assert len(response.content[0].text.encode("utf-8")) < 64_000
    diagnostics = payload["error"]["diagnostics"]
    assert len(diagnostics) <= MAX_ERROR_DIAGNOSTICS
    for diagnostic in diagnostics:
        for field, bound in (("code", MAX_ERROR_CODE_BYTES), ("message", MAX_ERROR_TEXT_BYTES),
                             ("location", MAX_ERROR_LOCATION_BYTES)):
            assert len(json.dumps(diagnostic[field], ensure_ascii=False).encode("utf-8")) <= bound
    return diagnostics


@pytest.mark.anyio
@pytest.mark.parametrize("prefix", ["x", "\x00", '"', "\\", "界", "🧪"])
async def test_mcp_many_large_unknown_keys_have_bounded_escaped_unicode_locations(prefix):
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            project = small_2d_project()
            project.update({prefix * 1000 + str(index): 0 for index in range(100)})
            response = await client.call_tool("rcwa_validate", {"project": project})
            diagnostics = assert_bounded_tool_error(response)
            assert len(diagnostics) == 50
            assert diagnostics[-1]["code"] == "diagnostics_truncated"
            assert "truncated" in diagnostics[0]["location"][-1]
            assert not requests
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("tag", ["x" * 100_000, "\x00" * 100_000, '"' * 100_000,
                                 "\\" * 100_000, "界" * 100_000, "🧪" * 100_000],
                         ids=["ascii", "nul", "quote", "backslash", "multibyte", "astral"])
async def test_mcp_large_unknown_geometry_diagnostic_message_is_bounded(tag):
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            project = small_2d_project()
            project["layers"][0]["geometry"] = tag
            response = await client.call_tool("rcwa_submit", {"request": {"project": project}})
            diagnostics = assert_bounded_tool_error(response)
            assert diagnostics[0]["message"].endswith("[truncated]")
            assert not requests
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_mcp_many_nested_numeric_errors_have_explicit_truncation_marker():
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            project = table_project()
            project["substrate"]["n_values"] = ["bad"] * 2000
            response = await client.call_tool("rcwa_validate", {"project": project})
            diagnostics = assert_bounded_tool_error(response)
            assert len(diagnostics) == 50 and diagnostics[-1]["code"] == "diagnostics_truncated"
            assert diagnostics[0]["location"] == ["project", "substrate", "n_values", 0]
            assert not requests
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_mcp_expanded_structured_preflight_diagnostics_are_bounded(monkeypatch):
    from rcwa_core.preflight import Diagnostic

    expanded = [Diagnostic(code="검증" * 1000, severity="error", message='"\\界🧪' * 1000,
                          location=["층" * 1000, index, *["영역" * 1000] * 20]) for index in range(100)]
    monkeypatch.setattr("rcwa_core.preflight_2d.material_coverage_diagnostics_2d", lambda _: expanded)
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            response = await client.call_tool("rcwa_validate", {"project": small_2d_project()})
            diagnostics = assert_bounded_tool_error(response)
            assert len(diagnostics) == 50
            assert diagnostics[-1]["code"] == "diagnostics_truncated"
            assert diagnostics[0]["code"].endswith("[truncated]")
            assert diagnostics[0]["message"].endswith("[truncated]")
            assert diagnostics[0]["location"][-1] == "[truncated]"
            assert not requests
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("location", ["name", "source", "key"])
async def test_mcp_surrogate_input_is_rejected_before_http(location):
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            project = small_2d_project()
            if location == "name":
                project["name"] = "\ud800"
            elif location == "source":
                project["layers"][0]["material"]["source"] = "\udfff"
            else:
                project["\ud800"] = 1
            if location == "key":
                # The pinned SDK rejects surrogate dictionary keys before even
                # emitting the MCP request; value strings exercise the server.
                with pytest.raises(UnicodeEncodeError):
                    await client.call_tool("rcwa_validate", {"project": project})
            else:
                error = await call(client, "rcwa_validate", {"project": project}, error=True)
                assert error["error"]["code"] == "invalid_arguments"
            assert not requests
    finally:
        await api.aclose()
