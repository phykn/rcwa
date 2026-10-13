"""Both real stdio protocols recover durable exact inputs without HTTP escape."""

from contextlib import contextmanager
import ast
from copy import deepcopy
import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

import httpx
from jsonschema import Draft202012Validator
import pytest

pytest.importorskip('mcp')
from mcp import Client

from api.snapshot_views import snapshot_index, snapshot_inputs
from mcp_adapter.client import AdapterError, LocalAPI
from mcp_adapter.server import create_server, OPERATIONS, MAX_PROTOCOL_ID_BYTES, MAX_STDIO_RESPONSE_BYTES
import test_mcp_protocol as protocol
import test_2d_mcp_transport as transport
import test_agent_summaries as summaries

anyio_backend = protocol.anyio_backend
circular_snapshot = summaries.circular_snapshot
ROOT = protocol.ROOT


def raw_call(raw, mode, request_id, name, arguments, *, error=False):
    request = transport.raw_tool_request(mode, request_id)
    request['params'].update(name=name, arguments=arguments)
    raw.send(request)
    wire = raw.receive()
    assert len(wire) <= MAX_STDIO_RESPONSE_BYTES
    response = json.loads(wire)
    assert response['id'] == request_id and 'result' in response
    result = response['result']
    assert result.get('isError', False) == error, result
    payload = json.loads(result['content'][0]['text'])
    # Modern MCP changes result envelope aliases; the SDK's exact writer remains
    # the source of truth, and the text view is present in both protocols.
    if 'structuredContent' in result:
        assert result['structuredContent'] == payload
    print(json.dumps({'mode': mode, 'tool': name, 'view': arguments.get('view'), 'wire_bytes': len(wire),
                      'request_id_bytes': len(json.dumps(request_id, ensure_ascii=False).encode()),
                      'is_error': error}))
    return payload


@contextmanager
def durable_api(tmp_path, fixture, *, seed_job):
    """A real loopback API restart retains SQLite but not the preloaded job."""
    port = protocol.available_port()
    url = f'http://127.0.0.1:{port}'
    marker = tmp_path / 'unexpected-submit.txt'
    module = tmp_path / 'saved_reuse_api.py'
    module.write_text('''from contextlib import asynccontextmanager
import gzip, json, os
from pathlib import Path
from api.main import create_app
from api.contracts import StoredServerSnapshot
app = create_app(os.environ["DATABASE_URL"])
original = app.router.lifespan_context
@asynccontextmanager
async def lifespan(app):
    async with original(app):
        if os.environ["SEED_JOB"] == "1":
            saved = json.load(gzip.open(os.environ["RESOURCE_SNAPSHOT"], "rt", encoding="utf-8"))
            StoredServerSnapshot.model_validate(saved, strict=True)
            origin = saved["provenance"]
            job_id = origin["job_id"]
            app.state.jobs.jobs[job_id] = {
                "id": job_id, "kind": "forward", "status": "succeeded", "created_at": origin["submitted_at"],
                "completed_at": origin["completed_at"], "input_hash": origin["input_hash"],
                "result": saved["result"], "error": None, "error_code": None,
            }
            app.state.jobs.inputs[job_id] = {"project": saved["project"], "fit": None}
        def forbidden_submit(*args, **kwargs):
            Path(os.environ["SUBMIT_MARKER"]).write_text("unexpected submission", encoding="utf-8")
            raise RuntimeError("Recovery must not start jobs")
        app.state.jobs.submit = forbidden_submit
        yield
app.router.lifespan_context = lifespan
''', encoding='utf-8')
    env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(ROOT / 'backend'), str(tmp_path)]),
           'DATABASE_URL': f'sqlite:///{tmp_path / "reuse.db"}', 'RESOURCE_SNAPSHOT': str(fixture.resolve()),
           'SUBMIT_MARKER': str(marker), 'SEED_JOB': '1' if seed_job else '0',
           'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1'}
    with (tmp_path / 'api.log').open('w+', encoding='utf-8') as log:
        process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'saved_reuse_api:app', '--host', '127.0.0.1',
                                    '--port', str(port)], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            with httpx.Client(trust_env=False, timeout=0.3) as http:
                for _ in range(200):
                    if process.poll() is not None:
                        log.seek(0)
                        pytest.fail(log.read())
                    try:
                        if http.get(url + '/api/health').status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.05)
                else:
                    pytest.fail('Recovery API did not start')
            yield url, marker
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


@pytest.mark.parametrize('mode', ['legacy', 'auto'])
@pytest.mark.parametrize('geometry', ['rectangle', 'circle'])
def test_max_tables_real_stdio_lost_receipt_restart_list_inputs_summary(tmp_path, mode, geometry):
    fixture = Path(__file__).parent / 'fixtures/true-2d' / (
        'circular-max-resource-snapshot.json.gz' if geometry == 'circle' else 'max-resource-snapshot.json.gz')
    saved = json.load(gzip.open(fixture, 'rt', encoding='utf-8'))
    job_id = saved['provenance']['job_id']
    request_id = transport.protocol_id('unicode', MAX_PROTOCOL_ID_BYTES)
    with durable_api(tmp_path, fixture, seed_job=True) as (url, marker):
        with transport.raw_stdio(url) as raw:
            if mode == 'legacy':
                raw.send(transport.initialize_request(request_id))
                assert json.loads(raw.receive())['id'] == request_id
                raw.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
            empty = raw_call(raw, mode, request_id, 'rcwa_list_snapshots', {})
            assert empty['snapshots'] == [] and not empty['may_have_more']
            # Full save genuinely succeeds in storage, but its wire response is
            # too large. Keep only job_id, exactly as with a lost receipt.
            failure = raw_call(raw, mode, request_id, 'rcwa_save_snapshot', {'job_id': job_id}, error=True)
            assert failure['outcome_unknown'] and failure['error']['code'] == 'response_too_large'
            assert 'rcwa_list_snapshots' in failure['error']['message']
        assert not marker.exists()
    with durable_api(tmp_path, fixture, seed_job=False) as (url, marker):
        with transport.raw_stdio(url) as raw:
            if mode == 'legacy':
                raw.send(transport.initialize_request(request_id))
                assert json.loads(raw.receive())['id'] == request_id
                raw.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
            expired = raw_call(raw, mode, request_id, 'rcwa_get_job', {'job_id': job_id}, error=True)
            assert expired['error']['code'] == 'job_missing'
            index = raw_call(raw, mode, request_id, 'rcwa_list_snapshots', {})
            matches = [entry for entry in index['snapshots'] if entry['provenance']['job_id'] == job_id]
            assert len(matches) == 1 and not index['may_have_more']
            snapshot_id = matches[0]['id']
            inputs = raw_call(raw, mode, request_id, 'rcwa_get_snapshot', {'snapshot_id': snapshot_id, 'view': 'inputs'})
            summary = raw_call(raw, mode, request_id, 'rcwa_get_snapshot', {'snapshot_id': snapshot_id, 'view': 'summary'})
            assert inputs['project'] == saved['project']  # Every table number, name and source is retained.
            assert inputs['provenance'] == summary['provenance'] == saved['provenance']
            assert inputs['input_hash'] == summary['input_hash'] == saved['provenance']['input_hash']
            assert 'result' not in inputs and 'result_summary' not in inputs
            assert summary['result_summary']['spectra']['p']['T'] == saved['result']['spectra']['p']['T']
            assert summary['result_summary']['warnings'] == saved['result']['warnings']
            assert summary['result_summary']['warnings_omitted_count'] == 0
            assert raw_call(raw, mode, request_id, 'rcwa_list_snapshots', {}) == index
        assert not marker.exists()
        # Extra read-only test evidence; the recovery above uses MCP exclusively.
        with httpx.Client(trust_env=False, timeout=30) as http:
            assert len(http.get(url + '/api/projects').json()) == 1
            full = http.get(url + '/api/projects/' + snapshot_id).json()
            assert full['project'] == saved['project'] and full['result'] == saved['result']


@pytest.mark.anyio
@pytest.mark.parametrize('tamper', ['id', 'hash', 'project', 'provenance_hash', 'provenance_version', 'job',
                                  'result', 'summary', 'full', 'unnormalized', 'numeric_form', 'oversized'])
async def test_mcp_rejects_input_view_identity_and_contract_substitution(circular_snapshot, tamper):
    payload = snapshot_inputs(circular_snapshot)
    if tamper == 'id':
        payload['id'] = 'wrong'
    elif tamper == 'hash':
        payload['input_hash'] = '0' * 64
    elif tamper == 'project':
        payload['project']['layers'][0]['diameter_nm'] += 1
    elif tamper == 'provenance_hash':
        payload['provenance']['input_hash'] = '0' * 64
    elif tamper == 'provenance_version':
        payload['provenance']['project_schema_version'] = '1.0'
    elif tamper == 'job':
        payload['provenance']['job_id'] = None
    elif tamper == 'result':
        payload['result'] = None
    elif tamper == 'summary':
        payload['result_summary'] = None
    elif tamper == 'full':
        payload = deepcopy(circular_snapshot)
    elif tamper == 'unnormalized':
        del payload['project']['ambient']['source']
    elif tamper == 'numeric_form':
        assert isinstance(payload['project']['period_nm'], float)
        payload['project']['period_nm'] = int(payload['project']['period_nm'])
    elif tamper == 'oversized':
        payload['name'] = '🧪' * 800_000
    calls = []
    def respond(request):
        calls.append(str(request.url))
        return httpx.Response(200, json=payload)
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        async with Client(create_server(api)) as client:
            error = await protocol.call(client, 'rcwa_get_snapshot', {
                'snapshot_id': circular_snapshot['id'], 'view': 'inputs',
            }, error=True)
            assert error['error']['code'] == 'invalid_api_response'
            assert not error.get('outcome_unknown', False)
            assert len(json.dumps(error)) < 1000 and len(calls) == 1
    finally:
        await api.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize('tamper', ['array', 'may_have_more', 'limit', 'oversized', 'extra_result', 'duplicate_id'])
async def test_mcp_rejects_incomplete_or_oversized_index(circular_snapshot, tamper):
    entry = {key: circular_snapshot[key] for key in ['id', 'name', 'created_at', 'updated_at', 'provenance']}
    payload = snapshot_index([entry])
    if tamper == 'array':
        payload = payload['snapshots']
    elif tamper == 'may_have_more':
        payload['may_have_more'] = True
    elif tamper == 'limit':
        payload['limit'] = 101
    elif tamper == 'oversized':
        payload['snapshots'][0]['name'] = '界' * 50_000
    elif tamper == 'extra_result':
        payload['snapshots'][0]['result'] = None
    elif tamper == 'duplicate_id':
        payload['snapshots'].append(deepcopy(payload['snapshots'][0]))
    api = LocalAPI(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)))
    try:
        async with Client(create_server(api)) as client:
            error = await protocol.call(client, 'rcwa_list_snapshots', error=True)
            assert error['error']['code'] == ('api_unavailable' if tamper == 'array' else 'invalid_api_response')
            assert not error.get('outcome_unknown', False)
    finally:
        await api.aclose()


@pytest.mark.anyio
async def test_transport_allows_only_exact_read_routes_and_no_discovery_arguments():
    calls = []
    def respond(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={})
    api = LocalAPI(transport=httpx.MockTransport(respond))
    try:
        for method, path in [
            ('GET', '/api/projects'), ('GET', '/api/projects?view=index&limit=100'),
            ('GET', '/api/projects?view=index&cursor=x'), ('GET', '/api/projects?view=index&url=http://example.com'),
            ('POST', '/api/projects?view=index'), ('GET', '/api/jobs/id?view=inputs'),
            ('DELETE', '/api/projects/id?view=inputs'), ('DELETE', '/api/jobs/id?view=inputs'),
            ('GET', '/api/projects/id?view=inputs&other=1'), ('GET', '/api/projects/id?view=inputs#x'),
            ('GET', 'http://example.com/api/projects?view=index'),
        ]:
            with pytest.raises(AdapterError, match='not exposed'):
                await api.request(method, path)
        async with Client(create_server(api)) as client:
            for args in [{'limit': 1}, {'name': 'design'}, {'cursor': 'x'}, {'url': 'http://example.com'}]:
                error = await protocol.call(client, 'rcwa_list_snapshots', args, error=True)
                assert error['error']['code'] == 'invalid_arguments'
        assert not calls
        for path in ['/api/projects?view=index', '/api/projects/id?view=inputs']:
            await api.request('GET', path)
        assert calls == ['http://127.0.0.1:8000/api/projects?view=index', 'http://127.0.0.1:8000/api/projects/id?view=inputs']
    finally:
        await api.aclose()


def test_new_tool_advertises_readonly_bounded_schema_and_explicit_input_view():
    tools = {operation.name: operation.tool() for operation in OPERATIONS}
    assert len(tools) == 12
    listing = tools['rcwa_list_snapshots']
    assert listing.annotations.read_only_hint and listing.annotations.idempotent_hint
    assert not listing.annotations.destructive_hint and not listing.annotations.open_world_hint
    assert listing.input_schema['properties'] == {} and listing.input_schema['additionalProperties'] is False
    assert 'untrusted labels' in listing.description and 'unresolved' in listing.description
    assert tools['rcwa_get_snapshot'].input_schema['properties']['view']['enum'] == ['full', 'summary', 'inputs']
    for tool in tools.values():
        Draft202012Validator.check_schema(tool.input_schema)
        Draft202012Validator.check_schema(tool.output_schema)


def test_both_resource_fixture_readers_ignore_non_utf8_locale(monkeypatch):
    # Exercise the actual two read expressions, including the generated API
    # subprocess source, with Windows' locale fallback on every platform.
    source = ast.parse(Path(__file__).read_text(encoding='utf-8'))
    embedded = [node.value for node in ast.walk(source) if isinstance(node, ast.Constant)
                and isinstance(node.value, str) and node.value.startswith('from contextlib import asynccontextmanager\n')
                and 'app.router.lifespan_context = lifespan' in node.value]
    assert len(embedded) == 1
    readers = [node for tree in [source, ast.parse(embedded[0])] for node in ast.walk(tree)
               if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
               and isinstance(node.func.value, ast.Name) and node.func.value.id == 'gzip' and node.func.attr == 'open']
    assert len(readers) == 2
    fixture = Path(__file__).parent / 'fixtures/true-2d/circular-max-resource-snapshot.json.gz'
    expected = json.loads(gzip.decompress(fixture.read_bytes()))
    monkeypatch.setattr(gzip.io, 'text_encoding', lambda encoding, *args: encoding or 'cp1252')
    context = {'gzip': gzip, 'fixture': fixture, 'os': SimpleNamespace(environ={'RESOURCE_SNAPSHOT': str(fixture)})}
    for reader in readers:
        with eval(compile(ast.Expression(reader), '<fixture reader>', 'eval'), context) as stream:
            assert json.load(stream) == expected


def test_new_saved_design_text_io_always_declares_utf8():
    sources = [ast.parse(path.read_text(encoding='utf-8')) for path in [
        Path(__file__), Path(__file__).with_name('test_saved_design_reuse.py'),
    ]]
    embedded = [node.value for node in ast.walk(sources[0]) if isinstance(node, ast.Constant)
                and isinstance(node.value, str) and node.value.startswith('from contextlib import asynccontextmanager\n')
                and 'app.router.lifespan_context = lifespan' in node.value]
    sources.extend(ast.parse(text) for text in embedded)
    calls = [node for source in sources for node in ast.walk(source)
             if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
             and node.func.attr in {'read_text', 'write_text', 'open'}]
    assert calls
    for call in calls:
        encoding = next((keyword.value for keyword in call.keywords if keyword.arg == 'encoding'), None)
        assert isinstance(encoding, ast.Constant) and encoding.value == 'utf-8', ast.unparse(call)
