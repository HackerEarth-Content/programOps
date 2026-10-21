"""Super-admin surface: users, roles, per-user permissions, invites. Plus the audit log reader."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core import audit, invites
from core.access import Access, current_access, require_permission
from core.config import settings
from core.database import get_session
from core.errors import DomainError
from core.invites import InviteStatus
from core.orm import Invite, ProgramEvent, User, UserPermissionOverride, UserRoleAssignment
from core.permissions import Permission, Role, effective_permissions

router = APIRouter(
    prefix="/admin", tags=["admin"], dependencies=[Depends(require_permission(Permission.USERS_MANAGE))]
)
invites_public = APIRouter(tags=["invites"])
audit_router = APIRouter(
    prefix="/audit", tags=["audit"], dependencies=[Depends(require_permission(Permission.AUDIT_VIEW))]
)


# ---- schemas ---------------------------------------------------------------


class UserOut(BaseModel):
    id: str
    email: str
    name: str | None
    is_active: bool
    roles: list[Role]
    grants: list[Permission]  # individually added on top of the roles
    revokes: list[Permission]  # individually removed from the roles
    permissions: list[Permission]  # the effective set


class UserPatch(BaseModel):
    roles: list[Role] | None = None
    is_active: bool | None = None


class PermissionsIn(BaseModel):
    grants: list[Permission] = []
    revokes: list[Permission] = []

    @model_validator(mode="after")
    def _no_overlap(self) -> PermissionsIn:
        if set(self.grants) & set(self.revokes):
            raise ValueError("A permission can't be both granted and revoked.")
        return self


class InviteIn(BaseModel):
    email: EmailStr
    roles: list[Role] = Field(min_length=1)


class InviteOut(BaseModel):
    id: str
    email: str
    roles: list[Role]
    status: InviteStatus
    expires_at: datetime
    created_at: datetime


class InviteLinkOut(BaseModel):
    invite: InviteOut
    link: str  # shown once: only a hash of the token is stored


class InvitePreview(BaseModel):
    email_hint: str
    roles: list[Role]


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    ticket_id: str | None
    entity: str
    entity_id: str
    action: str
    field: str | None
    old: Any
    new: Any
    actor_id: str | None
    actor_name: str
    at: datetime


class EventPage(BaseModel):
    items: list[EventOut]
    next_before: int | None  # pass as `before` to get the next page


# ---- helpers ---------------------------------------------------------------


async def _user_outs(session: AsyncSession, users: list[User]) -> list[UserOut]:
    ids = [u.id for u in users]
    roles: dict[str, set[Role]] = defaultdict(set)
    for user_id, role in (
        await session.execute(
            select(UserRoleAssignment.user_id, UserRoleAssignment.role).where(UserRoleAssignment.user_id.in_(ids))
        )
    ).all():
        roles[user_id].add(Role(role))
    grants: dict[str, set[Permission]] = defaultdict(set)
    revokes: dict[str, set[Permission]] = defaultdict(set)
    for user_id, permission, granted in (
        await session.execute(
            select(
                UserPermissionOverride.user_id, UserPermissionOverride.permission, UserPermissionOverride.granted
            ).where(UserPermissionOverride.user_id.in_(ids))
        )
    ).all():
        (grants if granted else revokes)[user_id].add(Permission(permission))
    return [
        UserOut(
            id=u.id,
            email=u.email,
            name=u.name,
            is_active=u.is_active,
            roles=sorted(roles[u.id]),
            grants=sorted(grants[u.id]),
            revokes=sorted(revokes[u.id]),
            permissions=sorted(effective_permissions(roles[u.id], grants[u.id], revokes[u.id])),
        )
        for u in users
    ]


async def _get_user(session: AsyncSession, user_id: str) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise DomainError("user_not_found", "User not found.", 404)
    return user


def _refuse_self(access: Access, target: User) -> None:
    if target.id == access.user.id:
        raise DomainError("cannot_change_self", "You can't change your own roles or access.", 403)


async def _guard_last_super_admin(session: AsyncSession, target: User, *, keeps_super_admin: bool) -> None:
    """Refuse a change that would leave no active super admin. Locks the role rows so two
    concurrent demotions can't both pass the check."""
    admin_ids = set(
        (
            await session.scalars(
                select(UserRoleAssignment.user_id)
                .join(User, User.id == UserRoleAssignment.user_id)
                .where(UserRoleAssignment.role == Role.SUPER_ADMIN.value, User.is_active)
                .with_for_update(of=UserRoleAssignment)
            )
        ).all()
    )
    if target.id in admin_ids and not keeps_super_admin and admin_ids <= {target.id}:
        raise DomainError("last_super_admin", "At least one active super admin must remain.", 409)


def _invite_out(invite: Invite) -> InviteOut:
    return InviteOut(
        id=invite.id,
        email=invite.email,
        roles=[Role(r) for r in invite.roles],
        status=invites.status_of(invite),
        expires_at=invite.expires_at,
        created_at=invite.created_at,
    )


def _link(token: str) -> str:
    return f"{settings.FRONTEND_URL.rstrip('/')}/invite/{token}"


# ---- users -----------------------------------------------------------------


@router.get("/users", response_model=list[UserOut])
async def list_users(
    role: Role | None = None, q: str | None = None, session: AsyncSession = Depends(get_session)
) -> list[UserOut]:
    stmt = select(User).order_by(User.email)
    if q:
        stmt = stmt.where(User.email.ilike(f"%{q}%") | User.name.ilike(f"%{q}%"))
    if role:
        stmt = stmt.where(
            User.id.in_(select(UserRoleAssignment.user_id).where(UserRoleAssignment.role == role.value))
        )
    # unique(): User eagerly joins its oauth accounts, a collection.
    return await _user_outs(session, list((await session.scalars(stmt)).unique().all()))


@router.get("/users/{user_id}", response_model=UserOut)
async def get_user(user_id: str, session: AsyncSession = Depends(get_session)) -> UserOut:
    return (await _user_outs(session, [await _get_user(session, user_id)]))[0]


@router.patch("/users/{user_id}", response_model=UserOut)
async def patch_user(
    user_id: str,
    body: UserPatch,
    access: Access = Depends(current_access),
    session: AsyncSession = Depends(get_session),
) -> UserOut:
    target = await _get_user(session, user_id)
    _refuse_self(access, target)

    current = {
        Role(r)
        for r in (
            await session.scalars(select(UserRoleAssignment.role).where(UserRoleAssignment.user_id == target.id))
        ).all()
    }
    new_roles = set(body.roles) if body.roles is not None else current
    new_active = target.is_active if body.is_active is None else body.is_active
    await _guard_last_super_admin(
        session, target, keeps_super_admin=Role.SUPER_ADMIN in new_roles and new_active
    )

    if new_roles != current:
        await session.execute(delete(UserRoleAssignment).where(UserRoleAssignment.user_id == target.id))
        session.add_all(UserRoleAssignment(user_id=target.id, role=r.value) for r in sorted(new_roles))
        audit.record(
            session, access.user, entity="user", entity_id=target.id, action="roles_changed",
            field="roles", old=sorted(current), new=sorted(new_roles),
        )
    if new_active != target.is_active:
        target.is_active = new_active
        audit.record(
            session, access.user, entity="user", entity_id=target.id,
            action="activated" if new_active else "deactivated",
        )
    await session.commit()
    return (await _user_outs(session, [target]))[0]


@router.put("/users/{user_id}/permissions", response_model=UserOut)
async def put_permissions(
    user_id: str,
    body: PermissionsIn,
    access: Access = Depends(current_access),
    session: AsyncSession = Depends(get_session),
) -> UserOut:
    target = await _get_user(session, user_id)
    _refuse_self(access, target)

    before = (await _user_outs(session, [target]))[0]
    await session.execute(delete(UserPermissionOverride).where(UserPermissionOverride.user_id == target.id))
    session.add_all(
        [UserPermissionOverride(user_id=target.id, permission=p.value, granted=True, set_by=access.user.id)
         for p in sorted(set(body.grants))]
        + [UserPermissionOverride(user_id=target.id, permission=p.value, granted=False, set_by=access.user.id)
           for p in sorted(set(body.revokes))]
    )
    audit.record(
        session, access.user, entity="user", entity_id=target.id, action="permissions_changed",
        field="permissions",
        old={"grants": before.grants, "revokes": before.revokes},
        new={"grants": sorted(set(body.grants)), "revokes": sorted(set(body.revokes))},
    )
    await session.commit()
    return (await _user_outs(session, [target]))[0]


# ---- invites ---------------------------------------------------------------


@router.get("/invites", response_model=list[InviteOut])
async def list_invites(session: AsyncSession = Depends(get_session)) -> list[InviteOut]:
    rows = await session.scalars(select(Invite).order_by(Invite.created_at.desc()))
    return [_invite_out(i) for i in rows.all()]


@router.post("/invites", status_code=201, response_model=InviteLinkOut)
async def create_invite(
    body: InviteIn, access: Access = Depends(current_access), session: AsyncSession = Depends(get_session)
) -> InviteLinkOut:
    issued = await invites.issue(session, email=body.email, roles=body.roles, created_by=access.user)
    audit.record(
        session, access.user, entity="invite", entity_id=issued.invite.id, action="invite_created",
        new={"email": issued.invite.email, "roles": issued.invite.roles},
    )
    await session.commit()
    return InviteLinkOut(invite=_invite_out(issued.invite), link=_link(issued.token))


@router.post("/invites/{invite_id}/resend", response_model=InviteLinkOut)
async def resend_invite(
    invite_id: str, access: Access = Depends(current_access), session: AsyncSession = Depends(get_session)
) -> InviteLinkOut:
    """New link and a fresh expiry; the old link stops working. Also what "Copy link" calls."""
    issued = await invites.renew(session, invite_id)
    audit.record(session, access.user, entity="invite", entity_id=invite_id, action="invite_resent")
    await session.commit()
    return InviteLinkOut(invite=_invite_out(issued.invite), link=_link(issued.token))


@router.post("/invites/{invite_id}/revoke", response_model=InviteOut)
async def revoke_invite(
    invite_id: str, access: Access = Depends(current_access), session: AsyncSession = Depends(get_session)
) -> InviteOut:
    invite = await invites.revoke(session, invite_id)
    audit.record(session, access.user, entity="invite", entity_id=invite_id, action="invite_revoked")
    await session.commit()
    return _invite_out(invite)


@router.delete("/invites/{invite_id}", status_code=204)
async def delete_invite(
    invite_id: str, access: Access = Depends(current_access), session: AsyncSession = Depends(get_session)
) -> Response:
    await invites.delete(session, invite_id)
    audit.record(session, access.user, entity="invite", entity_id=invite_id, action="invite_deleted")
    await session.commit()
    return Response(status_code=204)


@invites_public.get("/invites/{token}", response_model=InvitePreview)
async def preview_invite(token: str, session: AsyncSession = Depends(get_session)) -> InvitePreview:
    """What the invite page shows before "Continue with Google". Public; the token is the secret."""
    invite = await invites.find_valid(session, token)
    local, _, domain = invite.email.partition("@")
    return InvitePreview(email_hint=f"{local[:1]}***@{domain}", roles=[Role(r) for r in invite.roles])


# ---- audit -----------------------------------------------------------------


@audit_router.get("", response_model=EventPage)
async def list_events(
    ticket_id: str | None = None,
    entity: str | None = None,
    entity_id: str | None = None,
    actor_id: str | None = None,
    before: int | None = None,
    limit: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
) -> EventPage:
    """Newest first. Keyset pagination: pass `next_before` back as `before`."""
    stmt = select(ProgramEvent).order_by(ProgramEvent.id.desc()).limit(limit + 1)
    for column, value in (
        (ProgramEvent.ticket_id, ticket_id),
        (ProgramEvent.entity, entity),
        (ProgramEvent.entity_id, entity_id),
        (ProgramEvent.actor_id, actor_id),
    ):
        if value is not None:
            stmt = stmt.where(column == value)
    if before is not None:
        stmt = stmt.where(ProgramEvent.id < before)
    rows = list((await session.scalars(stmt)).all())
    page = rows[:limit]
    return EventPage(
        items=[EventOut.model_validate(r) for r in page],
        next_before=page[-1].id if len(rows) > limit else None,
    )
