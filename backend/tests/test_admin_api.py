"""The super-admin API: users, roles, per-user permissions, invites, and /me."""

from __future__ import annotations

from sqlalchemy import select

from core.orm import ProgramEvent, UserPermissionOverride
from core.permissions import Permission as P, Role


async def test_a_non_admin_cannot_use_the_admin_api(client_for, make_user):
    client = await client_for(await make_user("csm@example.com", [Role.CSM]))
    for method, path in (("GET", "/admin/users"), ("GET", "/admin/invites"), ("POST", "/admin/invites")):
        response = await client.request(method, path, json={"emails": ["a@hackerearth.com"], "roles": ["csm"]})
        assert response.status_code == 403
        assert response.json()["code"] == "permission_denied"


async def test_an_anonymous_caller_gets_401(client_for):
    assert (await (await client_for()).get("/admin/users")).status_code == 401


async def test_the_user_list_shows_roles_and_effective_permissions(client_for, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN, Role.CSM])
    await make_user("mkt@example.com", [Role.MARKETING])
    client = await client_for(admin)
    users = {u["email"]: u for u in (await client.get("/admin/users")).json()}
    assert users["admin@example.com"]["roles"] == ["super_admin", "csm"] or set(users["admin@example.com"]["roles"]) == {"super_admin", "csm"}
    assert P.ACTIVITY_APPROVE in users["admin@example.com"]["permissions"]
    assert P.ACTIVITY_APPROVE not in users["mkt@example.com"]["permissions"]
    only_marketing = (await client.get("/admin/users", params={"role": "marketing"})).json()
    assert [u["email"] for u in only_marketing] == ["mkt@example.com"]


async def test_pre_granting_reports_who_was_skipped(client_for, make_user):
    client = await client_for(await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN]))
    await make_user("here@hackerearth.com", [Role.VIEWER])
    created = await client.post(
        "/admin/invites",
        json={"emails": ["New@HackerEarth.com", "here@hackerearth.com", "out@example.com", "new@hackerearth.com"], "roles": ["marketing", "csm"]},
    )
    assert created.status_code == 201
    body = created.json()
    assert [(i["email"], i["status"]) for i in body["created"]] == [("new@hackerearth.com", "pending")]
    assert set(body["created"][0]["roles"]) == {"marketing", "csm"}
    assert {(x["email"], x["reason"]) for x in body["skipped"]} == {
        ("here@hackerearth.com", "user_exists"),
        ("out@example.com", "outside_domain"),
    }
    assert [i["email"] for i in (await client.get("/admin/invites")).json()] == ["new@hackerearth.com"]


async def test_revoke_then_delete_a_pre_grant(client_for, make_user):
    client = await client_for(await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN]))
    created = (await client.post("/admin/invites", json={"emails": ["a@hackerearth.com"], "roles": ["csm"]})).json()
    invite_id = created["created"][0]["id"]
    assert (await client.delete(f"/admin/invites/{invite_id}")).status_code == 409  # still waiting
    assert (await client.post(f"/admin/invites/{invite_id}/revoke")).json()["status"] == "revoked"
    assert (await client.delete(f"/admin/invites/{invite_id}")).status_code == 204


async def test_promoting_a_viewer_replaces_the_viewer_role_and_emptying_roles_returns_to_viewer(client_for, make_user):
    client = await client_for(await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN]))
    person = await make_user("p@hackerearth.com", [Role.VIEWER])
    promoted = (await client.patch(f"/admin/users/{person.id}", json={"roles": ["viewer", "csm"]})).json()
    assert promoted["roles"] == ["csm"]
    demoted = (await client.patch(f"/admin/users/{person.id}", json={"roles": []})).json()
    assert demoted["roles"] == ["viewer"]
    assert demoted["permissions"] == [P.PROGRAM_VIEW]


async def test_the_user_list_hints_at_people_hubspot_names_as_csm(client_for, make_user, make_program, db):
    from sqlalchemy import update

    from core.orm import Program

    await make_program("t1")
    await make_program("t2")
    async with db() as session:
        await session.execute(update(Program).values(csm_email="priya@hackerearth.com"))
        await session.commit()
    admin = await make_user("admin@hackerearth.com", [Role.SUPER_ADMIN])
    await make_user("priya@hackerearth.com", [Role.VIEWER])
    users = {u["email"]: u for u in (await (await client_for(admin)).get("/admin/users")).json()}
    assert users["priya@hackerearth.com"]["hubspot_csm_programs"] == 2
    assert users["admin@hackerearth.com"]["hubspot_csm_programs"] == 0
    assert users["priya@hackerearth.com"]["created_at"]


async def test_a_viewer_sees_progress_but_cannot_change_anything(client_for, make_user, make_program):
    await make_program("t1")
    viewer = await client_for(await make_user("v@hackerearth.com", [Role.VIEWER]))
    assert (await viewer.get("/me")).json()["permissions"] == [P.PROGRAM_VIEW]
    for path in ("/programs", "/programs/t1", "/programs/t1/notes", "/programs/t1/assignments", "/queues/csm"):
        assert (await viewer.get(path)).status_code == 200, path
    assert (await viewer.post("/programs/t1/notes", json={"body": "hi"})).status_code == 403
    assert (await viewer.put("/programs/t1/assignments", json=[])).status_code == 403
    assert (await viewer.get("/admin/users")).status_code == 403
    assert (await viewer.get("/audit")).status_code == 403


async def test_changing_a_role_is_audited(client_for, make_user, db):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    target = await make_user("t@example.com", [Role.ACCOUNT_MANAGER])
    client = await client_for(admin)
    response = await client.patch(f"/admin/users/{target.id}", json={"roles": ["csm", "marketing"]})
    assert response.status_code == 200
    assert set(response.json()["roles"]) == {"csm", "marketing"}
    async with db() as session:
        event = await session.scalar(select(ProgramEvent).where(ProgramEvent.action == "roles_changed"))
    assert (event.actor_id, event.actor_name, event.entity_id) == (admin.id, "admin", target.id)
    assert event.old == ["account_manager"] and event.new == ["csm", "marketing"]


async def test_nobody_can_change_their_own_roles_or_permissions(client_for, make_user):
    admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    client = await client_for(admin)
    for response in (
        await client.patch(f"/admin/users/{admin.id}", json={"roles": ["csm"]}),
        await client.put(f"/admin/users/{admin.id}/permissions", json={"grants": [], "revokes": []}),
    ):
        assert response.status_code == 403
        assert response.json()["code"] == "cannot_change_self"


async def _user_manager_who_is_not_super_admin(make_user, db):
    """A CSM who has been individually granted users.manage."""
    manager = await make_user("manager@example.com", [Role.CSM])
    async with db() as session:
        session.add(UserPermissionOverride(user_id=manager.id, permission=P.USERS_MANAGE.value, granted=True))
        await session.commit()
    return manager


async def test_the_last_super_admin_cannot_be_demoted_or_deactivated(client_for, make_user, db):
    only_admin = await make_user("admin@example.com", [Role.SUPER_ADMIN])
    client = await client_for(await _user_manager_who_is_not_super_admin(make_user, db))
    demote = await client.patch(f"/admin/users/{only_admin.id}", json={"roles": ["csm"]})
    deactivate = await client.patch(f"/admin/users/{only_admin.id}", json={"is_active": False})
    assert (demote.status_code, demote.json()["code"]) == (409, "last_super_admin")
    assert (deactivate.status_code, deactivate.json()["code"]) == (409, "last_super_admin")


async def test_one_of_two_super_admins_can_be_demoted(client_for, make_user, db):
    await make_user("admin@example.com", [Role.SUPER_ADMIN])
    second = await make_user("second@example.com", [Role.SUPER_ADMIN])
    client = await client_for(await _user_manager_who_is_not_super_admin(make_user, db))
    assert (await client.patch(f"/admin/users/{second.id}", json={"roles": ["csm"]})).status_code == 200


async def test_individual_permissions_change_what_me_reports(client_for, make_user):
    admin = await client_for(await make_user("admin@example.com", [Role.SUPER_ADMIN]))
    marketer = await make_user("m@example.com", [Role.MARKETING])
    response = await admin.put(
        f"/admin/users/{marketer.id}/permissions",
        json={"grants": ["hubspot.write"], "revokes": ["activity.edit"]},
    )
    assert response.status_code == 200
    me = (await (await client_for(marketer)).get("/me")).json()
    assert "hubspot.write" in me["permissions"]
    assert "activity.edit" not in me["permissions"]
    assert me["roles"] == ["marketing"] and me["pending"] is False


async def test_granting_and_revoking_the_same_permission_is_rejected(client_for, make_user):
    admin = await client_for(await make_user("admin@example.com", [Role.SUPER_ADMIN]))
    target = await make_user("t@example.com", [Role.CSM])
    response = await admin.put(
        f"/admin/users/{target.id}/permissions", json={"grants": ["hubspot.write"], "revokes": ["hubspot.write"]}
    )
    assert response.status_code == 422


async def test_a_person_with_no_role_is_pending(client_for, make_user):
    me = (await (await client_for(await make_user("new@example.com"))).get("/me")).json()
    assert me["pending"] is True and me["roles"] == [] and me["permissions"] == []
