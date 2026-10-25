"""Append-only project storage, preserving the original database table.

Provenance lives in a new sidecar table: old databases need no destructive column
migration and old rows remain explicitly unverified. Never infer origin from JSON.
"""

import json
import os
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Column, ForeignKey, MetaData, String, Table, Text, create_engine, select
from sqlalchemy.exc import IntegrityError

from rcwa_core.identity import canonical_hash as canonical_hash

metadata = MetaData()
projects = Table(
    "projects",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("name", String(160), nullable=False),
    Column("created_at", String(40), nullable=False),
    Column("updated_at", String(40), nullable=False),
    Column("project", Text, nullable=False),
    Column("result", Text, nullable=True),
)
# Additive schema evolution. create_all creates this new table; it is not used to
# pretend that columns of an existing projects table have been migrated.
run_provenance = Table(
    "run_provenance",
    metadata,
    Column("project_id", String(36), ForeignKey("projects.id"), primary_key=True),
    Column("job_id", String(36), nullable=False, unique=True),
    Column("data", Text, nullable=False),
)


class ProjectStore:
    def __init__(self, url: str | None = None):
        url = url or os.getenv("DATABASE_URL", "sqlite:///./rcwa-demo.db")
        self.backend = "sqlite-demo" if url.startswith("sqlite") else "postgresql"
        self.engine = create_engine(url)
        metadata.create_all(self.engine)

    def save(self, project: dict, result: dict | None, *, provenance: dict | None = None) -> dict:
        now = datetime.now(timezone.utc).isoformat()
        record = dict(
            id=str(uuid4()),
            name=project["name"],
            created_at=now,
            updated_at=now,
            project=json.dumps(project, allow_nan=False),
            result=json.dumps(result, allow_nan=False) if result is not None else None,
        )
        try:
            with self.engine.begin() as connection:
                if provenance is not None:
                    previous = self._saved_job(connection, provenance["job_id"])
                    if previous:
                        return self.get(previous)
                connection.execute(projects.insert().values(**record))
                if provenance is not None:
                    connection.execute(
                        run_provenance.insert().values(
                            project_id=record["id"],
                            job_id=provenance["job_id"],
                            data=json.dumps(provenance, allow_nan=False),
                        )
                    )
        except IntegrityError:
            # A concurrent save of the same job won the unique job_id; this one rolled
            # back whole, so return the winner and keep saving by job idempotent.
            if provenance is None:
                raise
            with self.engine.connect() as connection:
                previous = self._saved_job(connection, provenance["job_id"])
            if not previous:
                raise
            return self.get(previous)
        return self.get(record["id"])

    @staticmethod
    def _saved_job(connection, job_id: str) -> str | None:
        return connection.execute(
            select(run_provenance.c.project_id).where(run_provenance.c.job_id == job_id)
        ).scalar_one_or_none()

    def get(self, project_id: str) -> dict | None:
        with self.engine.connect() as connection:
            row = connection.execute(select(projects).where(projects.c.id == project_id)).mappings().first()
            origin = connection.execute(
                select(run_provenance.c.data).where(run_provenance.c.project_id == project_id)
            ).scalar_one_or_none()
        if row is None:
            return None
        record = dict(row)
        record["project"] = json.loads(record["project"])
        record["result"] = json.loads(record["result"]) if record["result"] else None
        record["provenance"] = json.loads(origin) if origin else {"source": "unverified_import"}
        return record

    def list(self) -> list[dict]:
        with self.engine.connect() as connection:
            rows = connection.execute(
                select(
                    projects.c.id, projects.c.name, projects.c.created_at, projects.c.updated_at, run_provenance.c.data
                )
                .outerjoin(run_provenance, projects.c.id == run_provenance.c.project_id)
                .order_by(projects.c.updated_at.desc())
                .limit(100)
            )
            records = []
            for row in rows.mappings():
                record = dict(row)
                origin = record.pop("data")
                record["provenance"] = json.loads(origin) if origin else {"source": "unverified_import"}
                records.append(record)
            return records
