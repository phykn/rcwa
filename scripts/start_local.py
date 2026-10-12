#!/usr/bin/env python3
"""Start the already-installed local editor and solver; Ctrl+C stops this tree."""

import importlib.metadata
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
STARTUP_SECONDS = 30
GRACE_SECONDS = 12
KILL_SECONDS = 3


class StartupError(Exception):
    pass


def check_dependencies(root=ROOT):
    if sys.version_info < (3, 12):
        raise StartupError("Python 3.12 or newer is required. Recreate .venv with Python 3.12.")
    missing = []
    for line in (root / "backend/requirements-lock.txt").read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        name, expected = line.split("==", 1)
        try:
            actual = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            actual = "missing"
        if actual != expected:
            missing.append(f"{name}: expected {expected}, found {actual}")
    if missing:
        raise StartupError(
            "Python dependencies do not match backend/requirements-lock.txt:\n  " + "\n  ".join(missing)
            + '\nInstall explicitly with this Python: "' + sys.executable
            + '" -m pip install -r "' + str(root / "backend/requirements-lock.txt") + '"'
        )
    node = shutil.which("node")
    if node is None:
        raise StartupError("Node.js is missing. Install Node.js 22.13+ (22.x) or Node.js 24+, then run npm ci in frontend.")
    if os.name == "nt" and Path(node).suffix.lower() != ".exe":
        raise StartupError("Use the installed Node.js node.exe, not a .cmd or .bat wrapper, on Windows.")
    try:
        version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=5, check=True).stdout.strip()
        parts = tuple(map(int, version.removeprefix("v").split(".")))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise StartupError("Could not check Node.js. Check that node --version works in this terminal.") from error
    if len(parts) != 3 or not (parts >= (22, 13, 0) and parts[0] == 22 or parts[0] >= 24):
        raise StartupError(f"Unsupported Node.js {version}. Use Node.js 22.13+ (22.x) or 24+ for the locked Vite/ESLint.")
    lock = json.loads((root / "frontend/package-lock.json").read_text(encoding="utf-8"))
    for name in (*lock["packages"][""]["dependencies"], *lock["packages"][""]["devDependencies"]):
        path = f"node_modules/{name}"
        try:
            installed = json.loads((root / "frontend" / path / "package.json").read_text(encoding="utf-8"))["version"]
        except (OSError, ValueError, KeyError):
            installed = "missing"
        expected = lock["packages"][path]["version"]
        if installed != expected:
            raise StartupError(f"Frontend dependency {name}: expected {expected}, found {installed}. Run npm ci in frontend.")
    return str(Path(node).resolve())


def check_configuration():
    if os.environ.get("VITE_STATIC_PREVIEW", "").lower() == "true" or os.environ.get("VITE_API_BASE_URL", ""):
        raise StartupError("Clear VITE_STATIC_PREVIEW and VITE_API_BASE_URL for local UI + API startup.")
    if "DATABASE_URL" in os.environ and not os.environ["DATABASE_URL"].strip():
        raise StartupError("DATABASE_URL is empty. Unset it for repository-root SQLite, or provide a valid database URL.")
    for port in (8000, 5173):
        with socket.socket() as probe:
            if os.name == "nt":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError as error:
                raise StartupError(
                    f"Port {port} is unavailable. Stop the service you started there, then retry. "
                    "The launcher will not attach to or stop an existing service."
                ) from error


def _read_events(stream, events):
    try:
        for line in stream:
            try:
                events.put(json.loads(line))
            except ValueError:
                events.put({"event": "error", "message": "Invalid owned-runtime status."})
    finally:
        events.put({"event": "eof"})


def _exited(process):
    # Keep the Linux group leader waitable until group cleanup. Its PID cannot
    # be reused while we may still need to signal that owned process group.
    if hasattr(os, "waitid") and os.name != "nt":
        return os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    return process.poll() is not None


def _signal_group(process, value):
    try:
        os.killpg(process.pid, value)
    except ProcessLookupError:
        pass


def _close_control(process):
    try:
        if not process.stdin.closed:
            process.stdin.write("stop\n")
            process.stdin.flush()
    except (OSError, ValueError):
        pass
    finally:
        try:
            process.stdin.close()
        except (OSError, ValueError):
            pass


def _stop_tree(process, job, requested):
    """Cooperate, then bound all owned descendants even if the runtime exited."""
    _close_control(process)
    deadline = time.monotonic() + GRACE_SECONDS
    while not _exited(process) and time.monotonic() < deadline:
        time.sleep(0.05)
    forced = not _exited(process)
    if forced:
        try:
            print("Shutdown grace expired; stopping only the launcher's owned processes.", file=sys.stderr, flush=True)
        except (OSError, ValueError):
            pass  # A closed log pipe must never prevent process-tree cleanup.
    if job is not None:
        # Includes any orphaned descendant after an unexpectedly exited runtime.
        if job.active():
            job.terminate()
        deadline = time.monotonic() + KILL_SECONDS
        while job.active() and time.monotonic() < deadline:
            time.sleep(0.05)
        if job.active():
            raise StartupError("Windows reported owned processes still stopping. Close this terminal and inspect its log.")
    else:
        _signal_group(process, signal.SIGTERM)
        if forced:
            time.sleep(0.25)
        _signal_group(process, signal.SIGKILL)
    process.wait(timeout=KILL_SECONDS)
    return 1 if forced or not requested and process.returncode != 0 else 0


def supervise(node):
    requested = threading.Event()
    previous = {}
    for number in (signal.SIGINT, signal.SIGTERM, *([signal.SIGBREAK] if os.name == "nt" else [])):
        previous[number] = signal.signal(number, lambda *_: requested.set())
    job, process = None, None
    ready, failed = False, False
    try:
        if os.name == "nt":
            from local_windows import WindowsJob
            job = WindowsJob()
        process = subprocess.Popen(
            [sys.executable, str(ROOT / "scripts/local_runtime.py"), node],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
            start_new_session=os.name != "nt",
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
        if job is not None:
            try:
                job.assign(process.pid)
            except Exception as error:
                # The fixed runtime is still gated; no API, Node or descendants.
                process.stdin.close()
                process.terminate()
                process.wait(timeout=KILL_SECONDS)
                process = None
                raise StartupError("Windows could not contain the local services. No uncontained fallback was started.") from error
        events = queue.Queue()
        reader = threading.Thread(target=_read_events, args=(process.stdout, events), daemon=True)
        reader.start()
        if not requested.is_set():
            process.stdin.write("start\n")
            process.stdin.flush()
        deadline = time.monotonic() + STARTUP_SECONDS
        while not requested.is_set():
            if _exited(process):
                print("The owned runtime exited; stopping its remaining processes.", file=sys.stderr, flush=True)
                failed = True
                break
            if not ready and time.monotonic() >= deadline:
                print("Local startup timed out. Check dependencies, DATABASE_URL and the errors above.", file=sys.stderr)
                failed = True
                break
            try:
                event = events.get(timeout=0.1)
            except queue.Empty:
                continue
            if event.get("event") == "ready":
                ready = True
                print("RCWA ready. Keep this terminal open; Ctrl+C stops the editor and solver.\n"
                      "Editor: http://127.0.0.1:5173\nAPI: http://127.0.0.1:8000/docs", flush=True)
            elif event.get("event") in {"error", "eof"}:
                if event.get("message"):
                    print(event["message"], file=sys.stderr, flush=True)
                failed = True
                break
        if requested.is_set():
            print("Stopping local editor and solver…", flush=True)
        owned, process = process, None
        result = _stop_tree(owned, job, requested.is_set())
        return 1 if failed else result
    finally:
        try:
            if process is not None:
                # An exception in launch/status handling must not abandon ownership.
                _stop_tree(process, job, False)
        finally:
            if job is not None:
                job.close()
            for number, handler in previous.items():
                signal.signal(number, handler)


def main():
    if len(sys.argv) != 1:
        print("Usage: <venv-python> scripts/start_local.py\nStarts the installed local editor + API; Ctrl+C stops both.")
        return 0 if sys.argv[1:] in (["--help"], ["-h"]) else 2
    try:
        check_configuration()
        node = check_dependencies()
        return supervise(node)
    except (StartupError, OSError, subprocess.SubprocessError) as error:
        print(f"Local startup failed: {error}", file=sys.stderr, flush=True)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
