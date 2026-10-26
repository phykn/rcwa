import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from copy import deepcopy

import anyio
import httpx
import pytest

pytest.importorskip("mcp")
from mcp import Client
from mcp.shared.exceptions import MCPError
from mcp.client.stdio import StdioServerParameters


ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def real_api(tmp_path):
    url = f"http://127.0.0.1:{available_port()}"
    env = {**os.environ, "PYTHONPATH": str(ROOT / "backend"),
           "DATABASE_URL": f"sqlite:///{tmp_path / 'mcp.db'}", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
    with (tmp_path / "api.log").open("w+") as log:
        process = subprocess.Popen([sys.executable, "-m", "uvicorn", "api.main:app", "--host", "127.0.0.1",
                                    "--port", url.rsplit(":", 1)[1]], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            with httpx.Client(trust_env=False, timeout=0.3) as http:
                for _ in range(150):
                    if process.poll() is not None:
                        log.seek(0)
                        pytest.fail(log.read())
                    try:
                        if http.get(url + "/api/health").status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.05)
                else:
                    pytest.fail("Test API failed to start")
            yield url
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def parameters(url):
    return StdioServerParameters(
        command=sys.executable, args=["-m", "mcp_adapter.server", "--api-url", url], cwd=ROOT,
        env={"PYTHONPATH": str(ROOT / "backend"), "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"},
    )


async def call(client, name, arguments=None, *, error=False):
    response = await client.call_tool(name, arguments or {})
    assert response.is_error == error, response
    assert json.loads(response.content[0].text) == response.structured_content
    return response.structured_content


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
@pytest.mark.parametrize("multilayer", [False, True])
async def test_real_discovery_compute_and_durable_binding(real_api, mode, multilayer):
    async with Client(parameters(real_api), mode=mode, read_timeout_seconds=15) as client:
        assert client.protocol_version in {"2025-11-25", "2026-07-28"}
        assert client.server_capabilities.tools is not None
        tools = (await client.list_tools()).tools
        assert len(tools) == 12
        assert all(t.input_schema["additionalProperties"] is False for t in tools)
        caps = await call(client, "rcwa_capabilities")
        assert caps["limits"]["simultaneous_jobs"] == 2
        assert caps["engine"]["available"]
        project = await call(client, "rcwa_example")
        project["illumination"]["wavelengths_nm"] = [650.0]
        project["solver"]["harmonics"] = 3
        if multilayer:
            preview = await call(client, "rcwa_preview_stack_changes", {"base_project": project, "changes": {
                "layers": [project["layers"][0], {"geometry": "homogeneous", "thickness_nm": 75.0,
                                                   "material": {"n": 1.8}}],
            }})
            assert preview["schema_version"] == "rcwa-change-proposal/1.1"
            project = preview["candidate_project"]
        valid = await call(client, "rcwa_validate", {"project": project})
        assert valid["valid"]
        normalized = deepcopy(valid["project"])
        started = await call(client, "rcwa_submit", {"request": {"project": normalized}})
        assert started["status"] == "running"
        with anyio.fail_after(30):
            while True:
                await anyio.sleep(0.08)
                completed = await call(client, "rcwa_get_job", {"job_id": started["id"]})
                if completed["status"] != "running":
                    break
        assert completed["status"] == "succeeded", completed
        assert completed["result"]["schema_version"] == "1.1"
        assert completed["result"]["metadata"]["layer_count"] == (2 if multilayer else 1)
        assert completed["input_hash"] == valid["input_hash"]
        saved = await call(client, "rcwa_save_snapshot", {"job_id": started["id"]})
        assert saved["project"] == normalized
        assert saved["result"] == completed["result"]
        assert saved["provenance"]["source"] == "server_computed"
        assert saved["provenance"]["job_id"] == started["id"]
        assert saved["provenance"]["input_hash"] == valid["input_hash"]
        again = await call(client, "rcwa_save_snapshot", {"job_id": started["id"]})
        assert again == saved
        reloaded = await call(client, "rcwa_get_snapshot", {"snapshot_id": saved["id"]})
        assert reloaded == saved
        with httpx.Client(trust_env=False) as http:
            assert http.get(real_api + "/api/projects/" + saved["id"]).json() == saved
            assert http.get(real_api + "/api/jobs/" + started["id"]).json() == completed
        invalid = deepcopy(project)
        invalid["period_nm"] = 5000
        invalid["solver"]["harmonics"] = 1
        rejected = await call(client, "rcwa_validate", {"project": invalid})
        assert not rejected["valid"] and rejected["diagnostics"]
        error = await call(client, "rcwa_submit", {"request": {"project": invalid}}, error=True)
        assert error["http_status"] == 422
        with httpx.Client(trust_env=False) as http:
            direct = http.post(real_api + "/api/jobs", json={"project": invalid}).json()
        assert error["error"] == direct["error"]
    # Fresh MCP process can read the same durable snapshot; it owns no jobs or database.
    async with Client(parameters(real_api), mode=mode) as client:
        assert await call(client, "rcwa_get_snapshot", {"snapshot_id": saved["id"]}) == saved


@pytest.mark.anyio
async def test_real_cancellation_and_missing_job(real_api):
    async with Client(parameters(real_api), mode="legacy") as client:
        project = await call(client, "rcwa_example")
        started = await call(client, "rcwa_submit", {"request": {"project": project}})
        cancelled = await call(client, "rcwa_cancel_job", {"job_id": started["id"]})
        assert cancelled["status"] == "cancelled"
        assert (await call(client, "rcwa_cancel_job", {"job_id": started["id"]})) == cancelled
        failure = await call(client, "rcwa_save_snapshot", {"job_id": started["id"]}, error=True)
        assert failure["http_status"] == 409
        missing = await call(client, "rcwa_get_job", {"job_id": "missing"}, error=True)
        assert missing["error"]["code"] == "job_missing"
        assert (await call(client, "rcwa_capabilities"))["engine"]["available"]


@pytest.mark.anyio
async def test_api_down_is_a_tool_error_not_protocol_crash():
    async with Client(parameters(f"http://127.0.0.1:{available_port()}"), mode="legacy") as client:
        assert len((await client.list_tools()).tools) == 12
        response = await call(client, "rcwa_capabilities", error=True)
        assert response["error"]["code"] == "api_unavailable"
        response = await call(client, "rcwa_submit", {"request": {"project": {}}}, error=True)
        assert response["outcome_unknown"]
        await call(client, "rcwa_capabilities", {"url": "http://example.com"}, error=True)
        with pytest.raises(MCPError) as caught:
            await client.call_tool("nonexistent_tool", {})
        assert caught.value.code == -32602



@pytest.mark.anyio
async def test_disconnect_does_not_cancel_separate_api_job(real_api):
    async with Client(parameters(real_api), mode="legacy") as client:
        project = await call(client, "rcwa_example")
        started = await call(client, "rcwa_submit", {"request": {"project": project}})
    async with Client(parameters(real_api), mode="legacy") as client:
        job = await call(client, "rcwa_get_job", {"job_id": started["id"]})
        assert job["status"] in {"running", "succeeded"}
        await call(client, "rcwa_cancel_job", {"job_id": started["id"]})


def test_stdio_closes_on_eof():
    process = subprocess.Popen(
        [sys.executable, "-m", "mcp_adapter.server"], cwd=ROOT,
        env={**os.environ, "PYTHONPATH": str(ROOT / "backend"), "OPENBLAS_NUM_THREADS": "1"},
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        stdout, stderr = process.communicate(b"", timeout=10)
        assert process.returncode == 0, stderr.decode()
        assert not stdout
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_stdio_discovery_and_validation(real_api, mode, monkeypatch):
    # Capture the pinned SDK's process object only to assert its normal teardown.
    import mcp.client.stdio as stdio

    original_spawn = stdio._create_platform_compatible_process
    children = []
    async def capture_process(*args, **kwargs):
        process = await original_spawn(*args, **kwargs)
        children.append(process)
        return process
    monkeypatch.setattr(stdio, "_create_platform_compatible_process", capture_process)
    async with Client(parameters(real_api), mode=mode, read_timeout_seconds=15) as client:
        assert client.server_info.name == "RCWA Workbench"
        assert client.protocol_version in {"2025-11-25", "2026-07-28"}
        assert len((await client.list_tools()).tools) == 12
        caps = await call(client, "rcwa_capabilities")
        assert caps["project_schema_version"] == "1.2"
        example = await call(client, "rcwa_example")
        valid = await call(client, "rcwa_validate", {"project": example})
        assert valid["valid"] and valid["project"] == example
        preview = await call(client, "rcwa_preview_changes", {
            "base_project": example, "changes": {"period_nm": 100, "cd_nm": 90},
        })
        assert preview["schema_version"] == "rcwa-change-proposal/1.0"
        assert preview["valid"] and preview["base_project"] == example
        assert preview["candidate_project"]["period_nm"] == 100
        assert preview["candidate_project"]["layers"][0]["cd_nm"] == 90
        assert [entry["field"] for entry in preview["diff"]] == ["period_nm", "cd_nm"]
        with httpx.Client(trust_env=False) as http:
            direct = http.post(real_api + "/api/change-preview", json={
                "base_project": example, "changes": {"period_nm": 100, "cd_nm": 90},
            })
            assert direct.json() == preview
            assert http.get(real_api + "/api/projects").json() == []
        await call(client, "rcwa_preview_changes", {"base_project": example, "changes": {}}, error=True)
        await call(client, "rcwa_validate", {"project": {"period_nm": "400"}}, error=True)
    assert len(children) == 1 and children[0].returncode is not None
