"""Runs in CI with a real PostgreSQL service; explicitly skipped if unavailable."""

import os

import pytest

from api.storage import ProjectStore
from rcwa_core.schemas import Project


@pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="No PostgreSQL test service configured")
def test_postgres_roundtrip():
    store = ProjectStore(os.environ["TEST_POSTGRES_URL"])
    try:
        record = store.save(Project().model_dump(), {"roundtrip": True})
        assert store.get(record["id"])["result"] == {"roundtrip": True}
        assert any(row["id"] == record["id"] for row in store.list())
    finally:
        store.engine.dispose()


@pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="No PostgreSQL test service configured")
def test_postgres_server_snapshot_provenance():
    from uuid import uuid4

    from api.storage import canonical_hash
    from rcwa_core.solver import forward

    url = os.environ["TEST_POSTGRES_URL"]
    model = Project()
    model.illumination.wavelengths_nm = [650.0]
    project = model.model_dump()
    result = forward(model)
    provenance = {
        "source": "server_computed",
        "job_id": str(uuid4()),
        "input_hash": canonical_hash(project),
        "engine": "meent",
        "engine_version": result["metadata"]["version"],
        "adapter_version": result["metadata"]["adapter_version"],
    }
    store = ProjectStore(url)
    try:
        saved = store.save(project, result, provenance=provenance)
        repeated = store.save(project, result, provenance=provenance)
        assert repeated["id"] == saved["id"]
        assert saved["project"] == project and saved["result"] == result
        assert saved["provenance"] == provenance
        listed = next(row for row in store.list() if row["id"] == saved["id"])
        assert listed["provenance"] == provenance
    finally:
        store.engine.dispose()
    restarted = ProjectStore(url)
    try:
        assert restarted.get(saved["id"]) == saved
        assert restarted.save(project, result, provenance=provenance)["id"] == saved["id"]
    finally:
        restarted.engine.dispose()
