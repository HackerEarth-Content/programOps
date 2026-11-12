"""A POA row's week comes from the week cell its row sits in, read from the PDF's borders, not from where the label is printed."""

from __future__ import annotations

from sqlalchemy import select

from core.orm import ProgramActivity, ProgramDocument
from core.permissions import Role
from hubspot_client import documents, poa_weeks
from tests.test_marketing import poa, rows, seed


def word(text: str, x: float, y: float) -> dict:
    return {"text": text, "x0": x, "x1": x + 6 * len(text), "top": y, "bottom": y + 8}


class FakePage:
    """A schedule the way Sheets prints it: week labels on the LAST row of their merged cell, a border across the
    WEEK column only between weeks, and a final row whose cell has no label."""

    def __init__(self) -> None:
        self.words = [word("WEEK", 30, 10), word("DATE", 100, 10), word("DAY", 170, 10)]
        dates = ["12 Nov 2026", "13 Nov 2026", "15 Nov 2026", "17 Nov 2026", "19 Nov 2026", "4th Nov 2026"]
        for i, text in enumerate(dates):
            y = 30 + 20 * i
            self.words += [word(part, 90 + 20 * j, y) for j, part in enumerate(text.split())] + [word("Thurs", 170, y)]
        self.words += [word("Week", 28, 70), word("1", 56, 70), word("Week", 28, 110), word("2", 56, 110)]
        border = lambda y: {"x0": 20, "x1": 80, "top": y, "bottom": y + 0.5}  # noqa: E731
        self.lines, self.curves = [border(24), border(84)], [border(124), border(144)]
        self.rects = [{"x0": 20, "x1": 80, "top": 24, "bottom": 144}]  # the column's fill: tall, so not a border

    def extract_words(self) -> list[dict]:
        return sorted(self.words, key=lambda w: (w["top"], w["x0"]))


def test_a_row_takes_the_week_of_the_cell_it_sits_in_wherever_the_label_is_printed():
    assert poa_weeks._page_rows(FakePage()) == [
        ("12 Nov 2026", "Week 1"), ("13 Nov 2026", "Week 1"), ("15 Nov 2026", "Week 1"),  # the label is on the 15th
        ("17 Nov 2026", "Week 2"), ("19 Nov 2026", "Week 2"),
        ("4th Nov 2026", ""),  # its cell has no label: no week, not the nearest one
    ]


def test_nothing_is_claimed_without_a_week_and_date_table_or_when_a_cell_has_no_borders():
    page = FakePage()
    page.words = [w for w in page.words if w["text"] != "DATE"]
    assert poa_weeks._page_rows(page) is None
    page = FakePage()
    page.lines, page.curves = [], []
    assert poa_weeks._page_rows(page) is None


async def test_stored_poas_are_corrected_once_and_plan_rows_move_in_place_keeping_edits(db, make_program, make_user, monkeypatch):
    await make_program("t1")
    wrong = poa(  # what the model read: the label only on the row it is printed on, and the rows after it
        ("", "Partner", "Spotlight Banner", "2026-11-12"),
        ("", "Email", "Email Batch 1", "2026-11-13"),
        ("Week 1", "Newsletter", "Newsletter Feature 1", "2026-11-15"),
        ("Week 1", "Email", "Email Batch 2", "2026-11-17"),
    )
    async with db() as session:
        session.add(ProgramDocument(
            ticket_id="t1", kind="poa", hubspot_property="marketing_poa_upload", hubspot_file_id="1",
            file_name="poa.pdf", mime_type="application/pdf", size_bytes=1, content=b"pdf", status="ok", details=wrong,
        ))
        await session.commit()
    await seed(db, wrong)
    editor = await make_user("csm@example.com", [Role.CSM])
    async with db() as session:
        banner = await session.scalar(select(ProgramActivity).where(ProgramActivity.title == "Spotlight Banner"))
        banner.utm, banner.updated_by = "he_mark/banner", editor.user_id  # someone worked on this row
        await session.commit()
    before = {a.title: a.id for a in await rows(db)}
    monkeypatch.setattr(poa_weeks, "row_weeks", lambda pdf: [
        ("12 Nov 2026", "Week 1"), ("13 Nov 2026", "Week 1"), ("15 Nov 2026", "Week 1"), ("17 Nov 2026", "Week 2"),
    ])

    assert await documents.fix_stored_poa_weeks() == 1
    assert await documents.fix_stored_poa_weeks() == 0  # each POA once

    after = await rows(db)
    assert {a.title: a.week for a in after} == {"Spotlight Banner": 1, "Email Batch 1": 1, "Newsletter Feature 1": 1, "Email Batch 2": 2}
    assert {a.title: a.id for a in after} == before  # the same rows, moved: nothing deleted and re-added
    banner = next(a for a in after if a.title == "Spotlight Banner")
    assert banner.utm == "he_mark/banner" and not banner.not_in_poa
    async with db() as session:
        details = (await session.get(ProgramDocument, ("t1", "poa"))).details
    assert [a["week"] for a in details["activities"]] == ["Week 1", "Week 1", "Week 1", "Week 2"] and details["_weeks"] == documents.WEEK_CELLS


async def test_an_edited_original_flagged_as_gone_is_kept_and_its_untouched_twin_removed(db, make_program, make_user, monkeypatch):
    """What an earlier misreading of the weeks left behind: the original Week 1 row, approved and edited, flagged
    "not in POA", and an untouched twin with no week added in its place. The correction must not trip over the
    original's key (it used to fail the whole sync) and must end with one row: the original, no longer flagged."""
    await make_program("t1")
    right = poa(("Week 1", "Email", "Email Batch 1", "2026-06-30"), ("Week 1", "Partner", "Outreach 1", "2026-07-01"))
    wrong = poa(("", "Email", "Email Batch 1", "2026-06-30"), ("", "Partner", "Outreach 1", "2026-07-01"))
    await seed(db, right)
    editor = await make_user("csm@example.com", [Role.CSM])
    async with db() as session:
        original = await session.scalar(select(ProgramActivity).where(ProgramActivity.title == "Email Batch 1"))
        original.utm, original.updated_by = "5678", editor.user_id
        original_id = original.id
        session.add(ProgramDocument(
            ticket_id="t1", kind="poa", hubspot_property="marketing_poa_upload", hubspot_file_id="1",
            file_name="poa.pdf", mime_type="application/pdf", size_bytes=1, content=b"pdf", status="ok", details=wrong,
        ))
        await session.commit()
    await seed(db, wrong)  # the misreading: the edited row is flagged, the untouched one replaced, a twin added
    assert sorted((a.title, a.week or 0, a.not_in_poa) for a in await rows(db)) == [
        ("Email Batch 1", 0, False), ("Email Batch 1", 1, True), ("Outreach 1", 0, False),
    ]
    monkeypatch.setattr(poa_weeks, "row_weeks", lambda pdf: [("30 Jun 2026", "Week 1"), ("1 Jul 2026", "Week 1")])

    assert await documents.fix_stored_poa_weeks() == 1

    after = await rows(db)
    assert sorted((a.title, a.week, a.not_in_poa) for a in after) == [("Email Batch 1", 1, False), ("Outreach 1", 1, False)]
    kept = next(a for a in after if a.title == "Email Batch 1")
    assert kept.id == original_id and kept.utm == "5678"


async def test_one_plan_that_cant_be_corrected_doesnt_stop_the_rest(db, make_program, monkeypatch):
    for ticket in ("t1", "t2"):
        await make_program(ticket)
        async with db() as session:
            session.add(ProgramDocument(
                ticket_id=ticket, kind="poa", hubspot_property="marketing_poa_upload", hubspot_file_id="1",
                file_name="poa.pdf", mime_type="application/pdf", size_bytes=1, content=b"pdf", status="ok",
                details=poa(("", "Email", "Email Batch 1", "2026-06-30")),
            ))
            await session.commit()
    monkeypatch.setattr(poa_weeks, "row_weeks", lambda pdf: [("30 Jun 2026", "Week 1")])
    real = documents.activities.follow_week_changes

    async def fail_for_t1(session, ticket_id, old, new):
        if ticket_id == "t1":
            raise RuntimeError("boom")
        await real(session, ticket_id, old, new)

    monkeypatch.setattr(documents.activities, "follow_week_changes", fail_for_t1)
    await documents.fix_stored_poa_weeks()
    async with db() as session:
        done = {t: (await session.get(ProgramDocument, (t, "poa"))).details.get("_weeks") for t in ("t1", "t2")}
    assert done == {"t1": None, "t2": documents.WEEK_CELLS}  # t1 is left for the next sync, t2 is corrected
