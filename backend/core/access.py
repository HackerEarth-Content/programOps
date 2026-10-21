"""Who the caller is and what they may do. `require_permission` replaces the old all-or-nothing editor check."""

from __future__ import annotations

import secrets
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass

from fastapi import Depends
from fastapi_users.password import PasswordHelper
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_session
from core.errors import DomainError
from core.orm import User, UserPermissionOverride, UserRoleAssignment
from core.permissions import Permission, Role, effective_permissions
from core.users import current_active_user


@dataclass(frozen=True)
class Access:
    user: User
    roles: frozenset[Role]
    permissions: frozenset[Permission]

    @property
    def pending(self) -> bool:
        """Signed in, but nobody has given them a role yet."""
        return not self.roles


async def load_access(session: AsyncSession, user: User) -> Access:
    role_values = (
        await session.scalars(select(UserRoleAssignment.role).where(UserRoleAssignment.user_id == user.id))
    ).all()
    overrides = (
        await session.execute(
            select(UserPermissionOverride.permission, UserPermissionOverride.granted).where(
                UserPermissionOverride.user_id == user.id
            )
        )
    ).all()
    roles = frozenset(Role(r) for r in role_values)
    grants = [Permission(p) for p, granted in overrides if granted]
    revokes = [Permission(p) for p, granted in overrides if not granted]
    return Access(user, roles, effective_permissions(roles, grants, revokes))


async def current_access(
    user: User = Depends(current_active_user), session: AsyncSession = Depends(get_session)
) -> Access:
    return await load_access(session, user)


def require_permission(permission: Permission) -> Callable[..., Awaitable[Access]]:
    async def dependency(access: Access = Depends(current_access)) -> Access:
        if permission not in access.permissions:
            raise DomainError("permission_denied", f"Missing permission: {permission.value}", 403)
        return access

    return dependency


async def bootstrap_super_admins(session: AsyncSession, emails: Iterable[str]) -> None:
    """Make sure each configured email has a user with the super_admin role, so the first
    Google sign-in works without an invite. Idempotent; safe to run on every start."""
    hasher = PasswordHelper()
    for raw in emails:
        email = raw.strip().lower()
        if not email:
            continue
        user = await session.scalar(select(User).where(func.lower(User.email) == email))
        if user is None:
            user = User(
                email=email,
                hashed_password=hasher.hash(secrets.token_urlsafe(32)),  # never used: sign-in is Google only
                is_active=True,
                is_verified=True,
                is_superuser=False,
                name=email.split("@")[0],
            )
            session.add(user)
            await session.flush()
        await session.execute(
            pg_insert(UserRoleAssignment)
            .values(user_id=user.id, role=Role.SUPER_ADMIN.value)
            .on_conflict_do_nothing()
        )
    await session.commit()
