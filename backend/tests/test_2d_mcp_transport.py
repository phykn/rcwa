"""Exact SDK transport byte/ID limits and recovery of an oversized real snapshot.

The archived max-resource snapshot is transport/resource evidence only. It does
not establish numerical convergence, and these tests never launch an H5 solve.
"""

from contextlib import contextmanager
from copy import deepcopy
import gzip
import hashlib
import json
import os
from pathlib import Path
from queue import Empty, Queue
import subprocess
import sys
from threading import Thread
import time
from types import SimpleNamespace

import httpx
import pytest

pytest.importorskip("mcp")
from mcp import Client
from mcp.types import JSONRPCResponse
from mcp.types.methods import serialize_server_result

from api.contracts import StoredServerSnapshot
from mcp_adapter.client import LocalAPI
from mcp_adapter.server import (
    BoundedProtocolIDs, MAX_PROTOCOL_ID_BYTES, MAX_STDIO_RESPONSE_BYTES, ProtocolIDTooLarge,
    create_server, result, stdio_response_bytes,
)
import test_mcp_protocol as protocol_tests
from test_project_dispatch import small_2d_project


anyio_backend = protocol_tests.anyio_backend
ROOT = protocol_tests.ROOT
FIXTURE = Path(__file__).parent / "fixtures" / "true-2d" / "max-resource-snapshot.json.gz"
RAW_SHA256 = "107d45e34f0dab7497ec12b5a2ee73c3a040ac2f7e7cb55a54384f2b4b2396cd"
VERSIONS = ["2025-11-25", "2026-07-28"]


@pytest.fixture(scope="module")
def max_resource_snapshot():
    with gzip.open(FIXTURE, "rb") as stream:
        raw = stream.read()
    assert len(raw) == 4_234_489
    assert hashlib.sha256(raw).hexdigest() == RAW_SHA256
    snapshot = json.loads(raw)
    # This is the actual artifact, not a fabricated padding result or a relabeled
    # numerical-only archive. Bind its complete powers, project and provenance.
    StoredServerSnapshot.model_validate(snapshot, strict=True)
    assert len(snapshot["project"]["layers"]) == 8
    assert len(snapshot["project"]["illumination"]["wavelengths_nm"]) == 31
    assert snapshot["result"]["metadata"]["basis_size"] == 121
    return snapshot


def serialize_tool(payload, version):
    return serialize_server_result("tools/call", version,
                                   result(payload).model_dump(by_alias=True, exclude_none=True))


@pytest.mark.parametrize("request_id", [37, 10 ** 1023, "simple", '"\\\n界🧪'])
def test_exact_stdio_size_is_the_actual_sdk_writer_including_request_id_and_lf(request_id):
    payload = {"content": [{"type": "text", "text": 'quote" slash\\ newline\n界🧪'}]}
    expected = JSONRPCResponse(jsonrpc="2.0", id=request_id, result=payload)
    expected_bytes = (expected.model_dump_json(by_alias=True, exclude_unset=True) + "\n").encode("utf-8")
    actual = stdio_response_bytes(payload, request_id)
    assert actual == expected_bytes
    assert json.loads(actual)["id"] == request_id
    assert actual.endswith(b"\n")
    assert len(actual) > len(actual.decode("utf-8"))


@pytest.mark.anyio
@pytest.mark.parametrize("version", VERSIONS)
@pytest.mark.parametrize("special", ['"', "\\", "\n", "界", "🧪"])
@pytest.mark.parametrize("delta", [0, 1])
async def test_post_serialization_cap_accepts_exact_bytes_and_replaces_one_byte_over(version, special, delta):
    api = LocalAPI()
    try:
        middleware = create_server(api).middleware[-1]
        request_id = 'request"\\\n界🧪'
        payload = serialize_tool({"label": special * 7}, version)
        payload["_meta"] = {"serverInfo": {"name": "RCWA Workbench", "version": "0.1.0"}}
        remaining = MAX_STDIO_RESPONSE_BYTES + delta - len(stdio_response_bytes(payload, request_id))
        payload["content"][0]["text"] += "a" * remaining
        assert len(stdio_response_bytes(payload, request_id)) == 8_000_000 + delta
        context = SimpleNamespace(method="tools/call", request_id=request_id, protocol_version=version,
                                  params={"name": "rcwa_get_snapshot", "arguments": {"snapshot_id": "snapshot-1"}})
        calls = []
        async def call_next(ctx):
            calls.append(ctx)
            return payload
        bounded = await middleware(context, call_next)
        assert calls == [context]
        if delta == 0:
            assert bounded is payload
        else:
            response = json.loads(bounded["content"][0]["text"])
            assert response["error"]["code"] == "response_too_large"
            assert not response.get("outcome_unknown", False)
            assert "/api/projects/snapshot-1" in response["error"]["message"]
            assert bounded["_meta"] == payload["_meta"]
            assert len(stdio_response_bytes(bounded, request_id)) < 5000
            assert "a" * 100 not in json.dumps(bounded)
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("version", VERSIONS)
async def test_real_max_resource_snapshot_is_replaced_without_large_domain_echo(max_resource_snapshot, version):
    api = LocalAPI()
    try:
        middleware = create_server(api).middleware[-1]
        snapshot = deepcopy(max_resource_snapshot)
        payload = serialize_tool(snapshot, version)
        request_id = 101
        assert len(stdio_response_bytes(payload, request_id)) > MAX_STDIO_RESPONSE_BYTES
        context = SimpleNamespace(method="tools/call", request_id=request_id, protocol_version=version,
                                  params={"name": "rcwa_save_snapshot", "arguments": {
                                      "job_id": snapshot["provenance"]["job_id"]}})
        async def call_next(ctx):
            return payload
        bounded = await middleware(context, call_next)
        error = json.loads(bounded["content"][0]["text"])
        assert error["error"]["code"] == "response_too_large"
        assert error["outcome_unknown"]
        assert "HTTP POST http://127.0.0.1:8000/api/snapshots" in error["error"]["message"]
        assert "same job_id" in error["error"]["message"]
        assert "do not start a new calculation" in error["error"]["message"]
        assert len(stdio_response_bytes(bounded, request_id)) < 5000
        assert "retained_orders" not in json.dumps(bounded)
        assert "[truncated]" not in json.dumps(bounded)
    finally:
        await api.aclose()


def protocol_id(kind, size):
    if kind == "numeric":
        return 10 ** (size - 1)
    prefix = {"ascii": "id-", "escaped": '"\\\n' * 10, "unicode": "界🧪" * 10}[kind]
    return prefix + "x" * (size - len(json.dumps(prefix, ensure_ascii=False).encode("utf-8")))


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["numeric", "ascii", "escaped", "unicode"])
@pytest.mark.parametrize("delta", [0, 1])
async def test_protocol_id_guard_measures_serialized_utf8_and_never_rewrites(kind, delta):
    request_id = protocol_id(kind, MAX_PROTOCOL_ID_BYTES + delta)
    item = SimpleNamespace(message=SimpleNamespace(id=request_id))
    assert len(json.dumps(request_id, ensure_ascii=False).encode("utf-8")) == MAX_PROTOCOL_ID_BYTES + delta
    class Receive:
        closed = False
        async def receive(self):
            return item
        async def aclose(self):
            self.closed = True
    original = Receive()
    guarded = BoundedProtocolIDs(original)
    if delta:
        with pytest.raises(ProtocolIDTooLarge):
            await guarded.receive()
    else:
        assert await guarded.receive() is item
    await guarded.aclose()
    assert original.closed


@pytest.fixture
def preloaded_resource_api(tmp_path, max_resource_snapshot):
    """One real API with one previously verified succeeded result, no computation."""
    port = protocol_tests.available_port()
    url = f"http://127.0.0.1:{port}"
    marker = tmp_path / "unexpected-submit.txt"
    module = tmp_path / "preloaded_resource_api.py"
    module.write_text('''from contextlib import asynccontextmanager
import gzip
import json
import os
from pathlib import Path
from api.main import create_app
from api.contracts import StoredServerSnapshot
app = create_app(os.environ["DATABASE_URL"])
original_lifespan = app.router.lifespan_context
@asynccontextmanager
async def lifespan(app):
    async with original_lifespan(app):
        with gzip.open(os.environ["RESOURCE_SNAPSHOT"], "rt", encoding="utf-8") as stream:
            saved = json.load(stream)
        StoredServerSnapshot.model_validate(saved, strict=True)
        provenance = saved["provenance"]
        job_id = provenance["job_id"]
        app.state.jobs.jobs[job_id] = {
            "id": job_id, "kind": "forward", "status": "succeeded", "created_at": provenance["submitted_at"],
            "completed_at": provenance["completed_at"], "input_hash": provenance["input_hash"],
            "result": saved["result"], "error": None, "error_code": None,
        }
        app.state.jobs.inputs[job_id] = {"project": saved["project"], "fit": None}
        original_submit = app.state.jobs.submit
        def observed_submit(*args, **kwargs):
            Path(os.environ["SUBMIT_MARKER"]).write_text("unexpected calculation submission")
            return original_submit(*args, **kwargs)
        app.state.jobs.submit = observed_submit
        yield
app.router.lifespan_context = lifespan
''', encoding="utf-8")
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(ROOT / "backend"), str(tmp_path)]),
           "DATABASE_URL": f"sqlite:///{tmp_path / 'transport.db'}", "RESOURCE_SNAPSHOT": str(FIXTURE.resolve()),
           "SUBMIT_MARKER": str(marker), "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
    with (tmp_path / "transport-api.log").open("w+") as log:
        process = subprocess.Popen([sys.executable, "-m", "uvicorn", "preloaded_resource_api:app", "--host",
                                    "127.0.0.1", "--port", str(port)], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            with httpx.Client(trust_env=False, timeout=0.3) as http:
                for _ in range(200):
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
                    pytest.fail("Resource test API did not start")
            yield url, max_resource_snapshot["provenance"]["job_id"], marker
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_real_oversized_stdio_save_is_recoverable_by_http_without_resubmitting(preloaded_resource_api, mode):
    url, job_id, marker = preloaded_resource_api
    async with Client(protocol_tests.parameters(url), mode=mode, read_timeout_seconds=30) as client:
        error = await protocol_tests.call(client, "rcwa_save_snapshot", {"job_id": job_id}, error=True)
        assert error["error"]["code"] == "response_too_large" and error["outcome_unknown"]
        assert f"HTTP POST {url}/api/snapshots" in error["error"]["message"]
        assert len(json.dumps(error).encode()) < 5000
        assert "retained_orders" not in json.dumps(error)
        with httpx.Client(trust_env=False, timeout=30) as http:
            listing = http.get(url + "/api/projects").json()
            assert len(listing) == 1  # The first MCP save succeeded despite its oversized response.
            saved = http.get(url + "/api/projects/" + listing[0]["id"]).json()
            assert saved["provenance"]["job_id"] == job_id
            repeated = http.post(url + "/api/snapshots", json={"job_id": job_id})
            assert repeated.status_code == 201
            assert repeated.json() == saved
            assert len(http.get(url + "/api/projects").json()) == 1
            full_import = json.dumps({"project": saved["project"], "result": saved["result"]},
                                     ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            assert len(full_import) > 2_000_000
            rejected = http.post(url + "/api/projects", content=full_import,
                                 headers={"Content-Type": "application/json"})
            assert rejected.status_code == 413
            assert rejected.json()["error"]["code"] == "body_too_large"
            project_only = json.dumps({"project": saved["project"], "result": None},
                                      ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            assert len(project_only) <= 2_000_000
            imported = http.post(url + "/api/projects", content=project_only,
                                 headers={"Content-Type": "application/json"})
            assert imported.status_code == 201, imported.text
            assert imported.json()["provenance"]["source"] == "unverified_import"
            assert imported.json()["result"] is None
        read_error = await protocol_tests.call(client, "rcwa_get_snapshot", {"snapshot_id": saved["id"]}, error=True)
        assert read_error["error"]["code"] == "response_too_large"
        assert not read_error.get("outcome_unknown", False)
        assert f"HTTP GET {url}/api/projects/{saved['id']}" in read_error["error"]["message"]
        assert (await protocol_tests.call(client, "rcwa_capabilities"))["engine"]["available"]
    async with Client(protocol_tests.parameters(url), mode=mode, read_timeout_seconds=15) as client:
        assert (await protocol_tests.call(client, "rcwa_validate", {"project": small_2d_project()}))["valid"]
    assert not marker.exists()


@contextmanager
def raw_stdio(url):
    """Portable line reader with bounded waits, including Windows anonymous pipes."""
    process = subprocess.Popen([sys.executable, "-m", "mcp_adapter.server", "--api-url", url], cwd=ROOT,
                               env={**os.environ, "PYTHONPATH": str(ROOT / "backend"),
                                    "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"},
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    received = Queue()
    def read_lines():
        while True:
            line = process.stdout.readline()
            received.put(line)
            if not line:
                break
    reader = Thread(target=read_lines, daemon=True)
    reader.start()
    def send(payload):
        process.stdin.write(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
        process.stdin.flush()
    def receive():
        try:
            return received.get(timeout=15)
        except Empty:
            pytest.fail("Real MCP subprocess did not respond or close within 15 seconds")
    try:
        yield SimpleNamespace(process=process, send=send, receive=receive)
    finally:
        if process.poll() is None:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        reader.join(timeout=5)
        assert not reader.is_alive()
        process.stdout.close()
        process.stderr.close()
        if not process.stdin.closed:
            process.stdin.close()


def initialize_request(request_id):
    return {"jsonrpc": "2.0", "id": request_id, "method": "initialize", "params": {
        "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "RCWA boundary test", "version": "1"},
    }}


def raw_tool_request(mode, request_id, *, mutate=False):
    from mcp_types import CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY

    params = {"name": "rcwa_submit" if mutate else "rcwa_validate", "arguments": (
        {"request": {"project": small_2d_project()}} if mutate else {"project": small_2d_project()}
    )}
    if mode == "auto":
        params["_meta"] = {PROTOCOL_VERSION_META_KEY: "2026-07-28", CLIENT_CAPABILITIES_META_KEY: {},
                           CLIENT_INFO_META_KEY: {"name": "RCWA boundary test", "version": "1"}}
    return {"jsonrpc": "2.0", "id": request_id, "method": "tools/call", "params": params}


@pytest.mark.parametrize("kind", ["numeric", "ascii", "escaped", "unicode"])
def test_oversized_initialize_protocol_id_closes_cleanly_without_echo(kind):
    with raw_stdio(f"http://127.0.0.1:{protocol_tests.available_port()}") as raw:
        raw.send(initialize_request(protocol_id(kind, MAX_PROTOCOL_ID_BYTES + 1)))
        assert raw.process.wait(timeout=10) == 0
        assert raw.receive() == b""


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
@pytest.mark.parametrize("kind", ["numeric", "ascii", "escaped", "unicode"])
async def test_real_protocol_id_edges_close_before_mutation_and_allow_fresh_client(preloaded_resource_api, mode, kind):
    url, _, marker = preloaded_resource_api
    exact_id = protocol_id(kind, MAX_PROTOCOL_ID_BYTES)
    excessive_id = protocol_id(kind, MAX_PROTOCOL_ID_BYTES + 1)
    with raw_stdio(url) as raw:
        if mode == "legacy":
            raw.send(initialize_request(exact_id))
            initialized = json.loads(raw.receive())
            assert initialized["id"] == exact_id
            assert initialized["result"]["protocolVersion"] == "2025-11-25"
            raw.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        # Modern MCP carries its protocol metadata on each request and has no
        # initialize exchange; both real wire modes test this tools/call edge.
        raw.send(raw_tool_request(mode, exact_id))
        accepted = json.loads(raw.receive())
        assert accepted["id"] == exact_id and "result" in accepted
        assert json.loads(accepted["result"]["content"][0]["text"])["valid"]
        raw.send(raw_tool_request(mode, excessive_id, mutate=True))
        assert raw.process.wait(timeout=10) == 0
        assert raw.receive() == b""  # No oversized ID echo and no fake tool result.
        assert not marker.exists()
    async with Client(protocol_tests.parameters(url), mode=mode, read_timeout_seconds=15) as client:
        assert (await protocol_tests.call(client, "rcwa_validate", {"project": small_2d_project()}))["valid"]
    assert not marker.exists()
