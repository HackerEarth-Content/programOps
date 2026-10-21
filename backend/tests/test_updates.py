"""Daily updates and comments: append-only, authored by the signed-in user."""

from __future__ import annotations

from sqlalchemy import select

from core.orm import ProgramEvent
from core.permissions import Role


async def csm_client(client_for, make_user):
    return await client_for(await make_user("csm@example.com", [Role.CSM], name="Priya S."))


async def post_update(client, health="good", summary="Round 1 wrapped up smoothly.", **extra):
    return await client.post("/programs/t1/updates", json={"health": health, "summary": summary, **extra})


async def test_the_csm_posts_the_daily_update_with_health_summary_and_blockers(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    response = await post_update(client, "warning", "Candidate cutoff counts pending.", blockers="Awaiting final sign-off from the client")
    body = response.json()
    assert response.status_code == 201
    assert (body["kind"], body["health"], body["author_name"], body["blockers"]) == (
        "update", "warning", "Priya S.", "Awaiting final sign-off from the client",
    )


async def test_an_update_needs_a_valid_health_and_a_summary(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    assert (await post_update(client, "great")).status_code == 422
    assert (await post_update(client, summary="")).status_code == 422


async def test_marketing_can_post_an_update_and_everyone_internal_can_comment_but_an_account_manager_cannot_update(client_for, make_user, make_program):
    await make_program("t1")
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING], name="Neha K."))
    assert (await post_update(marketing)).status_code == 201
    am = await client_for(await make_user("am@example.com", [Role.ACCOUNT_MANAGER], name="Meera J."))
    assert (await post_update(am)).status_code == 403
    comment = await am.post("/programs/t1/comments", json={"body": "Client asked about the finale venue."})
    assert comment.status_code == 201 and comment.json()["kind"] == "comment" and comment.json()["author_name"] == "Meera J."


async def test_updates_list_newest_first_and_can_be_filtered_by_kind(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    await post_update(client, summary="first")
    await client.post("/programs/t1/comments", json={"body": "a comment"})
    await post_update(client, summary="second")
    everything = (await client.get("/programs/t1/updates")).json()["items"]
    assert [n["body"] for n in everything] == ["second", "a comment", "first"]
    only_updates = (await client.get("/programs/t1/updates", params={"kind": "update"})).json()["items"]
    assert [n["body"] for n in only_updates] == ["second", "first"]


async def test_updates_page_with_a_keyset_cursor(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    for n in range(5):
        await post_update(client, summary=f"update {n}")
    first = (await client.get("/programs/t1/updates", params={"limit": 2})).json()
    second = (await client.get("/programs/t1/updates", params={"limit": 2, "before": first["next_before"]})).json()
    third = (await client.get("/programs/t1/updates", params={"limit": 2, "before": second["next_before"]})).json()
    assert [n["body"] for p in (first, second, third) for n in p["items"]] == [f"update {n}" for n in (4, 3, 2, 1, 0)]
    assert third["next_before"] is None


async def test_updates_cannot_be_edited_or_deleted(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    note_id = (await post_update(client)).json()["note_id"]
    for method in ("PATCH", "PUT", "DELETE"):
        response = await client.request(method, f"/programs/t1/updates/{note_id}", json={})
        assert response.status_code in (404, 405)


async def test_an_update_shows_in_the_notes_feed_with_its_kind_and_health(client_for, make_user, make_program):
    await make_program("t1")
    client = await csm_client(client_for, make_user)
    await post_update(client, "critical", "Blocked on assets")
    note = (await client.get("/programs/t1/notes")).json()[0]
    assert (note["kind"], note["health"], note["author_name"]) == ("update", "critical", "Priya S.")


async def test_posting_is_audited_with_the_actor(client_for, make_user, make_program, db):
    await make_program("t1")
    user = await make_user("csm@example.com", [Role.CSM], name="Priya S.")
    client = await client_for(user)
    await post_update(client)
    await client.post("/programs/t1/comments", json={"body": "hi"})
    async with db() as session:
        events = (await session.scalars(select(ProgramEvent).order_by(ProgramEvent.id))).all()
    assert [e.action for e in events] == ["update_posted", "comment_posted"] and {e.actor_id for e in events} == {user.id}


async def test_an_unknown_program_is_404(client_for, make_user):
    response = await post_update(await csm_client(client_for, make_user))
    assert (response.status_code, response.json()["code"]) == (404, "program_not_found")
