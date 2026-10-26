import json
import threading
import time

from fastapi.testclient import TestClient

from api.jobs import calculate
from api.main import create_app


def test_nonfinite_worker_output_is_numerical_failure(tmp_path, monkeypatch):
    import rcwa_core.project_io as project_io

    monkeypatch.setattr(project_io, "forward_project", lambda model: {"R": float("nan")})
    from rcwa_core.schemas import Project

    output = tmp_path / "out.json"
    calculate("forward", Project().model_dump(), None, str(output))
    payload = json.loads(output.read_text())
    assert payload == {"result": None, "error": "Numerical calculation failed.", "error_code": "numerical_failure"}


def test_cors_origins_are_trimmed(tmp_path, monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "http://a.test, http://b.test ,")
    app = create_app(f"sqlite:///{tmp_path / 'cors.db'}")
    with TestClient(app, base_url="http://localhost") as client:
        response = client.delete("/api/jobs/missing", headers={"Origin": "http://b.test"})
        assert response.status_code == 404
        assert response.headers["access-control-allow-origin"] == "http://b.test"


def test_slow_job_operation_does_not_block_other_requests(tmp_path):
    app = create_app(f"sqlite:///{tmp_path / 'slow.db'}")
    with TestClient(app, base_url="http://localhost") as client:
        def slow_cancel(job_id, *args, **kwargs):
            time.sleep(1.0)

        app.state.jobs.cancel = slow_cancel
        worker = threading.Thread(target=client.delete, args=("/api/jobs/slow",))
        worker.start()
        time.sleep(0.1)
        started = time.perf_counter()
        assert client.get("/api/health").status_code == 200
        elapsed = time.perf_counter() - started
        worker.join()
        assert elapsed < 0.5
