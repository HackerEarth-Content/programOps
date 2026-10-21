"""activity cannot go live without approval

Revision ID: d5220ebbcb01
Revises: dd054db3e5a2
Create Date: 2026-10-19 17:21:03.760964

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd5220ebbcb01'
down_revision: Union[str, Sequence[str], None] = 'dd054db3e5a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    """Refuse a transition INTO 'live' without an approval (BR-04). Deliberately not a CHECK
    constraint: withdrawing the approval of an activity that is already live must stay possible,
    because that state ("live and unapproved") is exactly what the control-breach counter reports."""
    op.execute(
        """
        CREATE FUNCTION program_activities_live_needs_approval() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.status = 'live' AND NEW.approved_at IS NULL
               AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'live') THEN
                RAISE EXCEPTION 'activity_live_requires_approval';
            END IF;
            RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER program_activities_live_needs_approval
        BEFORE INSERT OR UPDATE ON program_activities
        FOR EACH ROW EXECUTE FUNCTION program_activities_live_needs_approval()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER program_activities_live_needs_approval ON program_activities")
    op.execute("DROP FUNCTION program_activities_live_needs_approval()")
