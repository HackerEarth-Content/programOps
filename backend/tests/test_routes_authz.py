"""Who may call the existing program routes. One table so the whole matrix reads at a glance."""

from __future__ import annotations

import pytest

from core.permissions import Role

NOTE = {"body": "hello"}
CONFIG = {"roles": [], "fields": []}

# (roles, method, path, json, expected status)
CASES = [
    ([], "GET", "/programs", None, 403),  # signed in, no role yet
    ([Role.ACCOUNT_MANAGER], "GET", "/programs", None, 200),
    ([Role.ACCOUNT_MANAGER], "POST", "/programs/t1/notes", NOTE, 201),  # may comment
    ([Role.ACCOUNT_MANAGER], "PUT", "/programs/t1/registrations/config", CONFIG, 403),
    ([Role.ACCOUNT_MANAGER], "PUT", "/programs/t1/slack", {}, 403),
    ([Role.ACCOUNT_MANAGER], "POST", "/programs/sync", None, 403),
    ([Role.MARKETING], "POST", "/programs/t1/notes", NOTE, 201),
    ([Role.MARKETING], "PUT", "/programs/t1/registrations/config", CONFIG, 403),
    ([Role.MARKETING], "PUT", "/programs/t1/slack", {}, 403),
    ([Role.MARKETING], "DELETE", "/programs/t1/registrations/1", None, 403),
    ([Role.CSM], "PUT", "/programs/t1/registrations/config", CONFIG, 200),
    ([Role.CSM], "PUT", "/programs/t1/slack", {}, 200),
    ([Role.CSM], "DELETE", "/programs/t1/registrations/1", None, 404),  # allowed, the entry just doesn't exist
    ([Role.SUPER_ADMIN], "GET", "/programs", None, 200),
    ([Role.SUPER_ADMIN], "PUT", "/programs/t1/registrations/config", CONFIG, 403),  # administration only, no program work
    ([Role.SUPER_ADMIN, Role.CSM], "PUT", "/programs/t1/registrations/config", CONFIG, 200),  # dual role
]


@pytest.mark.parametrize(
    "roles, method, path, body, expected",
    CASES,
    ids=[f"{'+'.join(r.value for r in roles) or 'no-role'}:{method} {path}" for roles, method, path, _, _ in CASES],
)
async def test_route_access(client_for, make_user, make_program, roles, method, path, body, expected):
    await make_program("t1")
    client = await client_for(await make_user("someone@example.com", roles))
    response = await client.request(method, path, json=body)
    assert response.status_code == expected, response.text


async def test_an_anonymous_caller_gets_401(client_for):
    assert (await (await client_for()).get("/programs")).status_code == 401
