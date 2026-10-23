"""The stage checklist comes from HubSpot's ticket properties only, with per-stage progress for the stage bar."""

from __future__ import annotations

from core.orm import Program
from core.permissions import Role


async def test_each_stage_reports_how_much_of_its_hubspot_checklist_is_ticked(client_for, make_user, make_program, db):
    await make_program("t1")
    async with db() as session:
        program = await session.get(Program, "t1")  # the fixture's program sits in Onboarding
        program.pre_sales_status = ["Requirement Gathering", "Proposal Shared", "PO Closed", "SOW Shared", "SOW Signed"]
        program.onboarding_status = ["Kickoff Done", "Page Build"]
        await session.commit()
    client = await client_for(await make_user("csm@example.com", [Role.CSM]))
    row = next(r for r in (await client.get("/programs/analytics/checklist-status")).json() if r["ticket_id"] == "t1")
    stages = {s["key"]: (s["done"], s["total"]) for s in row["stages"]}
    assert stages == {"new": (0, 0), "pre_sales": (5, 5), "onboarding": (2, 9), "ongoing": (0, 7), "post_campaign": (0, 4), "closed": (0, 0)}
    assert row["completed_items"] == ["Kickoff Done", "Page Build"] and "Go-Live Approved" in row["pending_items"]
    assert "derived_items" not in row
