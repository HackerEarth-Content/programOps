"""backfill user roles

Revision ID: 60256f5b6661
Revises: 04bf3f10e256
Create Date: 2026-10-19 17:11:25.514727

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '60256f5b6661'
down_revision: Union[str, Sequence[str], None] = '04bf3f10e256'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Copy the old single role into user_roles. manager and csm become csm; account_manager and
    other become account_manager (view plus comment). Data only: the schema came in the previous revision."""
    op.execute(
        """
        INSERT INTO user_roles (user_id, role)
        SELECT user_id, CASE role WHEN 'manager' THEN 'csm' WHEN 'csm' THEN 'csm' ELSE 'account_manager' END
        FROM "user"
        WHERE role IS NOT NULL
        ON CONFLICT DO NOTHING
        """
    )


def downgrade() -> None:
    """Irreversible data copy: the previous revision's downgrade drops user_roles, which undoes it."""
    pass
