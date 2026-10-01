"""Checks for the sync pipeline's failure-handling logic (no network/DB).
Run: python -m tests.test_etl"""

import asyncio

from hubspot_client import client as hs
from hubspot_client import pipeline
from hubspot_client.db_writer import chunk_rows, deletion_is_safe
from hubspot_client.documents import MAX_ATTEMPTS, needs_processing
from hubspot_client.models import ProgramTicket, _to_float


def test_chunking_stays_under_postgres_param_limit():
    rows = [{f"c{i}": 0 for i in range(50)} for _ in range(3000)]
    chunks = chunk_rows(rows)
    assert sum(len(c) for c in chunks) == 3000
    assert all(len(c) * 50 <= 65_535 for c in chunks) and len(chunks) > 1
    assert chunk_rows([]) == []


def test_delete_guard_blocks_mass_wipe_but_allows_small_tables():
    assert not deletion_is_safe(existing=100, to_delete=80)
    assert deletion_is_safe(existing=100, to_delete=10)
    assert deletion_is_safe(existing=6, to_delete=6)  # tiny table: clearing it is legitimate


def test_retry_backoff():
    assert [hs.retry_delay(i, None) for i in range(6)] == [1, 2, 4, 8, 16, 30]
    assert hs.retry_delay(0, "7") == 7 and hs.retry_delay(0, "9999") == 30


def test_document_retry_policy():
    assert needs_processing("1", None)
    assert needs_processing("2", ("1", "ok", 0))
    assert not needs_processing("1", ("1", "ok", 0))
    assert needs_processing("1", ("1", "failed", MAX_ATTEMPTS - 1))
    assert not needs_processing("1", ("1", "failed", MAX_ATTEMPTS))


def test_junk_deal_size_is_not_fatal():
    assert _to_float("abc") is None and _to_float("") is None and _to_float("12.5") == 12.5


def _ticket(i: int, modified_ms: int) -> dict:
    iso = f"2026-01-01T00:00:{modified_ms // 1000:02d}.{modified_ms % 1000:03d}Z"
    return {"id": str(i), "properties": {"hs_lastmodifieddate": iso}}


def test_search_windowing_continues_past_the_cap():
    """Simulate HubSpot's search cap with a tiny window: 10 tickets, 2 per page,
    restart after 4 -- every ticket must come back exactly once."""
    tickets = [_ticket(i, 1000 + i) for i in range(10)]  # ascending modified time

    async def fake_request(session, method, url, **kw):
        body = kw["json"]
        flt = body["filterGroups"][0]["filters"][0]
        since, op = int(flt["value"]), flt["operator"]
        ms = hs._modified_ms
        matching = [t for t in tickets if ms(t) > since or (op == "GTE" and ms(t) == since)]
        start = int(body.get("after", 0))
        page = matching[start : start + 2]
        nxt = start + 2 if start + 2 < len(matching) else None
        return {"results": page, "paging": {"next": {"after": str(nxt)}} if nxt else {}}

    orig_request, orig_window, orig_session = hs._request, hs._SEARCH_WINDOW, hs._session
    hs._request, hs._SEARCH_WINDOW = fake_request, 4

    class _NullSession:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False

    hs._session = lambda: _NullSession()
    try:
        async def collect():
            return [r["id"] async for r in hs.HubSpotClient().fetch_programs(0)]
        got = asyncio.run(collect())
    finally:
        hs._request, hs._SEARCH_WINDOW, hs._session = orig_request, orig_window, orig_session
    assert sorted(got, key=int) == [str(i) for i in range(10)], got


def test_one_malformed_ticket_is_skipped_not_fatal():
    good = {"id": "1", "properties": {"hs_pipeline_stage": "s"}}
    bad = {"id": "2", "properties": None}  # from_raw can't handle this

    class FakeClient:
        async def fetch_pipeline(self): return {"label": "p", "stages": {}}
        async def fetch_owners(self): return {}
        async def fetch_programs(self, since_ms):
            for raw in (good, bad):
                yield raw

    orig = pipeline.HubSpotClient
    pipeline.HubSpotClient = FakeClient
    try:
        programs, skipped = asyncio.run(pipeline.extract(0))
    finally:
        pipeline.HubSpotClient = orig
    assert [p.ticket_id for p in programs] == ["1"] and skipped == ["2"]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
