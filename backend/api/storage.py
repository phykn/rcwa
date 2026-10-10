"""Small metadata store. PostgreSQL in deployment; SQLite for a zero-setup demo."""

import json
import os
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Column, MetaData, String, Table, Text, create_engine, select

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


class ProjectStore:
    def __init__(self, url: str | None = None):
        url = url or os.getenv("DATABASE_URL", "sqlite:///./rcwa-demo.db")
        self.backend = "sqlite-demo" if url.startswith("sqlite") else "postgresql"
        self.engine = create_engine(url)
        metadata.create_all(self.engine)

    def save(self, project: dict, result: dict | None) -> dict:
        now = datetime.now(timezone.utc).isoformat()
        record = dict(
            id=str(uuid4()),
            name=project["name"],
            created_at=now,
            updated_at=now,
            project=json.dumps(project, allow_nan=False),
            result=json.dumps(result, allow_nan=False) if result is not None else None,
        )
        with self.engine.begin() as connection:
            connection.execute(projects.insert().values(**record))
        return self.get(record["id"])

    def get(self, project_id: str) -> dict | None:
        with self.engine.connect() as connection:
            row = connection.execute(select(projects).where(projects.c.id == project_id)).mappings().first()
        if row is None:
            return None
        record = dict(row)
        record["project"] = json.loads(record["project"])
        record["result"] = json.loads(record["result"]) if record["result"] else None
        return record

    def list(self) -> list[dict]:
        with self.engine.connect() as connection:
            rows = connection.execute(
                select(projects.c.id, projects.c.name, projects.c.created_at, projects.c.updated_at)
                .order_by(projects.c.updated_at.desc())
                .limit(100)
            )
            return [dict(row._mapping) for row in rows]
