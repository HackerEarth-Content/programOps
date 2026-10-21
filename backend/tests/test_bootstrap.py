"""The configured super admin exists from the first start, so the first Google sign-in needs no invite."""

from __future__ import annotations

from fastapi_users.db import SQLAlchemyUserDatabase
from sqlalchemy import func, select
from starlette.requests import Request

from core.access import bootstrap_super_admins
from core.orm import OAuthAccount, User, UserRoleAssignment
from core.permissions import Role
from core.users import UserManager


async def roles_of(db, email: str) -> list[str]:
    async with db() as session:
        return sorted(
            (
                await session.scalars(
                    select(UserRoleAssignment.role)
                    .join(User, User.id == UserRoleAssignment.user_id)
                    .where(func.lower(User.email) == email)
                )
            ).all()
        )


async def test_the_configured_email_becomes_a_super_admin(db):
    async with db() as session:
        await bootstrap_super_admins(session, ["Sai.Revanth@HackerEarth.com", "  ", ""])
    assert await roles_of(db, "sai.revanth@hackerearth.com") == ["super_admin"]


async def test_running_it_twice_changes_nothing(db):
    for _ in range(2):
        async with db() as session:
            await bootstrap_super_admins(session, ["sai.revanth@hackerearth.com"])
    async with db() as session:
        assert await session.scalar(select(func.count()).select_from(User)) == 1
    assert await roles_of(db, "sai.revanth@hackerearth.com") == ["super_admin"]


async def test_an_existing_user_keeps_their_roles_and_gains_super_admin(db, make_user):
    await make_user("sai.revanth@hackerearth.com", [Role.CSM])
    async with db() as session:
        await bootstrap_super_admins(session, ["sai.revanth@hackerearth.com"])
    assert await roles_of(db, "sai.revanth@hackerearth.com") == ["csm", "super_admin"]


async def test_the_bootstrapped_admin_can_sign_in_with_google_and_no_invite(db):
    async with db() as session:
        await bootstrap_super_admins(session, ["sai.revanth@hackerearth.com"])
    async with db() as session:
        manager = UserManager(SQLAlchemyUserDatabase(session, User, OAuthAccount))
        request = Request({"type": "http", "method": "GET", "path": "/", "query_string": b"", "headers": []})
        user = await manager.oauth_callback(
            "google", "token", "google-id-1", "sai.revanth@hackerearth.com", None, None, request,
            associate_by_email=True, is_verified_by_default=True,
        )
    assert user.email == "sai.revanth@hackerearth.com"
    assert await roles_of(db, "sai.revanth@hackerearth.com") == ["super_admin"]
