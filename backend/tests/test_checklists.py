"""The checklist engine: templates, special requests, item confirmation, and the lifecycle phase gates."""

from __future__ import annotations

from sqlalchemy import func, select

from core import checklists
from core.checklists import Phase
from core.orm import Checklist, ChecklistTemplate, ProgramPhase
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
        assert keys == {
            "content_to_marketing", "assessment_readiness", "phase_kickoff", "phase_requirements", "phase_content_approval",
            "phase_launch_readiness", "phase_participant_management", "phase_execution", "phase_closure",
        }
        (await session.scalar(select(ChecklistTemplate).where(ChecklistTemplate.key == "phase_kickoff"))).name = "Edited by a CSM"
        await session.commit()
        await checklists.ensure_default_templates(session)
        await session.commit()
        assert await session.scalar(select(ChecklistTemplate.name).where(ChecklistTemplate.key == "phase_kickoff")) == "Edited by a CSM"
        assert await session.scalar(select(func.count()).select_from(ChecklistTemplate)) == 9


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


async def test_a_phase_template_is_not_a_request_type(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    response = await client.post("/programs/t1/requests", json={"template_id": await template_id(client, "phase_kickoff")})
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


async def test_a_non_request_checklist_cannot_be_edited_as_a_request(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    gate = next(p for p in (await client.get("/programs/t1/lifecycle")).json() if p["phase"] == "kickoff")["gate"]
    response = await client.patch(f"/programs/t1/requests/{gate['id']}", json={"title": "x"})
    assert (response.status_code, response.json()["code"]) == (422, "not_a_request")


# ---- lifecycle -------------------------------------------------------------------


async def test_the_lifecycle_has_the_seven_phases_in_order_each_with_a_gate(client_for, make_user, make_program, templates):
    await make_program("t1")
    phases = (await (await csm_client(client_for, make_user)).get("/programs/t1/lifecycle")).json()
    assert [p["phase"] for p in phases] == [
        "kickoff", "requirements", "content_approval", "launch_readiness", "participant_management", "execution", "closure",
    ]
    assert all(p["status"] == "not_started" and p["gate"]["kind"] == "phase" and p["gate"]["items"] for p in phases)
    assert phases[2]["title"] == "Content approval" and phases[2]["gate"]["title"] == "Content approval gate"


async def test_opening_the_lifecycle_twice_creates_nothing_new(client_for, make_user, make_program, templates, db):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    await client.get("/programs/t1/lifecycle")
    await client.get("/programs/t1/lifecycle")
    async with db() as session:
        assert await session.scalar(select(func.count()).select_from(ProgramPhase)) == 7
        assert await session.scalar(select(func.count()).select_from(Checklist).where(Checklist.kind == "phase")) == 7
        await checklists.ensure_lifecycle(session, "t1")  # the service itself is idempotent too
        await session.commit()
        assert await session.scalar(select(func.count()).select_from(ProgramPhase)) == 7


async def test_a_phase_cannot_be_completed_until_its_gate_is_ready(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    kickoff = next(p for p in (await client.get("/programs/t1/lifecycle")).json() if p["phase"] == "kickoff")
    early = await client.patch("/programs/t1/lifecycle/kickoff", json={"status": "done"})
    assert (early.status_code, early.json()["code"]) == (409, "phase_gate_incomplete")
    await confirm_all(client, kickoff["gate"])
    done = (await client.patch("/programs/t1/lifecycle/kickoff", json={"status": "done"})).json()
    assert (done["status"], done["completed_by_name"]) == ("done", "Priya S.") and done["completed_at"]
    reopened = (await client.patch("/programs/t1/lifecycle/kickoff", json={"status": "in_progress"})).json()
    assert reopened["completed_at"] is None and reopened["completed_by_name"] is None


async def test_a_phase_can_be_skipped_with_a_reason_and_has_dates(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    refused = await client.patch("/programs/t1/lifecycle/participant_management", json={"status": "skipped"})
    assert (refused.status_code, refused.json()["code"]) == (422, "skip_reason_required")
    skipped = (await client.patch(
        "/programs/t1/lifecycle/participant_management",
        json={"status": "skipped", "skip_reason": "Client manages participants", "starts_on": "2026-10-01", "due_on": "2026-10-05"},
    )).json()
    assert (skipped["status"], skipped["skip_reason"], skipped["starts_on"], skipped["due_on"]) == (
        "skipped", "Client manages participants", "2026-10-01", "2026-10-05",
    )


async def test_gate_items_are_confirmed_through_the_same_endpoint_as_requests(client_for, make_user, make_program, templates):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    gate = next(p for p in (await client.get("/programs/t1/lifecycle")).json() if p["phase"] == "requirements")["gate"]
    after = await client.put(f"/programs/t1/checklists/{gate['id']}/items/{gate['items'][0]['id']}", json={"confirmed": True})
    assert after.status_code == 200 and after.json()["status"] == "in_progress"


async def test_everyone_internal_can_read_the_lifecycle_but_only_a_csm_changes_it(client_for, make_user, make_program, templates):
    await make_program("t1")
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    assert (await marketing.get("/programs/t1/lifecycle")).status_code == 200
    assert (await marketing.patch("/programs/t1/lifecycle/kickoff", json={"status": "in_progress"})).status_code == 403
    assert Phase.CLOSURE.value == "closure"
