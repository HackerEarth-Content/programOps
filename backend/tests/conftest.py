"""Test harness: a real Postgres database named `<dev name>_test`, migrated to head.

No SQLite: the schema uses ARRAY, JSONB, partial indexes and triggers. The environment is pointed at the
test database before any application module is imported, so the app can never touch the dev database.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from pathlib import Path

import psycopg
import pytest
import pytest_asyncio
from alembic import command
from alembic.config import Config
from dotenv import dotenv_values
from httpx import ASGITransport, AsyncClient
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

BACKEND = Path(__file__).resolve().parent.parent

_dev_url = make_url(os.environ.get("DATABASE_URL") or dotenv_values(BACKEND / ".env")["DATABASE_URL"])
TEST_DB = _dev_url.database if _dev_url.database.endswith("_test") else f"{_dev_url.database}_test"
_test_url = _dev_url.set(database=TEST_DB)
assert TEST_DB.endswith("_test")  # never run the suite against a real database

os.environ["DATABASE_URL"] = _test_url.render_as_string(hide_password=False)
os.environ["SUPER_ADMIN_EMAILS"] = ""  # tests create their own users


def _dsn(database: str) -> str:
    return _dev_url.set(database=database, drivername="postgresql").render_as_string(hide_password=False)


@pytest.fixture(scope="session", autouse=True)
def _database() -> None:
    with psycopg.connect(_dsn("postgres"), autocommit=True) as admin:
        if not admin.execute("SELECT 1 FROM pg_database WHERE datname = %s", (TEST_DB,)).fetchone():
            admin.execute(f'CREATE DATABASE "{TEST_DB}"')
    command.upgrade(Config(str(BACKEND / "alembic.ini")), "head")


@pytest.fixture(autouse=True)
def _clean_tables() -> None:
    with psycopg.connect(_dsn(TEST_DB), autocommit=True) as conn:
        tables = [
            row[0]
            for row in conn.execute(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version'"
            )
        ]
        conn.execute("TRUNCATE " + ", ".join(f'"{t}"' for t in tables) + " RESTART IDENTITY CASCADE")


@pytest_asyncio.fixture
async def db() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    from core.database import db_manager

    await db_manager.initialize()
    yield db_manager.session_factory()
    await db_manager.close()


MakeUser = Callable[..., Awaitable["User"]]  # noqa: F821  (forward reference, resolved in the fixture)


@pytest_asyncio.fixture
async def make_user(db: async_sessionmaker[AsyncSession]) -> MakeUser:
    from core.orm import User, UserRoleAssignment
    from core.permissions import Role

    async def make(email: str = "user@example.com", roles: Sequence[Role] = (), name: str | None = None) -> User:
        async with db() as session:
            user = User(
                email=email,
                hashed_password="not-a-real-hash",
                is_active=True,
                is_verified=True,
                is_superuser=False,
                name=name or email.split("@")[0],
            )
            session.add(user)
            await session.flush()
            session.add_all(UserRoleAssignment(user_id=user.id, role=r.value) for r in roles)
            await session.commit()
            return user

    return make


@pytest_asyncio.fixture
async def templates(db: async_sessionmaker[AsyncSession]) -> None:
    """The starter checklist templates the app seeds at startup (tests truncate every table first)."""
    from core.checklists import ensure_default_templates

    async with db() as session:
        await ensure_default_templates(session)
        await session.commit()


@pytest_asyncio.fixture
async def make_program(db: async_sessionmaker[AsyncSession]) -> Callable[..., Awaitable[str]]:
    from core.orm import Program

    async def make(ticket_id: str = "t1") -> str:
        async with db() as session:
            session.add(
                Program(ticket_id=ticket_id, pipeline_id="p", pipeline_label="Pipeline", stage_id="s", stage_label="Onboarding")
            )
            await session.commit()
        return ticket_id

    return make


@pytest_asyncio.fixture
async def client_for(db: async_sessionmaker[AsyncSession]) -> AsyncIterator[Callable[..., Awaitable[AsyncClient]]]:
    """`await client_for(user)` is a client signed in as `user`; `await client_for()` is anonymous."""
    from main import app
    from core.users import get_jwt_strategy

    opened: list[AsyncClient] = []

    async def make(user: "User | None" = None) -> AsyncClient:  # noqa: F821
        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        if user is not None:
            client.cookies.set("programops_auth", await get_jwt_strategy().write_token(user))
        opened.append(client)
        return client

    yield make
    for client in opened:
        await client.aclose()
