"""audit events are append only

Revision ID: c264fdf48368
Revises: 60256f5b6661
Create Date: 2026-10-19 17:11:26.018272

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c264fdf48368'
down_revision: Union[str, Sequence[str], None] = '60256f5b6661'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Refuse UPDATE and DELETE on program_events, even for the application's own database user."""
    op.execute(
        """
        CREATE FUNCTION program_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'program_events is append-only';
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER program_events_no_change
        BEFORE UPDATE OR DELETE ON program_events
        FOR EACH ROW EXECUTE FUNCTION program_events_immutable()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER program_events_no_change ON program_events")
    op.execute("DROP FUNCTION program_events_immutable()")
