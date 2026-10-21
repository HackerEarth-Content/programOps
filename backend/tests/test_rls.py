"""Row level security is on for every table, so Supabase's public REST key can read nothing.

The API server connects as the database owner, which bypasses RLS; access control lives in the API. If this fails, a new
migration created a table without enabling RLS: add `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` to it.
"""

from __future__ import annotations

from sqlalchemy import text


async def test_every_public_table_has_row_level_security(db):
    async with db() as session:
        rows = (
            await session.execute(
                text(
                    "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                    "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity ORDER BY 1"
                )
            )
        ).scalars().all()
    assert rows == [], f"tables without row level security: {rows}"
