"""Invite-only access: the invite service, and the Google sign-in gate that enforces it."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi_users.db import SQLAlchemyUserDatabase
from fastapi_users.router.oauth import generate_state_token
from sqlalchemy import select, update
from starlette.requests import Request

from core import invites
from core.errors import DomainError
from core.orm import Invite, OAuthAccount, User, UserRoleAssignment
from core.permissions import Role
from core.users import SECRET, UserManager


async def issue(db, admin: User, email: str = "new@example.com", roles=(Role.CSM,)):
    async with db() as session:
        issued = await invites.issue(session, email=email, roles=roles, created_by=admin)
        await session.commit()
        return issued


async def refused(coro) -> str:
    with pytest.raises(DomainError) as caught:
        await coro
    return caught.value.code


def request_with_state(**state: str) -> Request:
    token = generate_state_token({"csrf_token": "x", **state}, SECRET)
    return Request({"type": "http", "method": "GET", "path": "/", "query_string": f"state={token}".encode(), "headers": []})


async def sign_in(db, email: str, request: Request | None) -> User:
    async with db() as session:
        manager = UserManager(SQLAlchemyUserDatabase(session, User, OAuthAccount))
        return await manager.oauth_callback(
            "google", "access-token", f"google-id-{email}", email, None, None, request,
            associate_by_email=True, is_verified_by_default=True,
        )


async def roles_of(db, user_id: str) -> set[str]:
    async with db() as session:
        return set((await session.scalars(select(UserRoleAssignment.role).where(UserRoleAssignment.user_id == user_id))).all())


# ---- the invite service ----------------------------------------------------


async def test_only_a_hash_of_the_token_is_stored(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin)
    assert issued.invite.token_hash != issued.token
    assert len(issued.invite.token_hash) == 64


async def test_a_valid_token_finds_its_invite(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin)
    async with db() as session:
        invite = await invites.find_valid(session, issued.token, email="NEW@example.com")  # case-insensitive
    assert invite.id == issued.invite.id


async def test_the_inviter_chooses_the_roles(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin, roles=(Role.MARKETING, Role.CSM))
    assert issued.invite.roles == ["csm", "marketing"]


async def test_an_invite_needs_at_least_one_role(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    async with db() as session:
        assert await refused(invites.issue(session, email="a@example.com", roles=[], created_by=admin)) == "roles_required"


async def test_no_token_means_not_invited(db):
    async with db() as session:
        assert await refused(invites.find_valid(session, None)) == "not_invited"


async def test_an_unknown_token_is_invalid(db):
    async with db() as session:
        assert await refused(invites.find_valid(session, "nope")) == "invite_invalid"


async def test_an_expired_invite_is_refused(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin)
    async with db() as session:
        await session.execute(update(Invite).values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
        await session.commit()
        assert await refused(invites.find_valid(session, issued.token)) == "invite_expired"


async def test_the_link_lasts_three_days(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin)
    remaining = issued.invite.expires_at - datetime.now(timezone.utc)
    assert timedelta(days=2, hours=23) < remaining <= timedelta(days=3)


async def test_a_revoked_invite_is_invalid(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin)
    async with db() as session:
        await invites.revoke(session, issued.invite.id)
        await session.commit()
        assert await refused(invites.find_valid(session, issued.token)) == "invite_invalid"


async def test_the_link_only_works_for_the_invited_email(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin)
    async with db() as session:
        assert await refused(invites.find_valid(session, issued.token, email="other@example.com")) == "invite_email_mismatch"


async def test_a_second_live_invite_for_the_same_email_is_refused(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    await issue(db, admin)
    async with db() as session:
        assert await refused(invites.issue(session, email="new@example.com", roles=[Role.CSM], created_by=admin)) == "invite_pending"


async def test_an_expired_invite_is_replaced_by_a_new_one(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    await issue(db, admin)
    async with db() as session:
        await session.execute(update(Invite).values(expires_at=datetime.now(timezone.utc) - timedelta(hours=1)))
        await session.commit()
    again = await issue(db, admin)
    async with db() as session:
        rows = (await session.scalars(select(Invite).order_by(Invite.created_at))).all()
    assert [invites.status_of(r) for r in rows] == [invites.InviteStatus.REVOKED, invites.InviteStatus.PENDING]
    assert again.invite.status == "pending"


async def test_someone_with_an_account_is_changed_not_invited(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    await make_user("exists@example.com")
    async with db() as session:
        assert await refused(invites.issue(session, email="Exists@Example.com", roles=[Role.CSM], created_by=admin)) == "user_exists"


async def test_resend_kills_the_old_link_and_renews_the_expiry(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin)
    async with db() as session:
        fresh = await invites.renew(session, issued.invite.id)
        await session.commit()
        assert fresh.token != issued.token
        assert await refused(invites.find_valid(session, issued.token)) == "invite_invalid"
        assert (await invites.find_valid(session, fresh.token)).id == issued.invite.id


async def test_a_live_pending_invite_must_be_revoked_before_it_is_deleted(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin)
    async with db() as session:
        assert await refused(invites.delete(session, issued.invite.id)) == "invite_pending"
        await invites.revoke(session, issued.invite.id)
        await invites.delete(session, issued.invite.id)
        await session.commit()
        assert await session.get(Invite, issued.invite.id) is None


# ---- the Google sign-in gate -----------------------------------------------


async def test_an_uninvited_google_account_is_refused_and_no_user_is_created(db):
    code = await refused(sign_in(db, "stranger@example.com", request_with_state()))
    assert code == "not_invited"
    async with db() as session:
        assert await session.scalar(select(User.id).where(User.email == "stranger@example.com")) is None


async def test_a_forged_state_counts_as_no_invite(db):
    bad = Request({"type": "http", "method": "GET", "path": "/", "query_string": b"state=garbage", "headers": []})
    assert await refused(sign_in(db, "stranger@example.com", bad)) == "not_invited"


async def test_an_invited_person_gets_exactly_the_invited_roles(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin, roles=(Role.MARKETING,))
    user = await sign_in(db, "new@example.com", request_with_state(invite=issued.token))
    assert await roles_of(db, user.id) == {"marketing"}
    async with db() as session:
        invite = await session.get(Invite, issued.invite.id)
    assert invites.status_of(invite) == invites.InviteStatus.ACCEPTED
    assert invite.accepted_user_id == user.id


async def test_an_invite_cannot_be_used_twice(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin)
    await sign_in(db, "new@example.com", request_with_state(invite=issued.token))
    assert await refused(sign_in(db, "someone-else@example.com", request_with_state(invite=issued.token))) == "invite_invalid"


async def test_an_invite_for_another_email_is_refused(db, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    issued = await issue(db, admin)
    assert await refused(sign_in(db, "intruder@example.com", request_with_state(invite=issued.token))) == "invite_email_mismatch"
    async with db() as session:
        assert await session.scalar(select(User.id).where(User.email == "intruder@example.com")) is None


def _refusal(path: str):
    from main import domain_error_handler

    request = Request({"type": "http", "method": "GET", "path": path, "query_string": b"", "headers": []})
    return domain_error_handler(request, DomainError("not_invited", "Invite only.", 403))


async def test_a_refused_google_sign_in_redirects_back_to_the_app_with_the_reason():
    from core.config import settings

    response = await _refusal("/api/auth/google/callback")
    assert response.status_code == 302
    assert response.headers["location"] == f"{settings.FRONTEND_URL}/?auth_error=not_invited"


async def test_any_other_refusal_is_json_with_a_machine_readable_code():
    import json

    response = await _refusal("/admin/users")
    assert response.status_code == 403
    assert json.loads(response.body) == {"detail": "Invite only.", "code": "not_invited"}


async def test_an_existing_user_signs_in_without_an_invite(db, make_user):
    existing = await make_user("sai@example.com", [Role.SUPER_ADMIN])
    user = await sign_in(db, "Sai@Example.com", request_with_state())
    assert user.id == existing.id
    assert await roles_of(db, user.id) == {"super_admin"}
