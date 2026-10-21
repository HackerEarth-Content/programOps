"""Invite-only access. The super admin chooses the roles when inviting; the invitee never picks.

A link is single-use, expires after INVITE_TTL, and only works for the email it was issued to.
Only the SHA-256 of the token is stored, so a database leak cannot be turned into working links.
"""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import StrEnum

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from core.errors import DomainError
from core.orm import Invite, User, UserRoleAssignment
from core.permissions import Role

INVITE_TTL = timedelta(days=3)


class InviteStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REVOKED = "revoked"
    EXPIRED = "expired"  # derived from expires_at, never stored


@dataclass(frozen=True)
class IssuedInvite:
    invite: Invite
    token: str  # shown once; only its hash is stored


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _new_token() -> str:
    return secrets.token_urlsafe(32)


def status_of(invite: Invite) -> InviteStatus:
    if invite.status == InviteStatus.PENDING and invite.expires_at <= _now():
        return InviteStatus.EXPIRED
    return InviteStatus(invite.status)


async def _get(session: AsyncSession, invite_id: str) -> Invite:
    invite = await session.get(Invite, invite_id)
    if invite is None:
        raise DomainError("invite_not_found", "Invite not found.", 404)
    return invite


async def issue(
    session: AsyncSession, *, email: str, roles: Sequence[Role], created_by: User
) -> IssuedInvite:
    email = email.strip().lower()
    if not roles:
        raise DomainError("roles_required", "Pick at least one role.", 422)
    if await session.scalar(select(User.id).where(func.lower(User.email) == email)) is not None:
        raise DomainError("user_exists", "That person already has an account. Change their roles instead.")
    pending = await session.scalar(
        select(Invite).where(Invite.email == email, Invite.status == InviteStatus.PENDING)
    )
    if pending is not None:
        if pending.expires_at > _now():
            raise DomainError("invite_pending", "That person already has a pending invite. Resend it instead.")
        pending.status = InviteStatus.REVOKED  # frees the one-pending-per-email slot
        await session.flush()
    token = _new_token()
    invite = Invite(
        email=email,
        roles=sorted({r.value for r in roles}),
        token_hash=_hash(token),
        expires_at=_now() + INVITE_TTL,
        created_by=created_by.id,
        created_at=_now(),
    )
    session.add(invite)
    await session.flush()
    return IssuedInvite(invite, token)


async def find_valid(session: AsyncSession, token: str | None, *, email: str | None = None) -> Invite:
    """The pending, unexpired invite for `token`; when `email` is given it must match the invite."""
    if not token:
        raise DomainError("not_invited", "This portal is invite-only. Ask a super admin for an invite.", 403)
    invite = await session.scalar(select(Invite).where(Invite.token_hash == _hash(token)))
    if invite is None or invite.status != InviteStatus.PENDING:
        raise DomainError("invite_invalid", "This invite link is not valid.", 404)
    if invite.expires_at <= _now():
        raise DomainError("invite_expired", "This invite link has expired. Ask for a new one.", 410)
    if email is not None and invite.email != email.strip().lower():
        raise DomainError("invite_email_mismatch", "Sign in with the email address this invite was sent to.", 403)
    return invite


async def renew(session: AsyncSession, invite_id: str) -> IssuedInvite:
    """New link and a fresh expiry for a pending invite; the previous link stops working."""
    invite = await _get(session, invite_id)
    if invite.status != InviteStatus.PENDING:
        raise DomainError("invite_not_pending", "Only a pending invite can be resent.")
    token = _new_token()
    invite.token_hash = _hash(token)
    invite.expires_at = _now() + INVITE_TTL
    return IssuedInvite(invite, token)


async def revoke(session: AsyncSession, invite_id: str) -> Invite:
    invite = await _get(session, invite_id)
    if invite.status != InviteStatus.PENDING:
        raise DomainError("invite_not_pending", "Only a pending invite can be revoked.")
    invite.status = InviteStatus.REVOKED
    return invite


async def delete(session: AsyncSession, invite_id: str) -> Invite:
    """Remove a finished invite (revoked, accepted or expired). A live pending invite must be revoked first."""
    invite = await _get(session, invite_id)
    if status_of(invite) == InviteStatus.PENDING:
        raise DomainError("invite_pending", "Revoke a pending invite before deleting it.")
    await session.delete(invite)
    return invite


async def accept(session: AsyncSession, invite: Invite, user: User) -> None:
    """Grant the invited roles to `user` and close the invite. Idempotent on the role rows."""
    for role in invite.roles:
        await session.execute(
            pg_insert(UserRoleAssignment)
            .values(user_id=user.id, role=role)
            .on_conflict_do_nothing()
        )
    invite.status = InviteStatus.ACCEPTED
    invite.accepted_at = _now()
    invite.accepted_user_id = user.id
