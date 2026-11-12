"""Replacing the SOW / POA from the portal: validation, read-first ordering, HubSpot write, rearrangement, audit, races."""

from __future__ import annotations

import aiohttp
import pytest
from sqlalchemy import select

from core import activities
from core.config import settings
from core.orm import (
    Program,
    ProgramActivity,
    ProgramDocument,
    ProgramEvent,
    ProgramNote,
)
from core.permissions import Role
from hubspot_client import document_upload, documents

PDF = b"%PDF-1.4 synthetic"
COMMENT = "Client revised the scope, new version signed"


def poa(*rows: tuple[str, str, str | None], title: str = "POA") -> dict:
    """(channel, activity, date) rows, all in week 1."""
    return {
        "title": title, "window_start": None, "window_end": None, "_v": documents.EXTRACTION_VERSIONS["poa"],
        "activities": [
            {"date": d, "week": "Week 1", "channel": c, "activity": a, "objective": "o", "description": "d"} for c, a, d in rows
        ],
    }


def sow(fee: int = 500000) -> dict:
    return {"title": "SOW", "customer": "Acme", "fee_amount_inr": fee, "_v": documents.EXTRACTION_VERSIONS["sow"]}


class FakeHub:
    def __init__(self) -> None:
        self.uploads: list[str] = []
        self.writes: list[dict[str, str]] = []
        self.notes: list[str] = []
        self.upload_error: Exception | None = None
        self.note_error: Exception | None = None

    async def upload_file(self, name: str, content: bytes, folder_path: str = "") -> dict:
        if self.upload_error:
            raise self.upload_error
        self.uploads.append(name)
        return {"id": "9001"}

    async def update_ticket_properties(self, ticket_id: str, properties: dict[str, str]) -> None:
        self.writes.append(properties)

    async def create_note(self, ticket_id: str, body: str) -> str:
        if self.note_error:
            raise self.note_error
        self.notes.append(body)
        return "note-77"


class Reader:
    """Stands in for the model: returns `details`, or raises `error`."""

    def __init__(self) -> None:
        self.details: dict = {}
        self.error: Exception | None = None

    async def __call__(self, kind: str, pdf: bytes) -> dict:
        if self.error:
            raise self.error
        return self.details


@pytest.fixture
def hub(monkeypatch) -> FakeHub:
    fake = FakeHub()
    monkeypatch.setattr(settings, "HUBSPOT_WRITEBACK_ENABLED", True)
    monkeypatch.setattr(document_upload, "HubSpotClient", lambda: fake)
    return fake


@pytest.fixture
def reader(monkeypatch) -> Reader:
    fake = Reader()
    monkeypatch.setattr(documents, "parse_document", fake)
    return fake


async def csm(client_for, make_user):
    return await client_for(await make_user("csm@example.com", [Role.CSM], name="Priya S."))


def upload(client, kind="poa", *, comment=COMMENT, content=PDF, name="plan v2.pdf"):
    return client.post(
        f"/programs/t1/documents/{kind}", files={"file": (name, content, "application/pdf")}, data={"comment": comment}
    )


async def seed_old_document(db, kind: str, details: dict, prop: str) -> None:
    async with db() as session:
        program = await session.get(Program, "t1")
        program.raw_properties = {prop: "1111"}
        session.add(
            ProgramDocument(
                ticket_id="t1", kind=kind, hubspot_property=prop, hubspot_file_id="1111", file_name="old.pdf",
                mime_type="application/pdf", size_bytes=3, content=b"old", status="ok", attempts=0, details=details,
            )
        )
        if kind == "poa":
            await activities.seed_from_poa(session, "t1", details)
        await session.commit()


async def stored(db, kind="poa") -> ProgramDocument:
    async with db() as session:
        return await session.get(ProgramDocument, ("t1", kind))


# ---- who, and what is refused before anything happens ---------------------------------------------


async def test_refused_while_writeback_is_off(client_for, make_user, make_program, monkeypatch):
    await make_program("t1")
    monkeypatch.setattr(settings, "HUBSPOT_WRITEBACK_ENABLED", False)
    response = await upload(await csm(client_for, make_user))
    assert (response.status_code, response.json()["code"]) == (503, "hubspot_writeback_disabled")


@pytest.mark.parametrize(
    "role, kind, allowed",
    [
        (Role.VIEWER, "poa", False), (Role.VIEWER, "sow", False),
        (Role.MARKETING, "sow", False), (Role.MARKETING, "poa", True),
        (Role.ACCOUNT_MANAGER, "sow", True), (Role.CSM, "sow", True),
    ],
)
async def test_who_may_upload_which_document(client_for, make_user, make_program, hub, reader, db, role, kind, allowed):
    await make_program("t1")
    reader.details = sow() if kind == "sow" else poa(("Email", "Blast", None))
    client = await client_for(await make_user("someone@example.com", [role]))
    response = await upload(client, kind)
    assert response.status_code == (201 if allowed else 403), response.text
    assert bool(hub.uploads) is allowed


async def test_unknown_kind_and_unknown_program_are_404(client_for, make_user, make_program, hub, reader):
    await make_program("t1")
    client = await csm(client_for, make_user)
    assert (await upload(client, "contract")).status_code == 404
    missing = await client.post("/programs/nope/documents/sow", files={"file": ("a.pdf", PDF, "application/pdf")}, data={"comment": COMMENT})
    assert missing.status_code == 404


@pytest.mark.parametrize(
    "kwargs, code",
    [
        ({"comment": "short"}, "comment_required"),
        ({"comment": "   "}, "comment_required"),
        ({"comment": "x" * 1001}, "comment_too_long"),
        ({"content": b""}, "invalid_file"),
        ({"content": b"not a pdf at all"}, "invalid_file"),
        ({"content": PDF + b"0" * document_upload.MAX_BYTES}, "file_too_large"),
    ],
)
async def test_a_bad_request_changes_nothing(client_for, make_user, make_program, hub, reader, db, kwargs, code):
    await make_program("t1")
    reader.details = poa(("Email", "Blast", None))
    response = await upload(await csm(client_for, make_user), **kwargs)
    assert response.json()["code"] == code
    assert hub.uploads == [] and hub.writes == [] and await stored(db) is None


async def test_the_comment_is_required_by_the_endpoint_itself(client_for, make_user, make_program, hub, reader):
    await make_program("t1")
    client = await csm(client_for, make_user)
    response = await client.post("/programs/t1/documents/poa", files={"file": ("a.pdf", PDF, "application/pdf")})
    assert response.status_code == 422


# ---- the read-first rule ---------------------------------------------------------------------------


async def test_an_unreadable_file_leaves_everything_as_it_was_and_is_logged(client_for, make_user, make_program, hub, reader, db):
    await make_program("t1")
    await seed_old_document(db, "poa", poa(("Email", "Old blast", "2026-11-20")), "marketing_poa_upload")
    reader.error = ValueError("model returned no parsed output")
    client = await csm(client_for, make_user)
    response = await upload(client)
    assert (response.status_code, response.json()["code"]) == (422, "extraction_failed")

    assert hub.uploads == [] and hub.writes == []  # never reached HubSpot
    doc = await stored(db)
    assert (doc.hubspot_file_id, doc.file_name, doc.status, doc.details["activities"][0]["activity"]) == ("1111", "old.pdf", "ok", "Old blast")
    async with db() as session:
        event = await session.scalar(select(ProgramEvent).where(ProgramEvent.action == "document_reupload_refused"))
        titles = (await session.scalars(select(ProgramActivity.title))).all()
    assert (event.new["code"], event.new["comment"], event.actor_name) == ("extraction_failed", COMMENT, "Priya S.")
    history = (await client.get("/programs/t1/documents/poa/versions")).json()
    assert [(v["status"], v["source"], v["comment"]) for v in history] == [("failed", "app", COMMENT)]
    assert titles == ["Old blast"]


# ---- a successful replacement ----------------------------------------------------------------------


async def test_replacing_the_poa_writes_hubspot_swaps_the_file_and_logs_everything(client_for, make_user, make_program, hub, reader, db):
    await make_program("t1")
    await seed_old_document(
        db, "poa", poa(("Email", "Kept", "2026-11-20"), ("Social", "Dropped", None), ("Email", "Edited and dropped", None)),
        "marketing_poa_upload",
    )
    async with db() as session:  # someone edited one row
        row = await session.scalar(select(ProgramActivity).where(ProgramActivity.title == "Edited and dropped"))
        row.updated_by = "u1"
        await session.commit()
    reader.details = poa(("Email", "Kept", "2026-12-01"), ("Community", "Brand new", None), title="POA v2")

    response = await upload(await csm(client_for, make_user))
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["plan"] == {"added": 1, "removed": 1, "edits_kept": 1, "updated": 1, "flagged": 1}
    assert body["hubspot_note"] is True and body["version"]["comment"] == COMMENT

    # HubSpot: file uploaded, ticket property points at it, a note records why
    assert len(hub.uploads) == 1 and hub.uploads[0].startswith("t1-poa-") and hub.uploads[0].endswith("plan v2.pdf")
    assert hub.writes == [{"marketing_poa_upload": "9001"}]
    assert COMMENT in hub.notes[0] and "Priya S." in hub.notes[0]

    # the stored document, the program's own copy of the property, and the details
    doc = await stored(db)
    assert (doc.hubspot_file_id, doc.file_name, doc.status, doc.content, doc.details["title"]) == ("9001", "plan v2.pdf", "ok", PDF, "POA v2")
    async with db() as session:
        assert (await session.get(Program, "t1")).raw_properties["marketing_poa_upload"] == "9001"
        plan = {a.title: a for a in (await session.scalars(select(ProgramActivity))).all()}
        event = await session.scalar(select(ProgramEvent).where(ProgramEvent.action == "document_reuploaded"))
        note = await session.get(ProgramNote, "note-77")
    # rearranged: unedited follows the POA (date moved), vanished unedited is gone, edited is kept and flagged
    assert set(plan) == {"Kept", "Edited and dropped", "Brand new"}
    assert str(plan["Kept"].planned_date) == "2026-12-01" and plan["Kept"].not_in_poa is False
    assert plan["Edited and dropped"].not_in_poa is True and plan["Brand new"].not_in_poa is False
    version = body["version"]
    assert (version["source"], version["status"], version["file_name"], version["comment"], version["uploaded_by_name"]) == ("app", "ok", "plan v2.pdf", COMMENT, "Priya S.")
    assert event.old == {"file": "old.pdf", "file_id": "1111"} and event.new["comment"] == COMMENT and event.new["plan"]["added"] == 1
    assert note.source == "hubspot" and note.author_name == "Priya S."


async def test_a_dropped_row_listed_again_is_unflagged(db, make_program):
    await make_program("t1")
    async with db() as session:
        await activities.seed_from_poa(session, "t1", poa(("Email", "Blast", None)))
        row = await session.scalar(select(ProgramActivity))
        row.updated_by = "u1"
        await activities.seed_from_poa(session, "t1", poa(("Social", "Other", None)))
        assert row.not_in_poa is True
        await activities.seed_from_poa(session, "t1", poa(("Email", "Blast", None)))
        assert row.not_in_poa is False


async def test_the_first_ever_upload_works_and_a_missing_note_scope_does_not_undo_it(client_for, make_user, make_program, hub, reader, db):
    await make_program("t1")
    hub.note_error = aiohttp.ClientResponseError(None, (), status=403)  # type: ignore[arg-type]
    reader.details = poa(("Email", "Blast", None))
    response = await upload(await csm(client_for, make_user))
    assert response.status_code == 201 and response.json()["hubspot_note"] is False
    assert (await stored(db)).hubspot_file_id == "9001"
    async with db() as session:
        note = await session.scalar(select(ProgramNote))
    assert note.source == "programops" and COMMENT in note.body  # kept locally instead


async def test_replacing_the_sow_updates_the_deal_value(client_for, make_user, make_program, hub, reader, db):
    await make_program("t1")
    reader.details = sow(750000)
    response = await upload(await csm(client_for, make_user), "sow")
    assert response.status_code == 201 and response.json()["plan"] is None
    assert hub.writes == [{"sow_upload": "9001"}]
    async with db() as session:
        program = await session.get(Program, "t1")
    assert (program.expected_deal_size, program.deal_size_source) == (750000, "sow")


@pytest.mark.parametrize("status, code", [(403, "hubspot_scope_missing"), (500, "hubspot_unavailable")])
async def test_a_hubspot_failure_changes_nothing_and_is_logged(client_for, make_user, make_program, hub, reader, db, status, code):
    await make_program("t1")
    await seed_old_document(db, "sow", sow(), "sow_upload")
    reader.details = sow(999)
    hub.upload_error = aiohttp.ClientResponseError(None, (), status=status)  # type: ignore[arg-type]
    client = await csm(client_for, make_user)
    response = await upload(client, "sow")
    assert (response.status_code, response.json()["code"]) == (502, code)
    assert (await stored(db, "sow")).hubspot_file_id == "1111"
    async with db() as session:
        assert (await session.get(Program, "t1")).raw_properties["sow_upload"] == "1111"
    history = (await client.get("/programs/t1/documents/sow/versions")).json()
    assert [(v["status"], v["comment"], v["error"] is not None) for v in history] == [("failed", COMMENT, True)]


async def test_version_history_lists_newest_first(client_for, make_user, make_program, hub, reader):
    await make_program("t1")
    client = await csm(client_for, make_user)
    reader.details = poa(("Email", "Blast", None))
    await upload(client, comment="first version of the plan")
    await upload(client, comment="second version of the plan")
    versions = (await client.get("/programs/t1/documents/poa/versions")).json()
    assert [v["comment"] for v in versions] == ["second version of the plan", "first version of the plan"]
    assert all(v["status"] == "ok" and v["file_name"] == "plan v2.pdf" and v["size_bytes"] == len(PDF) for v in versions)
    assert (await client.get("/programs/t1/documents/sow/versions")).json() == []


async def test_the_history_needs_audit_view_because_it_is_the_audit_trail(client_for, make_user, make_program):
    await make_program("t1")
    viewer = await client_for(await make_user("viewer@example.com", [Role.VIEWER]))
    assert (await viewer.get("/programs/t1/documents/poa/versions")).status_code == 403
    marketing = await client_for(await make_user("marketing@example.com", [Role.MARKETING]))
    assert (await marketing.get("/programs/t1/documents/poa/versions")).status_code == 200


# ---- the sync can't undo an upload -----------------------------------------------------------------


class SyncHub:
    async def fetch_file(self, file_id: str):
        return {"name": "stale", "extension": "pdf", "createdAt": None}, b"%PDF-1.4 stale"


async def test_a_sync_holding_an_old_file_id_cannot_overwrite_a_newer_upload(client_for, make_user, make_program, hub, reader, db):
    await make_program("t1")
    reader.details = poa(("Email", "Blast", None))
    await upload(await csm(client_for, make_user))  # the ticket now points at file 9001

    await documents._process(SyncHub(), "t1", "poa", "marketing_poa_upload", "1111", 0)  # a sync that fetched the old id
    doc = await stored(db)
    assert (doc.hubspot_file_id, doc.file_name) == ("9001", "plan v2.pdf")


async def test_a_sync_that_saw_an_empty_property_cannot_delete_an_upload(client_for, make_user, make_program, hub, reader, db):
    await make_program("t1")
    reader.details = poa(("Email", "Blast", None))
    await upload(await csm(client_for, make_user))
    await documents._delete_document("t1", "poa")  # the sync's stale decision
    assert await stored(db) is not None


async def test_a_file_changed_directly_in_hubspot_is_recorded_as_a_version(client_for, make_user, make_program, reader, db):
    await make_program("t1")
    async with db() as session:
        (await session.get(Program, "t1")).raw_properties = {"marketing_poa_upload": "5555"}
        await session.commit()
    reader.details = poa(("Email", "Blast", None))
    await documents._process(SyncHub(), "t1", "poa", "marketing_poa_upload", "5555", 0)
    await documents._process(SyncHub(), "t1", "poa", "marketing_poa_upload", "5555", 0)  # a retry is not a new version
    async with db() as session:
        events = (await session.scalars(select(ProgramEvent).where(ProgramEvent.entity == "document"))).all()
    assert [(e.action, e.actor_name, e.new["file_id"], e.new["status"]) for e in events] == [("document_synced", "system", "5555", "ok")]
    history = (await (await csm(client_for, make_user)).get("/programs/t1/documents/poa/versions")).json()
    assert [(v["source"], v["comment"], v["uploaded_by_name"]) for v in history] == [("hubspot", None, None)]


def test_file_names_are_made_safe():
    assert document_upload.safe_name("../../etc/My SOW (final).PDF", "sow") == "My SOW _final_.pdf"
    assert document_upload.safe_name("", "poa") == "poa.pdf"
    assert document_upload.safe_name("a\\b\\c.pdf", "poa") == "c.pdf"
