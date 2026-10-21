"""Company-domain sign-in: first-time accounts start as Viewers, a super admin can pre-grant roles by email."""

from __future__ import annotations

import pytest
from fastapi_users.db import SQLAlchemyUserDatabase
from sqlalchemy import select
from starlette.requests import Request

from core import invites
from core.errors import DomainError
from core.orm import Invite, OAuthAccount, User, UserRoleAssignment
from core.permissions import Permission as P, Role, effective_permissions
from core.users import UserManager, google_oauth_client


async def issue(db, admin: User, email: str = "new@hackerearth.com", roles=(Role.CSM,)):
    async with db() as session:
        invite = await invites.issue(session, email=email, roles=roles, created_by=admin)
        await session.commit()
        return invite


async def refused(coro) -> str:
    with pytest.raises(DomainError) as caught:
        await coro
    return caught.value.code


@pytest.fixture(autouse=True)
def google_says_company_account(monkeypatch):
    """Google's userinfo for the signed-in account; tests override `info` to model other accounts."""
    info: dict = {}

    async def userinfo(token: str) -> dict:
        email = token.removeprefix("token-for-")
        base = {"email": email, "email_verified": True, "hd": email.rpartition("@")[2]}
        return {**base, **info}

    monkeypatch.setattr(google_oauth_client, "userinfo", userinfo)
    return info


async def sign_in(db, email: str, account_id: str | None = None) -> User:
    request = Request({"type": "http", "method": "GET", "path": "/", "query_string": b"", "headers": []})
    async with db() as session:
        manager = UserManager(SQLAlchemyUserDatabase(session, User, OAuthAccount))
        return await manager.oauth_callback(
            "google", f"token-for-{email}", account_id or f"google-id-{email}", email, None, None, request,
            associate_by_email=True, is_verified_by_default=True,
        )


async def roles_of(db, user_id: str) -> set[str]:
    async with db() as session:
        return set((await session.scalars(select(UserRoleAssignment.role).where(UserRoleAssignment.user_id == user_id))).all())


# ---- the Viewer role -------------------------------------------------------


def test_a_viewer_can_see_programs_and_nothing_else():
    assert effective_permissions({Role.VIEWER}, [], []) == {P.PROGRAM_VIEW}


# ---- the Google sign-in gate -----------------------------------------------


async def test_an_account_outside_the_company_domain_is_refused_and_no_user_is_created(db):
    assert await refused(sign_in(db, "stranger@example.com")) == "outside_domain"
    async with db() as session:
        assert await session.scalar(select(User.id).where(User.email == "stranger@example.com")) is None


async def test_a_lookalike_domain_is_refused(db):
    assert await refused(sign_in(db, "x@evilhackerearth.com")) == "outside_domain"
    assert await refused(sign_in(db, "x@hackerearth.com.evil.io")) == "outside_domain"


async def test_a_look_alike_account_without_the_workspace_domain_is_refused(db, google_says_company_account):
    google_says_company_account["hd"] = ""  # a consumer Google account that merely uses a company address
    assert await refused(sign_in(db, "x@hackerearth.com")) == "outside_domain"
    async with db() as session:
        assert await session.scalar(select(User.id).where(User.email == "x@hackerearth.com")) is None


async def test_an_unverified_email_is_refused(db, google_says_company_account):
    google_says_company_account["email_verified"] = False
    assert await refused(sign_in(db, "x@hackerearth.com")) == "outside_domain"


async def test_a_failed_google_check_lets_nobody_in(db, monkeypatch):
    async def broken(token: str) -> dict:
        raise RuntimeError("google is down")

    monkeypatch.setattr(google_oauth_client, "userinfo", broken)
    assert await refused(sign_in(db, "x@hackerearth.com")) == "outside_domain"


async def test_a_company_account_signs_in_as_a_viewer(db):
    user = await sign_in(db, "New.Person@HackerEarth.com")
    assert await roles_of(db, user.id) == {"viewer"}


async def test_a_pre_granted_person_gets_exactly_those_roles_and_no_viewer(db, make_user):
    admin = await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN])
    granted = await issue(db, admin, roles=(Role.MARKETING,))
    user = await sign_in(db, "new@hackerearth.com")
    assert await roles_of(db, user.id) == {"marketing"}
    async with db() as session:
        invite = await session.get(Invite, granted.id)
    assert invite.status == invites.InviteStatus.ACCEPTED
    assert invite.accepted_user_id == user.id


async def test_a_pre_grant_is_used_once(db, make_user):
    admin = await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN])
    await issue(db, admin)
    user = await sign_in(db, "new@hackerearth.com")
    assert await roles_of(db, user.id) == {"csm"}
    async with db() as session:
        assert await invites.pending_for(session, "new@hackerearth.com") is None


async def test_an_existing_user_signs_in_unchanged_even_outside_the_domain(db, make_user):
    existing = await make_user("sai@example.com", [Role.SUPER_ADMIN])
    user = await sign_in(db, "Sai@Example.com")
    assert user.id == existing.id
    assert await roles_of(db, user.id) == {"super_admin"}


async def test_a_known_google_account_with_a_changed_email_is_not_treated_as_new(db, make_user):
    existing = await make_user("old@hackerearth.com", [Role.CSM])
    async with db() as session:
        session.add(
            OAuthAccount(oauth_name="google", access_token="t", account_id="g-1", account_email="old@hackerearth.com", user_id=existing.id)
        )
        await session.commit()
    admin = await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN])
    await issue(db, admin, email="renamed@hackerearth.com", roles=(Role.SUPER_ADMIN,))
    user = await sign_in(db, "renamed@hackerearth.com", account_id="g-1")
    assert user.id == existing.id
    assert await roles_of(db, user.id) == {"csm"}  # no Viewer added, and the pre-grant for the new address is not applied


# ---- the pre-grant service -------------------------------------------------


async def test_a_pre_grant_needs_at_least_one_role(db, make_user):
    admin = await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN])
    assert await refused(issue(db, admin, roles=())) == "roles_required"


async def test_a_pre_grant_outside_the_domain_is_refused(db, make_user):
    admin = await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN])
    assert await refused(issue(db, admin, email="x@example.com")) == "outside_domain"


async def test_someone_with_an_account_is_changed_not_pre_granted(db, make_user):
    admin = await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN])
    await make_user("here@hackerearth.com", [Role.VIEWER])
    assert await refused(issue(db, admin, email="here@hackerearth.com")) == "user_exists"


async def test_a_newer_pre_grant_replaces_the_waiting_one(db, make_user):
    admin = await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN])
    await issue(db, admin, roles=(Role.CSM,))
    await issue(db, admin, roles=(Role.MARKETING,))
    user = await sign_in(db, "new@hackerearth.com")
    assert await roles_of(db, user.id) == {"marketing"}


async def test_a_waiting_pre_grant_must_be_revoked_before_it_is_deleted(db, make_user):
    admin = await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN])
    granted = await issue(db, admin)
    async with db() as session:
        assert await refused(invites.delete(session, granted.id)) == "invite_pending"
        await invites.revoke(session, granted.id)
        await invites.delete(session, granted.id)
        await session.commit()
    async with db() as session:
        assert await session.get(Invite, granted.id) is None


async def test_a_revoked_pre_grant_is_not_applied(db, make_user):
    admin = await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN])
    granted = await issue(db, admin)
    async with db() as session:
        await invites.revoke(session, granted.id)
        await session.commit()
    user = await sign_in(db, "new@hackerearth.com")
    assert await roles_of(db, user.id) == {"viewer"}


# ---- the refusal reaches the browser ---------------------------------------


def _refusal(path: str):
    from main import domain_error_handler

    request = Request({"type": "http", "method": "GET", "path": path, "query_string": b"", "headers": []})
    return domain_error_handler(request, DomainError("outside_domain", "Company accounts only.", 403))


async def test_a_refused_google_sign_in_redirects_back_to_the_app_with_the_reason():
    from core.config import settings

    response = await _refusal("/api/auth/google/callback")
    assert response.status_code == 302
    assert response.headers["location"] == f"{settings.FRONTEND_URL}/?auth_error=outside_domain"


async def test_any_other_refusal_is_json_with_a_machine_readable_code():
    import json

    response = await _refusal("/admin/users")
    assert response.status_code == 403
    assert json.loads(response.body) == {"detail": "Company accounts only.", "code": "outside_domain"}
