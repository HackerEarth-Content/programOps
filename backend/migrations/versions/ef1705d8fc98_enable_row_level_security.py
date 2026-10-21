"""enable row level security

Revision ID: ef1705d8fc98
Revises: f1c592a13eb5
Create Date: 2026-10-21 11:41:55.650946

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ef1705d8fc98'
down_revision: Union[str, Sequence[str], None] = 'f1c592a13eb5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_FOR_EVERY_TABLE = """
DO $$
DECLARE t record;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%%I %s ROW LEVEL SECURITY', t.tablename);
    END LOOP;
END $$;
"""


def upgrade() -> None:
    """Row level security on every table, with no policies: nobody but the database owner can read or write.

    Supabase serves every table in `public` through its REST API with a public (anon) key, so a table without RLS is
    readable by anyone holding that key. The API server connects as the database owner (`postgres`), which bypasses RLS,
    so nothing changes for it. Access control stays in the API (core/permissions.py); this is the backstop. Any table
    added later must enable RLS too: tests/test_rls.py fails if one doesn't.
    """
    op.execute(_FOR_EVERY_TABLE % "ENABLE")


def downgrade() -> None:
    op.execute(_FOR_EVERY_TABLE % "DISABLE")
