"""The super-admin API: users, roles, per-user permissions, invites, and /me."""

from __future__ import annotations

from sqlalchemy import select

from core.config import settings
from core.orm import ProgramEvent, UserPermissionOverride
from core.permissions import Permission as P, Role


async def test_a_non_admin_cannot_use_the_admin_api(client_for, make_user):
    client = await client_for(await make_user("csm@example.com", [Role.CSM]))
    for method, path in (("GET", "/admin/users"), ("GET", "/admin/invites"), ("POST", "/admin/invites")):
        response = await client.request(method, path, json={"email": "a@example.com", "roles": ["csm"]})
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


async def test_creating_an_invite_returns_the_link_once(client_for, make_user):
    client = await client_for(await make_user("admin@example.com", [Role.SUPER_ADMIN]))
    created = await client.post("/admin/invites", json={"email": "New@Example.com", "roles": ["marketing", "csm"]})
    assert created.status_code == 201
    body = created.json()
    assert body["link"].startswith(f"{settings.FRONTEND_URL.rstrip('/')}/invite/")
    assert body["invite"]["email"] == "new@example.com"
    assert body["invite"]["status"] == "pending"
    assert set(body["invite"]["roles"]) == {"marketing", "csm"}

    listed = (await client.get("/admin/invites")).json()
    assert [i["email"] for i in listed] == ["new@example.com"]
    assert "link" not in listed[0]  # the token is not recoverable after creation


async def test_the_invite_page_preview_is_public_and_masks_the_email(client_for, make_user):
    admin = await client_for(await make_user("admin@example.com", [Role.SUPER_ADMIN]))
    link = (await admin.post("/admin/invites", json={"email": "priya@example.com", "roles": ["csm"]})).json()["link"]
    token = link.rsplit("/", 1)[1]
    preview = await (await client_for()).get(f"/invites/{token}")
    assert preview.status_code == 200
    assert preview.json() == {"email_hint": "p***@example.com", "roles": ["csm"]}


async def test_an_unknown_invite_token_is_404(client_for):
    response = await (await client_for()).get("/invites/not-a-token")
    assert response.status_code == 404
    assert response.json()["code"] == "invite_invalid"


async def test_resend_gives_a_new_link_and_revoke_ends_it(client_for, make_user):
    client = await client_for(await make_user("admin@example.com", [Role.SUPER_ADMIN]))
    created = (await client.post("/admin/invites", json={"email": "a@example.com", "roles": ["csm"]})).json()
    invite_id = created["invite"]["id"]
    resent = (await client.post(f"/admin/invites/{invite_id}/resend")).json()
    assert resent["link"] != created["link"]
    assert (await client.get(f"/invites/{created['link'].rsplit('/', 1)[1]}")).status_code == 404
    assert (await client.delete(f"/admin/invites/{invite_id}")).status_code == 409  # still pending
    assert (await client.post(f"/admin/invites/{invite_id}/revoke")).json()["status"] == "revoked"
    assert (await client.delete(f"/admin/invites/{invite_id}")).status_code == 204


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
