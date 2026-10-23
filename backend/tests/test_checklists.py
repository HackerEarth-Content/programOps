"""The checklist engine: templates, special requests and item confirmation."""

from __future__ import annotations

from sqlalchemy import func, select

from core import checklists
from core.orm import ChecklistItem, ChecklistTemplate, SlackOutbox
from core.permissions import Role


async def csm_client(client_for, make_user, email="csm@example.com", name="Priya S."):
    return await client_for(await make_user(email, [Role.CSM], name=name))


async def template_id(client, key: str) -> int:
    return next(t["id"] for t in (await client.get("/checklist-templates", params={"include_inactive": True})).json() if t["key"] == key)


async def new_request(client, key="content_to_marketing", **extra):
    response = await client.post("/programs/t1/requests", json={"template_id": await template_id(client, key), **extra})
    assert response.status_code == 201, response.text
    return response.json()


async def confirm_all(client, checklist: dict, ticket="t1") -> dict:
    out = checklist
    for item in checklist["items"]:
        response = await client.put(
            f"/programs/{ticket}/checklists/{checklist['id']}/items/{item['id']}", json={"confirmed": True, "detail": "checked"}
        )
        assert response.status_code == 200, response.text
        out = response.json()
    return out


# ---- templates -------------------------------------------------------------------


async def test_the_starter_templates_are_seeded_once_and_never_overwrite_edits(db, templates):
    async with db() as session:
        keys = set((await session.scalars(select(ChecklistTemplate.key))).all())
        assert keys == {"content_to_marketing"}
        (await session.scalar(select(ChecklistTemplate).where(ChecklistTemplate.key == "content_to_marketing"))).name = "Edited by a CSM"
        await session.commit()
        await checklists.ensure_default_templates(session)
        await session.commit()
        assert await session.scalar(select(ChecklistTemplate.name).where(ChecklistTemplate.key == "content_to_marketing")) == "Edited by a CSM"
        assert await session.scalar(select(func.count()).select_from(ChecklistTemplate)) == 1


async def test_the_content_template_carries_the_four_agreed_items(client_for, make_user, templates):
    client = await csm_client(client_for, make_user)
    content = next(t for t in (await client.get("/checklist-templates", params={"kind": "request"})).json() if t["key"] == "content_to_marketing")
    assert [i["label"] for i in content["items"]] == [
        "Image quality meets the spec", "Client has approved the copy", "Logos and brand assets received", "Eligibility and dates verified",
    ]


async def test_a_csm_or_super_admin_creates_a_new_request_type_marketing_cannot(client_for, make_user, templates):
    body = {"name": "Extension request", "kind": "request", "items": [{"label": "Client agreed new date", "needs_detail": True}, {"label": "Round dates updated"}]}
    created = await (await csm_client(client_for, make_user)).post("/checklist-templates", json=body)
    assert created.status_code == 201 and created.json()["key"] == "extension_request" and len(created.json()["items"]) == 2
    admin = await client_for(await make_user("admin@example.com", [Role.SUPER_ADMIN]))
    again = await admin.post("/checklist-templates", json=body)
    assert again.status_code == 201 and again.json()["key"] == "extension_request_2"  # keys stay unique
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    assert (await marketing.post("/checklist-templates", json=body)).status_code == 403


async def test_a_template_needs_at_least_one_item(client_for, make_user, templates):
    response = await (await csm_client(client_for, make_user)).post("/checklist-templates", json={"name": "Empty", "kind": "request", "items": []})
    assert response.status_code == 422


async def test_editing_a_template_never_changes_a_request_already_created_from_it(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    request = await new_request(client)
    tid = await template_id(client, "content_to_marketing")
    edited = await client.patch(f"/checklist-templates/{tid}", json={"items": [{"label": "Only one item now"}]})
    assert edited.status_code == 200 and [i["label"] for i in edited.json()["items"]] == ["Only one item now"]
    listed = (await client.get("/programs/t1/requests")).json()[0]
    assert [i["label"] for i in listed["items"]] == [i["label"] for i in request["items"]] and len(listed["items"]) == 4


async def test_a_deactivated_template_is_hidden_and_cannot_start_a_request(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    tid = await template_id(client, "content_to_marketing")
    await client.patch(f"/checklist-templates/{tid}", json={"active": False})
    assert "content_to_marketing" not in {t["key"] for t in (await client.get("/checklist-templates")).json()}
    response = await client.post("/programs/t1/requests", json={"template_id": tid})
    assert (response.status_code, response.json()["code"]) == (422, "template_not_a_request_type")


# ---- requests --------------------------------------------------------------------


async def test_a_request_snapshots_the_items_and_records_who_asked(client_for, make_user, make_program, templates):
    await make_program("t1")
    owner = await make_user("owner@example.com", [Role.CSM], name="Arjun M.")
    client = await csm_client(client_for, make_user)
    request = await new_request(client, title="Banner for Booking", detail="Hero banner", owner_id=owner.id, due_at="2026-11-01T10:00:00Z")
    assert (request["title"], request["status"], request["owner_name"], request["requested_by_name"]) == ("Banner for Booking", "open", "Arjun M.", "Priya S.")
    assert request["progress"] == {"done": 0, "total": 4} and len(request["items"]) == 4


async def test_marketing_and_account_managers_can_log_a_request_but_not_manage_it(client_for, make_user, make_program, templates):
    await make_program("t1")
    request = await new_request(await csm_client(client_for, make_user))
    for role, email in ((Role.MARKETING, "m@example.com"), (Role.ACCOUNT_MANAGER, "am@example.com")):
        client = await client_for(await make_user(email, [role]))
        assert (await client.post("/programs/t1/requests", json={"template_id": await template_id(client, "content_to_marketing")})).status_code == 201
        assert (await client.patch(f"/programs/t1/requests/{request['id']}", json={"title": "x"})).status_code == 403
        item = request["items"][0]["id"]
        assert (await client.put(f"/programs/t1/checklists/{request['id']}/items/{item}", json={"confirmed": True, "detail": "d"})).status_code == 403


async def test_an_unknown_owner_is_refused(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    response = await client.post("/programs/t1/requests", json={"template_id": await template_id(client, "content_to_marketing"), "owner_id": "nobody"})
    assert (response.status_code, response.json()["code"]) == (422, "owner_not_found")


async def test_an_item_that_needs_detail_cannot_be_confirmed_without_it(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    request = await new_request(client)
    needs = next(i for i in request["items"] if i["needs_detail"])
    plain = next(i for i in request["items"] if not i["needs_detail"])
    refused = await client.put(f"/programs/t1/checklists/{request['id']}/items/{needs['id']}", json={"confirmed": True})
    assert (refused.status_code, refused.json()["code"]) == (422, "detail_required")
    assert (await client.put(f"/programs/t1/checklists/{request['id']}/items/{plain['id']}", json={"confirmed": True})).status_code == 200


async def test_confirming_records_who_and_moves_the_request_along(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    request = await new_request(client)
    first = request["items"][0]
    one = (await client.put(f"/programs/t1/checklists/{request['id']}/items/{first['id']}", json={"confirmed": True, "detail": "1920x1080 PNG"})).json()
    confirmed = next(i for i in one["items"] if i["id"] == first["id"])
    assert one["status"] == "in_progress" and one["progress"] == {"done": 1, "total": 4}
    assert (confirmed["confirmed_by_name"], confirmed["detail"]) == ("Priya S.", "1920x1080 PNG")
    done = await confirm_all(client, request)
    assert done["status"] == "ready" and done["progress"] == {"done": 4, "total": 4}
    taken_back = (await client.put(f"/programs/t1/checklists/{request['id']}/items/{first['id']}", json={"confirmed": False})).json()
    assert taken_back["status"] == "in_progress"


async def test_a_request_cannot_be_done_until_every_required_item_is_confirmed(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    request = await new_request(client)
    early = await client.patch(f"/programs/t1/requests/{request['id']}", json={"status": "done"})
    assert (early.status_code, early.json()["code"]) == (409, "checklist_incomplete")
    await confirm_all(client, request)
    closed = await client.patch(f"/programs/t1/requests/{request['id']}", json={"status": "done", "resolution": "Sent to marketing"})
    assert closed.status_code == 200 and (closed.json()["status"], closed.json()["resolution"]) == ("done", "Sent to marketing")
    locked = await client.put(f"/programs/t1/checklists/{request['id']}/items/{request['items'][0]['id']}", json={"confirmed": False})
    assert (locked.status_code, locked.json()["code"]) == (409, "checklist_closed")


async def test_a_request_can_be_declined_without_completing_it(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    request = await new_request(client)
    declined = await client.patch(f"/programs/t1/requests/{request['id']}", json={"status": "declined", "resolution": "Out of scope"})
    assert declined.status_code == 200 and declined.json()["status"] == "declined"


async def test_the_phase_lifecycle_is_gone(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    assert (await client.get("/programs/t1/lifecycle")).status_code == 404


# ---- a special request's own Slack channel -----------------------------------------------


def stub_slack(monkeypatch, known: dict[str, str]):
    async def channel_name(channel_id: str):
        return (True, known[channel_id]) if channel_id in known else (False, "Channel not found (or it's private and the bot isn't in it).")

    monkeypatch.setattr("core.slack.channel_name", channel_name)


async def test_a_request_keeps_its_slack_channel_and_posts_there(client_for, make_user, make_program, templates, db, monkeypatch):
    stub_slack(monkeypatch, {"C0123456789": "hack-updates"})
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    request = await new_request(client, slack_channel_id=" C0123456789 ", detail="Banner for the finale")
    assert (request["slack_channel_id"], request["slack_channel_name"]) == ("C0123456789", "hack-updates")
    await client.patch(f"/programs/t1/requests/{request['id']}", json={"status": "declined", "resolution": "Out of scope"})
    async with db() as session:
        sent = (await session.scalars(select(SlackOutbox).order_by(SlackOutbox.id))).all()
    assert [m.channel_id for m in sent] == ["C0123456789", "C0123456789"]
    assert "New special request" in sent[0].body and "Banner for the finale" in sent[0].body
    assert "declined" in sent[1].body and "Out of scope" in sent[1].body


async def test_an_unknown_slack_channel_is_refused_and_nothing_is_created(client_for, make_user, make_program, templates, db, monkeypatch):
    stub_slack(monkeypatch, {})
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    response = await client.post("/programs/t1/requests", json={"template_id": await template_id(client, "content_to_marketing"), "slack_channel_id": "C0999999999"})
    assert (response.status_code, response.json()["code"]) == (422, "slack_channel_invalid")
    assert (await client.get("/programs/t1/requests")).json() == []


async def test_a_request_without_a_channel_posts_nothing(client_for, make_user, make_program, templates, db):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    request = await new_request(client)
    await client.patch(f"/programs/t1/requests/{request['id']}", json={"status": "declined"})
    async with db() as session:
        assert await session.scalar(select(func.count()).select_from(SlackOutbox)) == 0
