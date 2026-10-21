"""viewer role and token-less pre-grants

Revision ID: a7c3e9d41b20
Revises: ef1705d8fc98
Create Date: 2026-10-21 14:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7c3e9d41b20'
down_revision: Union[str, Sequence[str], None] = 'ef1705d8fc98'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ROLES = ("super_admin", "csm", "marketing", "account_manager")


def _role_check(roles: tuple[str, ...]) -> str:
    return "role IN (" + ", ".join(f"'{r}'" for r in roles) + ")"


def upgrade() -> None:
    op.drop_constraint("ck_user_roles_role", "user_roles", type_="check")
    op.create_check_constraint("ck_user_roles_role", "user_roles", _role_check(_ROLES + ("viewer",)))
    # Pre-grants are applied by email on first sign-in: no link, so no token and no expiry.
    op.drop_column("invites", "token_hash")
    op.drop_column("invites", "expires_at")
    # Active company accounts that were waiting for access are Viewers now. Anyone else (outside the company
    # domain, or deliberately left without roles and inactive) stays without access until a super admin acts.
    op.execute(
        """
        INSERT INTO user_roles (user_id, role)
        SELECT u.user_id, 'viewer' FROM "user" u
        WHERE u.is_active AND lower(u.email) LIKE '%@hackerearth.com'
          AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.user_id)
        """
    )


def downgrade() -> None:
    op.add_column("invites", sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("invites", sa.Column("token_hash", sa.String(), nullable=True))
    op.execute("UPDATE invites SET expires_at = now(), token_hash = md5(id || random()::text)")
    op.alter_column("invites", "expires_at", nullable=False)
    op.alter_column("invites", "token_hash", nullable=False)
    op.create_unique_constraint("invites_token_hash_key", "invites", ["token_hash"])
    op.execute("DELETE FROM user_roles WHERE role = 'viewer'")
    op.drop_constraint("ck_user_roles_role", "user_roles", type_="check")
    op.create_check_constraint("ck_user_roles_role", "user_roles", _role_check(_ROLES))
