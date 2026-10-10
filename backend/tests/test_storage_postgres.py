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
