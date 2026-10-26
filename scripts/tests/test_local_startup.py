import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from process_tree import Identity, Process, assert_stopped, descendants, identities, interrupt, processes, root_identity

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("start_local", ROOT / "scripts/start_local.py")
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)
LOG_DIR = Path(os.environ.get("RCWA_LAUNCHER_LOG_DIR", ROOT / "artifacts/local-startup"))
LOG_DIR.mkdir(parents=True, exist_ok=True)


def test_process_observer_rejects_stale_intermediate_parent_edges():
    root = Identity(10, 100)
    table = {
        10: Process(1, "python.exe", True, 100),
        20: Process(10, "conhost.exe", True, 101),
        30: Process(20, "python.exe", True, 10),  # Old child of a reused PID.
        40: Process(30, "python.exe", True, 20),
        50: Process(20, "python.exe", True, 102),  # Same name, genuinely owned.
        60: Process(50, "python.exe", True, 103),
    }
    assert descendants(root, table) == {Identity(20, 101), Identity(50, 102), Identity(60, 103)}


@pytest.mark.parametrize("root_present", [False, True])
def test_process_observer_retains_orphans_without_adopting_replacement(root_present):
    table = {20: Process(10, "python.exe", True, 101)}
    if root_present:
        table.update({10: Process(1, "python.exe", True, 200), 30: Process(10, "python.exe", True, 201)})
    assert descendants(Identity(10, 100), table) == {Identity(20, 101)}


@pytest.mark.parametrize("created", [None, 100])
def test_process_observer_does_not_hide_unknown_or_surviving_owned_identity(monkeypatch, created):
    table = {10: Process(1, "python.exe", True, created, "test unknown" if created is None else None)}
    monkeypatch.setattr("process_tree.processes", lambda: table)
    with pytest.raises(AssertionError):
        assert_stopped({Identity(10, 100)}, timeout=0)


def test_process_observer_does_not_mistake_reused_pid_for_survivor(monkeypatch):
    monkeypatch.setattr("process_tree.processes", lambda: {10: Process(1, "python.exe", True, 200)})
    assert_stopped({Identity(10, 100)}, timeout=0)


def test_process_observer_unknown_child_fails_closed():
    table = {20: Process(10, "unknown.exe", True, None, "access denied")}
    with pytest.raises(AssertionError, match="Cannot identify candidate child"):
        descendants(Identity(10, 100), table)


@pytest.mark.skipif(os.name == "nt", reason="Linux /proc executable-name permissions")
def test_process_observer_inaccessible_name_does_not_hide_identity(monkeypatch):
    def denied(_):
        raise PermissionError("test executable name unavailable")
    monkeypatch.setattr("process_tree.os.readlink", denied)
    table = processes()
    record = table[os.getpid()]
    assert record.executable == "<unreadable>" and record.created is not None
    assert "test executable name unavailable" in record.error
    monkeypatch.setattr("process_tree.processes", lambda: table)
    with pytest.raises(AssertionError, match="Owned processes remain"):
        assert_stopped({Identity(os.getpid(), record.created)}, timeout=0)


def test_process_observer_actual_birth_identity_and_census():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        identity = root_identity(child)
        table = processes()
        (LOG_DIR / "process-census.json").write_text(json.dumps(table, indent=2))
        assert identities({child.pid}, table) == {identity}
        assert table[child.pid].parent == os.getpid()
        with pytest.raises(AssertionError, match="Owned processes remain"):
            assert_stopped({identity}, timeout=0)
    finally:
        child.terminate()
        child.wait(timeout=5)
    assert_stopped({identity})


@pytest.fixture(scope="module")
def checkout(tmp_path_factory):
    root = tmp_path_factory.mktemp("launcher acceptance") / "checkout with spaces"
    def ignore(directory, names):
        patterns = [".git", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", "artifacts", "*.db"]
        if Path(directory) == ROOT / "frontend":
            patterns.append("dist")
        return shutil.ignore_patterns(*patterns)(directory, names)
    shutil.copytree(ROOT, root, ignore=ignore)
    return root


@pytest.fixture
def edit():
    originals = {}

    def change(path, text):
        originals.setdefault(path, path.read_bytes() if path.exists() else None)
        path.write_text(text, encoding="utf-8")
    yield change
    for path, content in originals.items():
        if content is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(content)


class RunningLauncher:
    def __init__(self, root, tmp_path, name, env=None):
        self.log = LOG_DIR / f"{name}.log"
        self.stream = self.log.open("w", encoding="utf-8")
        environment = os.environ.copy()
        for key in ("VITE_API_BASE_URL", "DATABASE_URL"):
            environment.pop(key, None)
        environment.update({"PYTHONUNBUFFERED": "1", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"})
        if env:
            environment.update(env)
        self.process = subprocess.Popen(
            [sys.executable, str(root / "scripts/start_local.py")], cwd=tmp_path,
            stdout=self.stream, stderr=subprocess.STDOUT, env=environment,
            creationflags=subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0,
        )
        try:
            self.identity = root_identity(self.process)
        except BaseException:
            # launch() cannot register this object until construction returns.
            try:
                interrupt(self.process)
                self.process.wait(timeout=20)
            finally:
                self.stream.close()
            raise
        self.owned = set()

    def text(self):
        return self.log.read_text(encoding="utf-8", errors="replace")

    def wait_for(self, text, timeout=40):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.owned.update(descendants(self.identity))
            if text in self.text():
                return
            assert self.process.poll() is None, self.text()
            time.sleep(0.02)
        pytest.fail(f"Timed out waiting for {text}:\n{self.text()}")

    def stop(self, repeated=False):
        try:
            self.owned.update(descendants(self.identity))
            self.observe("before-stop")
        finally:
            # Observation errors fail the test, but must not skip owned cleanup.
            interrupt(self.process, repeat=3 if repeated else 1)
            code = self.process.wait(timeout=20)
            self.stream.close()
            self.observe("after-stop")
        assert_stopped(self.owned)
        ports_reusable()
        return code

    def close(self):
        if self.process.poll() is None:
            self.stop()
        self.stream.close()

    def observe(self, phase, table=None):
        table = processes() if table is None else table
        tracked = self.owned | descendants(self.identity, table) | {self.identity}
        self.log.with_name(f"{self.log.stem}-{phase}.json").write_text(json.dumps({
            "supervisor": self.process.pid,
            "tracked": sorted(tracked),
            "present": {item.pid: table[item.pid] for item in tracked if item.pid in table},
        }, indent=2))


@pytest.fixture
def launch(checkout, tmp_path, request):
    started = []

    def start(**env):
        running = RunningLauncher(checkout, tmp_path, re.sub(r"[^a-zA-Z0-9_.-]", "_", request.node.name)[:150] + f"-{len(started) + 1}", env)
        started.append(running)
        return running
    yield start
    for running in started:
        running.close()


def ports_reusable():
    for port in (8000, 5173):
        with socket.socket() as probe:
            option = socket.SO_EXCLUSIVEADDRUSE if os.name == "nt" else socket.SO_REUSEADDR
            probe.setsockopt(socket.SOL_SOCKET, option, 1)
            probe.bind(("127.0.0.1", port))


def request(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    call = Request(f"http://127.0.0.1:5173{path}", data, {"Content-Type": "application/json"}, method=method)
    with build_opener(ProxyHandler({})).open(call, timeout=10) as response:
        return json.load(response)


def small_circle(root):
    project = json.loads((root / "backend/api/examples/circular-hole-2d.json").read_text())
    project["solver"] = {"harmonics_x": 1, "harmonics_y": 1}
    project["illumination"]["wavelengths_nm"] = [550.0]
    return project


def completed(project):
    job = request("/api/jobs", {"project": project})
    deadline = time.monotonic() + 30
    while job["status"] == "running" and time.monotonic() < deadline:
        time.sleep(0.05)
        job = request(f"/api/jobs/{job['id']}")
    assert job["status"] == "succeeded", job
    return job


def test_space_path_other_cwd_circle_snapshot_restart(checkout, launch):
    first = launch()
    first.wait_for("RCWA ready")
    assert (checkout / "rcwa-demo.db").is_file()
    job = completed(small_circle(checkout))
    snapshot = request("/api/snapshots", {"job_id": job["id"]})
    assert snapshot["result"] == job["result"]
    assert snapshot["provenance"]["input_hash"] == job["input_hash"]
    assert snapshot["provenance"]["source"] == "server_computed"
    assert first.stop() == 0, first.text()
    second = launch()
    second.wait_for("RCWA ready")
    assert request(f"/api/projects/{snapshot['id']}") == snapshot
    with pytest.raises(HTTPError) as error:
        request(f"/api/jobs/{job['id']}")
    assert error.value.code == 404
    fresh = completed(small_circle(checkout))
    assert fresh["input_hash"] == job["input_hash"]
    assert fresh["id"] != job["id"]
    assert second.stop(repeated=True) == 0, second.text()


def test_native_imports_finish_before_control_reader_starts(checkout, launch, edit):
    path = checkout / "scripts/local_runtime.py"
    source = path.read_text()
    line = "    threading.Thread(target=control, args=(stop, loop), daemon=True).start()"
    assert source.count(line) == 1
    # Synchronous guard at thread creation: fails deterministically with the old
    # ordering, before its Windows NumPy/read deadlock can consume the deadline.
    edit(path, source.replace(line,
        "    if not {'api.main', 'numpy._core._multiarray_umath', 'numpy.linalg._umath_linalg'} <= sys.modules.keys():\n"
        "        raise RuntimeError('Native imports must finish before the control reader starts')\n" + line,
    ))
    running = launch()
    running.wait_for("RCWA ready")
    assert running.stop() == 0, running.text()


@pytest.mark.parametrize("env, expected", [
    ({"DATABASE_URL": ""}, "DATABASE_URL is empty"),
    ({"DATABASE_URL": "this-is-not-a-database"}, "DATABASE_URL"),
    ({"DATABASE_URL": "sqlite:///missing-parent/cannot-open.db"}, "DATABASE_URL"),
    ({"VITE_API_BASE_URL": "https://example.invalid"}, "Clear VITE_API_BASE_URL"),
    ({"PATH": ""}, "Node.js is missing"),
])
def test_configuration_fails_closed(launch, env, expected):
    running = launch(**env)
    assert running.process.wait(timeout=40) == 1, running.text()
    assert expected in running.text(), running.text()
    assert "RCWA ready" not in running.text()
    ports_reusable()


def test_frontend_env_file_cannot_change_launch_meaning(checkout, launch, edit):
    edit(checkout / "frontend/.env.local", "VITE_API_BASE_URL=https://example.invalid\n")
    running = launch()
    assert running.process.wait(timeout=40) == 1, running.text()
    assert "Clear VITE_API_BASE_URL" in running.text(), running.text()
    assert "RCWA ready" not in running.text()
    ports_reusable()


@pytest.mark.parametrize("port", [8000, 5173])
def test_foreign_fake_health_server_is_not_adopted_or_stopped(launch, port):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'{"status":"ok","engine_available":true}'
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass
    foreign = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=foreign.serve_forever, daemon=True)
    thread.start()
    try:
        running = launch()
        assert running.process.wait(timeout=10) == 1
        assert f"Port {port} is unavailable" in running.text()
        assert "RCWA ready" not in running.text()
        with build_opener(ProxyHandler({})).open(f"http://127.0.0.1:{port}/api/health", timeout=3) as reply:
            assert json.load(reply)["status"] == "ok"
        assert thread.is_alive()
    finally:
        foreign.shutdown()
        foreign.server_close()
        thread.join(timeout=3)


def test_missing_frontend_dependency_is_actionable(checkout, launch, edit):
    edit(checkout / "frontend/node_modules/vite/package.json", '{"version":"0.0.0"}')
    running = launch()
    assert running.process.wait(timeout=15) == 1
    assert "Frontend dependency vite: expected" in running.text()
    assert "Run npm ci in frontend" in running.text()
    ports_reusable()


def test_missing_python_dependency_is_actionable(monkeypatch):
    def missing(_):
        raise importlib.metadata.PackageNotFoundError()
    monkeypatch.setattr(launcher.importlib.metadata, "version", missing)
    with pytest.raises(launcher.StartupError, match="Python dependencies do not match") as error:
        launcher.check_dependencies()
    assert ' -m pip install -r "' in str(error.value)


@pytest.mark.parametrize("version", ["v20.19.0", "v22.12.0", "v23.0.0", "invalid"])
def test_unsupported_node_version_is_actionable(monkeypatch, version):
    monkeypatch.setattr(launcher.subprocess, "run", lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, version))
    with pytest.raises(launcher.StartupError, match="Node.js"):
        launcher.check_dependencies()


@pytest.mark.parametrize("eof_only", [False, True])
def test_startup_interrupt_before_api_import(checkout, launch, edit, eof_only):
    if eof_only:
        supervisor = checkout / "scripts/start_local.py"
        edit(supervisor, supervisor.read_text().replace('process.stdin.write("stop\\n")', 'pass  # Test STOP by EOF alone.'))
    path = checkout / "scripts/local_runtime.py"
    source = path.read_text()
    marker = checkout / "runtime-started.marker"
    marker.unlink(missing_ok=True)
    edit(path, source.replace("from api.main import app", f"Path({str(marker)!r}).touch()\n    await asyncio.sleep(1)\n    from api.main import app"))
    running = launch()
    deadline = time.monotonic() + 10
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert marker.exists()
    assert running.stop(repeated=True) == 0, running.text()
    assert "RCWA ready" not in running.text()


def test_constructor_identity_failure_stops_owned_launcher(checkout, tmp_path, monkeypatch):
    captured, owned = [], set()
    original = root_identity
    log = LOG_DIR / "constructor-identity-error.log"
    def unavailable(process):
        captured.append(process)
        identity = original(process)
        owned.add(identity)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            owned.update(descendants(identity))
            if "RCWA ready" in log.read_text(errors="replace"):
                raise AssertionError("test identity unavailable")
            assert process.poll() is None
            time.sleep(0.02)
        pytest.fail("Constructor failure fixture did not reach readiness")
    monkeypatch.setattr(sys.modules[__name__], "root_identity", unavailable)
    try:
        with pytest.raises(AssertionError, match="test identity unavailable"):
            RunningLauncher(checkout, tmp_path, "constructor-identity-error")
        assert captured[0].poll() == 0
        assert_stopped(owned)
        ports_reusable()
    finally:
        # Keep the regression itself safe when testing the previous buggy code.
        for process in captured:
            if process.poll() is None:
                interrupt(process)
                process.wait(timeout=20)


def test_observation_failure_still_stops_owned_launcher(launch, monkeypatch):
    running = launch()
    running.wait_for("RCWA ready")
    def unavailable(*_):
        raise AssertionError("test observation unavailable")
    monkeypatch.setattr(sys.modules[__name__], "descendants", unavailable)
    with pytest.raises(AssertionError, match="test observation unavailable"):
        running.stop()
    assert running.process.poll() == 0, running.text()
    assert_stopped(running.owned)
    ports_reusable()


def test_frontend_exit_stops_api_and_owned_helpers(launch):
    running = launch()
    running.wait_for("RCWA ready")
    table = processes()
    children = descendants(running.identity, table)
    node = [item.pid for item in children if "node" in table[item.pid].executable.lower()
            and "esbuild" not in table[item.pid].executable.lower()]
    assert len(node) == 1, {p: table[p.pid] for p in children}
    running.owned.update(children)
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.OpenProcess.argtypes, api.OpenProcess.restype = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE
        api.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = api.OpenProcess(1, False, node[0])
        assert handle
        try:
            assert api.TerminateProcess(handle, 1)
        finally:
            api.CloseHandle(handle)
    else:
        os.kill(node[0], signal.SIGKILL)
    assert running.process.wait(timeout=20) == 1, running.text()
    assert_stopped(running.owned)
    ports_reusable()


@pytest.mark.parametrize("unexpected_runtime_exit", [False, True])
def test_stubborn_owned_grandchildren_are_contained(checkout, launch, edit, unexpected_runtime_exit):
    edit(checkout / "scripts/local_runtime.py", (ROOT / "scripts/tests/fixtures/owned_tree.py").read_text())
    foreign = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(90)"])
    try:
        running = launch()
        running.wait_for("RCWA ready")
        deadline = time.monotonic() + 10
        while not (checkout / "grandchild.pid").exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        pids = {int((checkout / f"{level}.pid").read_text()) for level in ("runtime", "child", "grandchild")}
        observed = identities(pids)
        running.owned.update(observed)
        if unexpected_runtime_exit:
            # A inherited status pipe stays open in the stubborn grandchild.
            # The supervisor must notice runtime death without waiting for EOF.
            if os.name == "nt":
                import ctypes
                from ctypes import wintypes
                api = ctypes.WinDLL("kernel32", use_last_error=True)
                api.OpenProcess.argtypes, api.OpenProcess.restype = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE
                api.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
                api.CloseHandle.argtypes = [wintypes.HANDLE]
                handle = api.OpenProcess(1, False, int((checkout / "runtime.pid").read_text()))
                assert handle
                try:
                    assert api.TerminateProcess(handle, 1)
                finally:
                    api.CloseHandle(handle)
            else:
                os.kill(int((checkout / "runtime.pid").read_text()), signal.SIGKILL)
            assert running.process.wait(timeout=20) == 1
            assert_stopped(observed)
        else:
            assert running.stop(repeated=True) == 1
            assert "Shutdown grace expired" in running.text()
        assert foreign.poll() is None
        ports_reusable()
    finally:
        foreign.terminate()
        foreign.wait(timeout=5)
        for level in ("runtime", "child", "grandchild"):
            (checkout / f"{level}.pid").unlink(missing_ok=True)


@pytest.mark.parametrize("shutdown", [False, True])
def test_cancel_or_shutdown_after_real_eigensystem_and_fresh_job(checkout, launch, edit, shutdown):
    marker = checkout / "entered-real-solve.json"
    marker.unlink(missing_ok=True)
    path = checkout / "backend/rcwa_core/solver_2d.py"
    source = path.read_text()
    line = "        w, v, q = transfer_2d_2(kx, ky, epx[i], epy[i], epz_inverse[i], use_pinv=False)"
    assert source.count(line) == 1
    instrument = (
        f"\n        from pathlib import Path\n        import os, json\n        _marker = Path({str(marker)!r})"
        "\n        if not _marker.exists():\n            _pending = _marker.with_suffix('.tmp')"
        "\n            _pending.write_text(json.dumps({"
        "'pid': os.getpid(), 'phase': 'first real layer eigensystem completed', 'matrix_size': int(w.shape[0])}))"
        "\n            _pending.replace(_marker)"
    )
    edit(path, source.replace(line, line + instrument))
    running = launch()
    running.wait_for("RCWA ready")
    project = small_circle(checkout)
    project["solver"] = {"harmonics_x": 5, "harmonics_y": 5}
    project["illumination"]["wavelengths_nm"] = [500.0 + i * 5 for i in range(31)]
    job = request("/api/jobs", {"project": project})
    deadline = time.monotonic() + 40
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.005)
    assert marker.exists(), running.text()
    entered = json.loads(marker.read_text())
    assert entered["matrix_size"] == 242, entered
    assert request(f"/api/jobs/{job['id']}")["status"] == "running"
    running.owned.update(descendants(running.identity))
    worker = identities({entered["pid"]})
    running.owned.update(worker)
    (LOG_DIR / f"real-solve-{'shutdown' if shutdown else 'cancel'}.json").write_text(json.dumps(entered, indent=2))
    if shutdown:
        assert running.stop(repeated=True) == 0, running.text()
        running = launch()
        running.wait_for("RCWA ready")
    else:
        cancelled = request(f"/api/jobs/{job['id']}", method="DELETE")
        assert cancelled["status"] == "cancelled", cancelled
        assert_stopped(worker)
    completed(small_circle(checkout))
    assert running.stop() == 0, running.text()
    marker.unlink(missing_ok=True)


def test_cancel_during_api_lifespan_startup_uses_normal_shutdown(checkout, launch, edit):
    path = checkout / "backend/api/main.py"
    source = path.read_text()
    edit(path, source.replace(
        "        app.state.store = ProjectStore(database_url)",
        "        await asyncio.sleep(1)\n        app.state.store = ProjectStore(database_url)",
    ))
    running = launch()
    running.wait_for("Waiting for application startup")
    assert running.stop(repeated=True) == 0, running.text()
    assert "Application shutdown complete" in running.text()
    assert "RCWA ready" not in running.text()


def test_cancel_during_vite_listen_uses_normal_close(checkout, launch, edit):
    marker = checkout / "vite-listen.marker"
    path = checkout / "frontend/vite.config.ts"
    source = path.read_text()
    edit(path, "import { writeFileSync } from 'node:fs';\n" + source.replace(
        "plugins: [react()]",
        "plugins: [react(), {name: 'test-pending-listen', async buildStart() {"
        f"writeFileSync({json.dumps(str(marker))}, 'entered');"
        "await new Promise(resolve => setTimeout(resolve, 1000));}}]",
    ))
    running = launch()
    deadline = time.monotonic() + 15
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert marker.exists(), running.text()
    assert running.stop(repeated=True) == 0, running.text()
    assert "Shutdown grace expired" not in running.text()
    assert "RCWA ready" not in running.text()


def test_late_vite_watcher_closes_after_plugins_drain(checkout, launch, edit):
    config = checkout / "frontend/vite.config.ts"
    edit(config, 'import lateWatch from "../scripts/tests/fixtures/late_watch_plugin.mjs";\n' +
         config.read_text().replace("plugins: [react()]", "plugins: [react(), lateWatch()]"))
    edit(checkout / "late-watch.txt", "Real outside-root watcher fixture")
    running = launch()
    running.wait_for("RCWA ready")
    assert running.stop() == 0, running.text()
    assert "Late watcher registered after first close" in running.text()
    assert "Application shutdown complete" in running.text()


@pytest.mark.skipif(os.name != "nt", reason="Actual Windows standard-handle ownership")
@pytest.mark.parametrize("body_raises", [False, True])
def test_windows_worker_stdin_scope_restores_and_closes(body_raises):
    import ctypes
    from ctypes import wintypes
    spec = importlib.util.spec_from_file_location("local_windows", ROOT / "scripts/local_windows.py")
    windows = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(windows)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetStdHandle.argtypes, kernel.GetStdHandle.restype = [wintypes.DWORD], wintypes.HANDLE
    kernel.GetFileType.argtypes, kernel.GetFileType.restype = [wintypes.HANDLE], wintypes.DWORD
    previous, control_stream = kernel.GetStdHandle(-10), sys.stdin
    child_handle = None
    class BodyFailure(Exception):
        pass
    try:
        with windows.isolated_worker_stdin():
            child_handle = kernel.GetStdHandle(-10)
            assert child_handle != previous
            assert kernel.GetFileType(child_handle) == 2
            assert sys.stdin is control_stream
            if body_raises:
                raise BodyFailure
    except BodyFailure:
        assert body_raises
    assert kernel.GetStdHandle(-10) == previous
    assert sys.stdin is control_stream
    ctypes.set_last_error(0)
    assert kernel.GetFileType(child_handle) == 0
    assert ctypes.get_last_error() == 6  # ERROR_INVALID_HANDLE: owned NUL was closed.


@pytest.mark.skipif(os.name != "nt", reason="Actual Windows standard-handle isolation")
def test_windows_worker_stdin_isolated_control_pipe_preserved(checkout, launch, edit):
    path = checkout / "scripts/local_runtime.py"
    source = path.read_text()
    source = source.replace("    from api.main import app", """    import ctypes, msvcrt
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetStdHandle.argtypes, kernel.GetStdHandle.restype = [wintypes.DWORD], wintypes.HANDLE
    kernel.GetFileType.argtypes, kernel.GetFileType.restype = [wintypes.HANDLE], wintypes.DWORD
    assert kernel.GetFileType(kernel.GetStdHandle(-10)) == 2  # NUL character device
    assert kernel.GetFileType(msvcrt.get_osfhandle(sys.stdin.fileno())) == 3  # Original control pipe
    print('Worker stdin isolated; buffered control pipe preserved', file=sys.stderr, flush=True)
    from api.main import app""")
    edit(path, source)
    running = launch()
    running.wait_for("RCWA ready")
    assert "Worker stdin isolated; buffered control pipe preserved" in running.text()
    completed(small_circle(checkout))
    assert running.stop(repeated=True) == 0, running.text()


def test_closed_control_pipe_is_idempotent():
    child = subprocess.Popen([sys.executable, "-c", "pass"], stdin=subprocess.PIPE, text=True)
    child.wait(timeout=5)
    launcher._close_control(child)
    launcher._close_control(child)
    assert child.stdin.closed


def test_real_empty_python_environment_fails_before_launch(checkout, tmp_path):
    import venv
    directory = tmp_path / "empty python environment"
    venv.EnvBuilder(with_pip=False).create(directory)
    python = directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    result = subprocess.run(
        [str(python), str(checkout / "scripts/start_local.py")], cwd=tmp_path,
        capture_output=True, text=True, timeout=15,
    )
    (LOG_DIR / "empty-python.log").write_text(result.stdout + result.stderr)
    assert result.returncode == 1
    assert "Python dependencies do not match" in result.stderr
    assert " -m pip install -r " in result.stderr
    ports_reusable()


@pytest.mark.skipif(os.name == "nt", reason="Windows uses console Ctrl+C, not POSIX SIGTERM")
def test_posix_sigterm_is_cooperative(launch):
    running = launch()
    running.wait_for("RCWA ready")
    running.owned.update(descendants(running.identity))
    running.process.send_signal(signal.SIGTERM)
    assert running.process.wait(timeout=20) == 0, running.text()
    assert "Application shutdown complete" in running.text()
    assert_stopped(running.owned)
    ports_reusable()


@pytest.mark.skipif(os.name != "nt", reason="Actual Windows Job Object assignment failure")
def test_windows_assignment_failure_keeps_gate_closed(checkout, launch, edit):
    path = checkout / "scripts/local_windows.py"
    source = path.read_text()
    edit(path, source.replace(
        "    def assign(self, pid):",
        "    def assign(self, pid):\n        import sys\n"
        "        print(f'gated assignment candidate pid={pid}', file=sys.stderr, flush=True)\n"
        "        raise OSError('test assignment failure')",
    ))
    running = launch()
    assert running.process.wait(timeout=15) == 1, running.text()
    assert "No uncontained fallback was started" in running.text()
    assert "Started server process" not in running.text()
    table = processes()
    remaining = descendants(running.identity, table)
    running.owned.update(remaining)
    try:
        # The private console host can briefly outlive its exited supervisor.
        # Keep every observed identity in the existing bounded cleanup check.
        assert_stopped(remaining)
    finally:
        running.observe("assignment-failure", table)
        running.observe("assignment-later")
    ports_reusable()



def test_closed_log_cannot_skip_forced_owned_tree_cleanup(checkout, launch, edit):
    edit(checkout / "scripts/local_runtime.py", (ROOT / "scripts/tests/fixtures/owned_tree.py").read_text())
    path = checkout / "scripts/start_local.py"
    source = path.read_text()
    source = source.replace(
        '            print("Shutdown grace expired;',
        '            sys.stderr.close()\n            print("Shutdown grace expired;',
    )
    edit(path, source)
    running = launch()
    try:
        running.wait_for("RCWA ready")
        deadline = time.monotonic() + 10
        while not (checkout / "grandchild.pid").exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        pids = {int((checkout / f"{level}.pid").read_text()) for level in ("runtime", "child", "grandchild")}
        observed = identities(pids)
        running.owned.update(observed)
        assert running.stop(repeated=True) == 1, running.text()
        assert_stopped(observed)
    finally:
        for level in ("runtime", "child", "grandchild"):
            (checkout / f"{level}.pid").unlink(missing_ok=True)



@pytest.mark.skipif(os.name != "nt", reason="Windows command-script wrapper rejection")
def test_windows_node_cmd_wrapper_is_never_run(checkout, launch, tmp_path):
    fake_node = tmp_path / "node.cmd"
    marker = tmp_path / "wrapper-was-run"
    fake_node.write_text(f"@echo off\necho bad > \"{marker}\"\n", encoding="utf-8")
    running = launch(PATH=str(tmp_path))
    assert running.process.wait(timeout=15) == 1, running.text()
    assert "not a .cmd or .bat wrapper" in running.text()
    assert not marker.exists()
    ports_reusable()


@pytest.mark.skipif(os.name != "nt", reason="Actual Windows console Ctrl+Break")
def test_windows_ctrl_break_uses_cooperative_pipe_shutdown(launch):
    running = launch()
    running.wait_for("RCWA ready")
    running.owned.update(descendants(running.identity))
    interrupt(running.process, repeat=3, ctrl_break=True)
    assert running.process.wait(timeout=20) == 0, running.text()
    assert "Application shutdown complete" in running.text()
    assert_stopped(running.owned)
    ports_reusable()
