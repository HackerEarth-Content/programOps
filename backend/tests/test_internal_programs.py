"""Internal hackathons: created in the portal (with a real HubSpot ticket when write-back is on), never deleted by the sync."""

from __future__ import annotations

from sqlalchemy import select

from core.orm import Program
from core.permissions import Role
from hubspot_client.db_writer import delete_missing_programs


async def csm_client(client_for, make_user):
    return await client_for(await make_user("csm@example.com", [Role.CSM], name="Priya S."))


async def new_internal(client, name="Campus Hack 2026") -> dict:
    response = await client.post("/programs/internal", json={"name": name, "registration_start_date": "2026-11-01", "event_end_date": "2026-11-20"})
    assert response.status_code == 201, response.text
    return response.json()


async def test_a_csm_starts_an_internal_hackathon_at_onboarding(client_for, make_user):
    client = await csm_client(client_for, make_user)
    program = await new_internal(client)
    assert program["ticket_id"].startswith("INT-") and program["origin"] == "internal"
    assert (program["stage"], program["campaign_type"], program["display_name"]) == ("Onboarding", "Hackathon", "Campus Hack 2026")
    listed = {p["ticket_id"]: p for p in (await client.get("/programs")).json()}
    assert listed[program["ticket_id"]]["origin"] == "internal"


async def test_only_someone_who_can_create_programs_starts_one(client_for, make_user):
    marketing = await client_for(await make_user("m@example.com", [Role.MARKETING]))
    assert (await marketing.post("/programs/internal", json={"name": "X"})).status_code == 403
    csm = await csm_client(client_for, make_user)
    assert (await csm.post("/programs/internal", json={"name": ""})).status_code == 422
    backwards = await csm.post("/programs/internal", json={"name": "X", "registration_start_date": "2026-11-20", "event_end_date": "2026-11-01"})
    assert (backwards.status_code, backwards.json()["code"]) == (422, "program_dates_invalid")


async def test_the_hubspot_sync_never_deletes_an_internal_program(client_for, make_user, make_program, db):
    await make_program("t1")  # a HubSpot program HubSpot no longer lists
    internal = await new_internal(await csm_client(client_for, make_user))
    assert await delete_missing_programs(set()) == ["t1"]
    async with db() as session:
        assert (await session.scalars(select(Program.ticket_id))).all() == [internal["ticket_id"]]


async def test_an_internal_program_moves_stage_and_ticks_items_without_hubspot(client_for, make_user):
    client = await csm_client(client_for, make_user)
    ticket = (await new_internal(client))["ticket_id"]

    tick = await client.post(f"/programs/{ticket}/hubspot/checklist", json={"stage_key": "onboarding", "item": "Kickoff Done", "done": True, "expected": []})
    assert (tick.status_code, tick.json()["selected"]) == (200, ["Kickoff Done"])
    stale = await client.post(f"/programs/{ticket}/hubspot/checklist", json={"stage_key": "onboarding", "item": "Page Build", "done": True, "expected": []})
    assert (stale.status_code, stale.json()["code"]) == (409, "program_conflict")
    status = next(r for r in (await client.get("/programs/analytics/checklist-status")).json() if r["ticket_id"] == ticket)
    assert status["completed_items"] == ["Kickoff Done"]

    moved = await client.post(f"/programs/{ticket}/hubspot/stage", json={"stage_key": "ongoing", "expected_stage_key": "onboarding"})
    assert (moved.status_code, moved.json()["stage_label"]) == (200, "Ongoing")
    assert (await client.get(f"/programs/{ticket}")).json()["stage"] == "Ongoing"
    behind = await client.post(f"/programs/{ticket}/hubspot/stage", json={"stage_key": "post_campaign", "expected_stage_key": "onboarding"})
    assert (behind.status_code, behind.json()["code"]) == (409, "program_conflict")
    feasibility = await client.post(f"/programs/{ticket}/hubspot/stage", json={"stage_key": "pre_sales", "expected_stage_key": "ongoing"})
    assert (feasibility.status_code, feasibility.json()["code"]) == (422, "unknown_stage")


async def test_the_event_type_is_chosen_not_fixed(client_for, make_user):
    client = await csm_client(client_for, make_user)
    hiring = await client.post("/programs/internal", json={"name": "Campus drive", "campaign_type": "Coding Challenge"})
    assert (hiring.status_code, hiring.json()["campaign_type"]) == (201, "Coding Challenge")
    assert (await new_internal(client, "Plain default"))["campaign_type"] == "Hackathon"  # still the default
    refused = await client.post("/programs/internal", json={"name": "X", "campaign_type": "Webinar"})
    assert refused.status_code == 422


# --- with HubSpot write-back on, a real ticket is created first -------------------------------------------------

class FakeHubSpot:
    created: list[dict] = []
    deleted: list[str] = []
    fail_with: Exception | None = None

    async def fetch_owner_emails(self):
        return {"77": "csm@example.com", "88": "someone@example.com"}

    async def create_ticket(self, properties):
        if FakeHubSpot.fail_with:
            raise FakeHubSpot.fail_with
        FakeHubSpot.created.append(properties)
        return "9001"

    async def delete_ticket(self, ticket_id):
        FakeHubSpot.deleted.append(ticket_id)


def hubspot_on(monkeypatch):
    from core import internal_programs
    from core.config import settings

    FakeHubSpot.created, FakeHubSpot.deleted, FakeHubSpot.fail_with = [], [], None
    monkeypatch.setattr(settings, "HUBSPOT_WRITEBACK_ENABLED", True)
    monkeypatch.setattr(internal_programs, "HubSpotClient", FakeHubSpot)


async def test_a_real_ticket_is_created_and_its_id_becomes_the_program_id(client_for, make_user, monkeypatch):
    hubspot_on(monkeypatch)
    program = await new_internal(await csm_client(client_for, make_user))
    assert program["ticket_id"] == "9001" and program["origin"] == "internal"
    (sent,) = FakeHubSpot.created
    assert sent["subject"] == "[Internal] Campus Hack 2026" and sent["program_name"] == "Campus Hack 2026"
    assert sent["campaign_type"] == "Hackathon" and sent["hs_pipeline_stage"] == "1435441941"
    assert sent["csm_for_the_deal"] == "77" and sent["event_end_date_skip_if_undefined"] == "2026-11-20"
    assert sent["registration_start_date_skip_if_undefined"] == "2026-11-01"


async def test_a_ticketed_internal_program_changes_stage_through_hubspot_not_locally(db, make_program):
    from core import internal_programs

    await make_program("9001")
    async with db() as session:
        program = await session.get(Program, "9001")
        program.origin = "internal"
        assert internal_programs.is_internal(program) and not internal_programs.is_local_only(program)
        program.ticket_id = "INT-AB12"
        assert internal_programs.is_local_only(program)


async def test_if_hubspot_refuses_nothing_is_saved(client_for, make_user, db, monkeypatch):
    import aiohttp

    hubspot_on(monkeypatch)
    FakeHubSpot.fail_with = aiohttp.ClientResponseError(None, (), status=403)
    client = await csm_client(client_for, make_user)
    response = await client.post("/programs/internal", json={"name": "X"})
    assert response.status_code == 502 and "allowed to create tickets" in response.text
    async with db() as session:
        assert (await session.scalars(select(Program))).all() == []


async def test_if_the_portal_save_fails_the_new_ticket_is_archived_again(client_for, make_user, monkeypatch):
    from core import audit

    hubspot_on(monkeypatch)

    def boom(*args, **kwargs):
        raise RuntimeError("database trouble")

    monkeypatch.setattr(audit, "record", boom)
    client = await csm_client(client_for, make_user)
    client._transport.raise_app_exceptions = False
    response = await client.post("/programs/internal", json={"name": "X"})
    assert response.status_code == 500 and FakeHubSpot.deleted == ["9001"]
