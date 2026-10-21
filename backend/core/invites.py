"""Pre-granted access. A super admin sets roles for an email; the first time that person signs in with Google they
get exactly those roles instead of the default Viewer. No link and no token: the match is the verified email.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timezone
from enum import StrEnum

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.errors import DomainError
from core.orm import Invite, User, UserRoleAssignment
from core.permissions import Role


class InviteStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REVOKED = "revoked"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def in_allowed_domain(email: str) -> bool:
    return email.strip().lower().endswith("@" + settings.ALLOWED_EMAIL_DOMAIN.strip().lower())


async def _get(session: AsyncSession, invite_id: str) -> Invite:
    invite = await session.get(Invite, invite_id)
    if invite is None:
        raise DomainError("invite_not_found", "Pre-granted access not found.", 404)
    return invite


async def issue(session: AsyncSession, *, email: str, roles: Sequence[Role], created_by: User) -> Invite:
    email = email.strip().lower()
    if not roles:
        raise DomainError("roles_required", "Pick at least one role.", 422)
    if not in_allowed_domain(email):
        raise DomainError("outside_domain", f"Only @{settings.ALLOWED_EMAIL_DOMAIN} accounts can have access.", 422)
    if await session.scalar(select(User.id).where(func.lower(User.email) == email)) is not None:
        raise DomainError("user_exists", "That person already has an account. Change their roles instead.")
    pending = await session.scalar(select(Invite).where(Invite.email == email, Invite.status == InviteStatus.PENDING))
    if pending is not None:  # a newer pre-grant replaces the old one
        pending.status = InviteStatus.REVOKED
        await session.flush()
    invite = Invite(email=email, roles=sorted({r.value for r in roles}), created_by=created_by.id, created_at=_now())
    session.add(invite)
    await session.flush()
    return invite


async def pending_for(session: AsyncSession, email: str) -> Invite | None:
    return await session.scalar(
        select(Invite).where(Invite.email == email.strip().lower(), Invite.status == InviteStatus.PENDING)
    )


async def revoke(session: AsyncSession, invite_id: str) -> Invite:
    invite = await _get(session, invite_id)
    if invite.status != InviteStatus.PENDING:
        raise DomainError("invite_not_pending", "Only a waiting pre-grant can be revoked.")
    invite.status = InviteStatus.REVOKED
    return invite


async def delete(session: AsyncSession, invite_id: str) -> Invite:
    """Remove a finished pre-grant (revoked or applied). A waiting one must be revoked first."""
    invite = await _get(session, invite_id)
    if invite.status == InviteStatus.PENDING:
        raise DomainError("invite_pending", "Revoke a waiting pre-grant before deleting it.")
    await session.delete(invite)
    return invite


async def grant(session: AsyncSession, roles: Sequence[str], user: User) -> None:
    for role in roles:
        await session.execute(
            pg_insert(UserRoleAssignment).values(user_id=user.id, role=role).on_conflict_do_nothing()
        )


async def accept(session: AsyncSession, invite: Invite, user: User) -> None:
    """Give `user` the pre-granted roles and close it. Idempotent on the role rows."""
    await grant(session, invite.roles, user)
    invite.status = InviteStatus.ACCEPTED
    invite.accepted_at = _now()
    invite.accepted_user_id = user.id
