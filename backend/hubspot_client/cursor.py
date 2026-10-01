"""Incremental sync cursor, persisted in Postgres so a scheduled run only
pulls programs that changed since the last run instead of rescanning windows.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.dialects.postgresql import insert

from core.database import db_manager
from core.orm import SyncCursor

PROGRAMS_KEY = "hubspot_programs"


async def get_cursor(key: str = PROGRAMS_KEY) -> datetime | None:
    session_factory = db_manager.session_factory()
    async with session_factory() as session:
        row = await session.get(SyncCursor, key)
        return row.last_synced_at if row else None


async def set_cursor(value: datetime, key: str = PROGRAMS_KEY) -> None:
    session_factory = db_manager.session_factory()
    async with session_factory() as session:
        stmt = insert(SyncCursor).values(key=key, last_synced_at=value)
        stmt = stmt.on_conflict_do_update(
            index_elements=["key"],
            set_={"last_synced_at": stmt.excluded.last_synced_at},
        )
        await session.execute(stmt)
        await session.commit()
