"""The audit trail: immutable, attributed to the signed-in user, readable by every internal role."""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select, text, update
from sqlalchemy.exc import DBAPIError

from core import audit
from core.orm import ProgramEvent, ProgramNote
from core.permissions import Role


async def test_an_event_cannot_be_updated_or_deleted_even_by_the_app(db):
    async with db() as session:
        audit.record(session, None, entity="x", entity_id="1", action="created")
        await session.commit()
    for statement in (update(ProgramEvent).values(action="tampered"), delete(ProgramEvent)):
        async with db() as session:
            with pytest.raises(DBAPIError, match="append-only"):
                await session.execute(statement)
    async with db() as session:
        assert await session.scalar(select(ProgramEvent.action)) == "created"


async def test_an_event_without_an_actor_is_attributed_to_the_system(db):
    async with db() as session:
        audit.record(session, None, entity="x", entity_id="1", action="created")
        await session.commit()
        event = await session.scalar(select(ProgramEvent))
    assert (event.actor_id, event.actor_name) == (None, "system")


async def test_a_note_is_attributed_to_the_signed_in_user_not_the_request_body(client_for, make_user, make_program, db):
    await make_program("t1")
    user = await make_user("priya@example.com", [Role.CSM], name="Priya S.")
    client = await client_for(user)
    response = await client.post("/programs/t1/notes", json={"body": "  all good  ", "author_name": "Mallory"})
    assert response.status_code == 201
    assert response.json()["author_name"] == "Priya S."
    async with db() as session:
        note = await session.scalar(select(ProgramNote))
        event = await session.scalar(select(ProgramEvent).where(ProgramEvent.action == "note_added"))
    assert (note.author_id, note.body) == (user.id, "all good")
    assert (event.actor_id, event.actor_name, event.ticket_id) == (user.id, "Priya S.", "t1")


async def test_changing_the_registration_config_records_old_and_new(client_for, make_user, make_program, db):
    await make_program("t1")
    client = await client_for(await make_user("c@example.com", [Role.CSM]))
    await client.put("/programs/t1/registrations/config", json={"roles": ["SWE"], "fields": []})
    await client.put("/programs/t1/registrations/config", json={"roles": ["SWE", "QA"], "fields": ["Source"]})
    async with db() as session:
        events = (await session.scalars(select(ProgramEvent).where(ProgramEvent.action == "config_changed").order_by(ProgramEvent.id))).all()
    assert events[1].old == {"roles": ["SWE"], "fields": []}
    assert events[1].new == {"roles": ["SWE", "QA"], "fields": ["Source"]}


async def test_a_failed_request_leaves_no_event(client_for, make_user, make_program, db):
    await make_program("t1")
    client = await client_for(await make_user("a@example.com", [Role.ACCOUNT_MANAGER]))
    assert (await client.put("/programs/t1/registrations/config", json={"roles": [], "fields": []})).status_code == 403
    async with db() as session:
        assert await session.scalar(select(ProgramEvent.id)) is None


async def test_the_audit_log_pages_newest_first(client_for, make_user, make_program):
    await make_program("t1")
    client = await client_for(await make_user("a@example.com", [Role.ACCOUNT_MANAGER]))
    for n in range(5):
        await client.post("/programs/t1/notes", json={"body": f"note {n}"})
    first = (await client.get("/audit", params={"limit": 2})).json()
    second = (await client.get("/audit", params={"limit": 2, "before": first["next_before"]})).json()
    third = (await client.get("/audit", params={"limit": 2, "before": second["next_before"]})).json()
    ids = [e["id"] for page in (first, second, third) for e in page["items"]]
    assert ids == sorted(ids, reverse=True) and len(ids) == 5 and len(set(ids)) == 5
    assert third["next_before"] is None


async def test_the_audit_log_can_be_filtered_by_program(client_for, make_user, make_program):
    await make_program("t1")
    await make_program("t2")
    client = await client_for(await make_user("a@example.com", [Role.ACCOUNT_MANAGER]))
    await client.post("/programs/t1/notes", json={"body": "one"})
    await client.post("/programs/t2/notes", json={"body": "two"})
    items = (await client.get("/audit", params={"ticket_id": "t2"})).json()["items"]
    assert [e["ticket_id"] for e in items] == ["t2"]


async def test_a_person_with_no_role_cannot_read_the_audit_log(client_for, make_user):
    response = await (await client_for(await make_user("new@example.com"))).get("/audit")
    assert response.status_code == 403
