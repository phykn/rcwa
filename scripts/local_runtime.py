import asyncio
from contextlib import contextmanager, nullcontext
import json
import os
from pathlib import Path
import signal
import socket
import sys
import threading
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]


def report(event, **values):
    print(json.dumps({"event": event, **values}), flush=True)


def control(stop, loop):
    # Only the supervisor owns the write end. STOP and EOF mean the same thing.
    sys.stdin.readline()
    loop.call_soon_threadsafe(stop.set)


async def run(node):
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for number in (signal.SIGINT, *([signal.SIGBREAK] if os.name == "nt" else [])):
        signal.signal(number, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, lambda *_: loop.call_soon_threadsafe(stop.set))
    sys.path.insert(0, str(ROOT / "backend"))
    os.chdir(ROOT)  # Both default and explicit relative SQLite URLs use this root.
    from api.main import app
    import uvicorn

    # NumPy's native initialization can block on Windows while another thread
    # reads stdin (numpy/numpy#24290). Finish imports behind the containment
    # gate first. The same stdin wrapper retains any already-buffered STOP/EOF;
    # the outer supervisor still bounds cancellation if an import is stuck.
    threading.Thread(target=control, args=(stop, loop), daemon=True).start()

    class OwnedServer(uvicorn.Server):
        @contextmanager
        def capture_signals(self):
            # The outer supervisor controls shutdown; never Uvicorn task-cancel.
            yield

    server = OwnedServer(uvicorn.Config(
        app, host="127.0.0.1", port=8000, workers=1, reload=False,
        timeout_graceful_shutdown=5, log_level="info", access_log=False,
    ))
    api_task, editor = None, None
    listener = socket.socket()
    failed = False
    try:
        if stop.is_set():
            return 0
        if os.name == "nt":
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 8000))
        listener.setblocking(False)
        # Passing our bound socket avoids Uvicorn's bind-error sys.exit path.
        api_task = asyncio.create_task(server.serve(sockets=[listener]))
        while not server.started and not api_task.done() and not stop.is_set():
            await asyncio.sleep(0.025)
        if stop.is_set():
            return 0
        if not server.started or api_task.done():
            raise RuntimeError("API startup failed. Check DATABASE_URL, database access and the API log above.")
        editor = await asyncio.create_subprocess_exec(
            node, str(ROOT / "frontend/scripts/local-vite.mjs"),
            cwd=ROOT / "frontend", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        )
        editor_event = asyncio.create_task(editor.stdout.readline())
        stop_task = asyncio.create_task(stop.wait())
        await asyncio.wait((editor_event, api_task, stop_task), return_when=asyncio.FIRST_COMPLETED)
        if stop.is_set():
            editor_event.cancel()
            return 0
        stop_task.cancel()
        if api_task.done():
            editor_event.cancel()
            raise RuntimeError("API exited while the editor was starting.")
        line = editor_event.result()
        if not line or json.loads(line).get("event") != "ready":
            raise RuntimeError("Editor startup failed. Check Node dependencies, frontend .env files and port 5173.")
        # Readiness came from owned listeners. This additional probe exercises
        # their real UI -> proxy -> API path, not ownership of a foreign HTTP 200.
        def probe():
            with build_opener(ProxyHandler({})).open("http://127.0.0.1:5173/api/health", timeout=3) as response:
                health = json.load(response)
            with build_opener(ProxyHandler({})).open("http://127.0.0.1:5173/", timeout=3) as response:
                html = response.read(1_000_000)
            if health.get("status") != "ok" or not health.get("engine_available") or b"/src/main.tsx" not in html:
                raise RuntimeError("The owned local editor/API readiness probe failed.")
        await asyncio.to_thread(probe)
        if stop.is_set() or api_task.done() or editor.returncode is not None:
            return 0 if stop.is_set() else 1
        report("ready")
        stop_task = asyncio.create_task(stop.wait())
        editor_exit = asyncio.create_task(editor.wait())
        await asyncio.wait((api_task, editor_exit, stop_task), return_when=asyncio.FIRST_COMPLETED)
        stop_task.cancel()
        if not stop.is_set():
            raise RuntimeError("A local service exited unexpectedly; stopping the remaining owned services.")
    except Exception as error:
        report("error", message=str(error))
        failed = True
    finally:
        if api_task is not None:
            # Uvicorn 0.34.2 skips its shutdown path if should_exit is set
            # before startup returns. Let startup settle first; the outer
            # supervisor still owns the bound if database startup is blocked.
            while not server.started and not api_task.done():
                await asyncio.sleep(0.025)
            server.should_exit = True
        if editor is not None:
            try:
                editor.stdin.write(b"stop\n")
                await editor.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            editor.stdin.close()
            await editor.wait()
        if api_task is not None:
            # Reaches the normal FastAPI lifespan and existing JobManager.close().
            await api_task
        listener.close()
    return 1 if failed else 0


def main():
    # The Windows supervisor must assign its Job Object before this gate opens.
    # No API imports or descendants exist before it. EOF fails closed.
    if len(sys.argv) != 2 or sys.stdin.readline() != "start\n":
        return 1
    try:
        stdin_scope = nullcontext()
        if os.name == "nt":
            from local_windows import isolated_worker_stdin
            stdin_scope = isolated_worker_stdin()
        with stdin_scope:
            return asyncio.run(run(sys.argv[1]))
    except Exception as error:
        report("error", message=f"Local runtime failed: {type(error).__name__}. Check the preceding API/editor logs.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
