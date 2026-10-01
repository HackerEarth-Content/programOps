"""Async HubSpot API client for the Programs Feasibility Support pipeline
(id 934067746, see core.config.settings.PROGRAM_PIPELINE_ID).

Every call goes through _request: timeouts, and retries with backoff on
429/5xx and connection errors. Ticket searches page past HubSpot's 10,000-
result search cap by restarting the search from the last modified-time seen.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Any, AsyncIterator

import aiohttp

from core.config import settings
from hubspot_client.stage_checklist import (
    CHECKLIST_PROPERTIES,
    PROGRAM_STAGES,
    STAGE_CHECKLISTS,
)

logger = logging.getLogger(__name__)


_BASE = "https://api.hubapi.com"

TICKET_PROPERTIES = [
    "subject",
    "hs_pipeline",
    "hs_pipeline_stage",
    "campaign_type",
    "campaign_name",
    "program_name",  # preferred over the event_name dropdown as the event name
    "event_name",
    "other_event_name",
    "platform_details",
    "other_platform_details",
    "event_id",
    "registration_start_date",
    "event_end_date_skip_if_undefined",
    "target_audience",
    "geography_if_its_a_specific_city_or_split_please_specify_in_other",
    "blackops_account_name",
    "company_name",
    "deal_id",
    "csm_for_the_deal",
    "account_manager",
    "content_poc",
    "internal_team",
    "expected_deal_size_eg_inr_xxx_in_case_its_not_clear_give_us_the_lowest_number_that_he_will_target",
    "hubspot_owner_id",
    "content",  # ticket description -- carries the intake form (client, deal size)
    "sow_upload",
    "marketing_poa_upload",
    "ticket_validity",
    "final_resolution",
    "createdate",
    "closed_date",
    "hs_lastmodifieddate",
    # Provenance -- who created/last touched the record, and how it originated.
    "hs_created_by_user_id",
    "hs_updated_by_user_id",
    "hs_object_source",
    "hs_object_source_detail_1",
    "num_notes",
    "notes_last_updated",
] + CHECKLIST_PROPERTIES + [
    f"hs_v2_{event}_{stage['stage_id']}"
    for stage in PROGRAM_STAGES.values()
    for event in ("date_entered", "date_exited", "cumulative_time_in")
]

# Properties whose full change history we track in program_stage_history --
# the pipeline stage itself plus every per-stage checklist.
HISTORY_PROPERTIES = ["hs_pipeline_stage"] + [
    checklist_prop for checklist_prop, _ in STAGE_CHECKLISTS.values()
]


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.HUBSPOT_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


_TIMEOUT = aiohttp.ClientTimeout(total=60)
_RETRY_STATUSES = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 5
# HubSpot's search API refuses to page past 10,000 results; restart before that.
_SEARCH_WINDOW = 9_800


def retry_delay(attempt: int, retry_after: str | None) -> float:
    """Seconds to wait before retry number `attempt` (0-based): honours the
    server's Retry-After, else exponential 1, 2, 4, 8s -- capped at 30s."""
    if retry_after:
        try:
            return min(float(retry_after), 30.0)
        except ValueError:
            pass
    return min(2.0**attempt, 30.0)


async def _request(
    session: aiohttp.ClientSession, method: str, url: str, *, raw: bool = False, **kwargs: Any
) -> Any:
    """One HTTP call returning parsed JSON (bytes when raw=True). Retries
    rate limits, 5xx and connection errors; any other HTTP error raises."""
    for attempt in range(_MAX_ATTEMPTS):
        last = attempt == _MAX_ATTEMPTS - 1
        try:
            async with session.request(method, url, **kwargs) as resp:
                if resp.status in _RETRY_STATUSES and not last:
                    delay = retry_delay(attempt, resp.headers.get("Retry-After"))
                    logger.warning("HubSpot %s -> %s, retrying in %.0fs", url, resp.status, delay)
                    await asyncio.sleep(delay)
                    continue
                resp.raise_for_status()
                return await resp.read() if raw else await resp.json()
        except (aiohttp.ClientConnectionError, asyncio.TimeoutError):
            if last:
                raise
            await asyncio.sleep(retry_delay(attempt, None))
    raise AssertionError("unreachable")


def _session() -> aiohttp.ClientSession:
    return aiohttp.ClientSession(headers=_headers(), timeout=_TIMEOUT)


def _modified_ms(raw: dict) -> int:
    iso = raw["properties"]["hs_lastmodifieddate"]
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


class HubSpotClient:
    async def fetch_pipeline(self) -> dict:
        """Returns {label, stages: {stage_id: label}} for
        settings.PROGRAM_PIPELINE_ID."""
        url = f"{_BASE}/crm/v3/pipelines/tickets/{settings.PROGRAM_PIPELINE_ID}"
        async with _session() as session:
            data = await _request(session, "GET", url)
        stages = {s["id"]: s["label"] for s in data.get("stages", [])}
        return {"label": data["label"], "stages": stages}

    async def _owner_records(self) -> list[dict]:
        """All HubSpot owner records. Best-effort: [] rather than failing the
        whole run if the token lacks the owners-read scope or HubSpot is
        unreachable."""
        url = f"{_BASE}/crm/v3/owners"
        records: list[dict] = []
        try:
            async with _session() as session:
                # Active owners, then deactivated ones -- a ticket can still
                # reference a user who has since left the HubSpot account.
                for archived in ("false", "true"):
                    after: str | None = None
                    while True:
                        params: dict[str, str | int] = {"limit": 100, "archived": archived}
                        if after:
                            params["after"] = after
                        data = await _request(session, "GET", url, params=params)
                        records.extend(data.get("results", []))
                        after = data.get("paging", {}).get("next", {}).get("after")
                        if not after:
                            break
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            logger.warning("Owners lookup unavailable (%s)", e)
            return []
        return records

    @staticmethod
    def _owner_name(o: dict) -> str:
        name = f"{o.get('firstName') or ''} {o.get('lastName') or ''}".strip()
        return name or o.get("email") or o["id"]

    async def fetch_owners(self) -> dict[str, str]:
        """Returns {owner_id: full_name}."""
        return {o["id"]: self._owner_name(o) for o in await self._owner_records()}

    async def fetch_user_names(self) -> dict[int, str]:
        """Returns {hubspot_user_id: full_name}. Audit-trail/note authors are
        HubSpot *user* ids, which owner records expose as `userId`."""
        return {
            uid: self._owner_name(o)
            for o in await self._owner_records()
            for uid in (o.get("userId"), o.get("userIdIncludingInactive"))
            if uid is not None
        }

    async def fetch_file(self, file_id: str) -> tuple[dict, bytes]:
        """Returns (metadata, content) for a HubSpot Files API file. Needs the
        files.ui_hidden.read scope -- CRM file properties live in a hidden
        folder."""
        async with _session() as session:
            meta = await _request(session, "GET", f"{_BASE}/files/v3/files/{file_id}")
            signed = await _request(session, "GET", f"{_BASE}/files/v3/files/{file_id}/signed-url")
        # The signed URL is pre-authorized -- no bearer token for the CDN.
        async with aiohttp.ClientSession(timeout=_TIMEOUT) as cdn:
            return meta, await _request(cdn, "GET", signed["url"], raw=True)

    async def fetch_programs(self, since_ms: int) -> AsyncIterator[dict]:
        """Yield raw ticket dicts modified since `since_ms`, from the Programs
        Feasibility Support pipeline only, oldest-modified first."""
        url = f"{_BASE}/crm/v3/objects/tickets/search"
        seen: set[str] = set()
        operator = "GT"
        async with _session() as session:
            while True:
                body: dict = {
                    "filterGroups": [
                        {
                            "filters": [
                                {
                                    "propertyName": "hs_lastmodifieddate",
                                    "operator": operator,
                                    "value": str(since_ms),
                                },
                                {
                                    "propertyName": "hs_pipeline",
                                    "operator": "EQ",
                                    "value": settings.PROGRAM_PIPELINE_ID,
                                },
                            ]
                        }
                    ],
                    "properties": TICKET_PROPERTIES,
                    "limit": settings.PROGRAM_PAGE_SIZE,
                    "sorts": [{"propertyName": "hs_lastmodifieddate", "direction": "ASCENDING"}],
                }
                fetched, last_ms, after = 0, since_ms, None
                while True:
                    if after:
                        body["after"] = after
                    data = await _request(session, "POST", url, json=body)
                    for raw in data.get("results", []):
                        fetched += 1
                        last_ms = _modified_ms(raw)
                        if raw["id"] not in seen:
                            seen.add(raw["id"])
                            yield raw
                    after = data.get("paging", {}).get("next", {}).get("after")
                    if not after or fetched >= _SEARCH_WINDOW:
                        break
                if not after:
                    return
                # Hit the search cap: continue from the last modified time seen
                # (GTE, so tickets sharing that millisecond aren't dropped;
                # `seen` dedupes the overlap).
                if last_ms == since_ms and operator == "GTE":
                    logger.error("Search window made no progress at %s -- stopping", since_ms)
                    return
                since_ms, operator = last_ms, "GTE"

    async def fetch_pipeline_ticket_ids(self) -> set[str]:
        """Every ticket id currently in the pipeline (used to detect tickets
        deleted or moved out in HubSpot). Pages by id, so no result cap."""
        url = f"{_BASE}/crm/v3/objects/tickets/search"
        ids: set[str] = set()
        last_id = 0
        async with _session() as session:
            while True:
                body = {
                    "filterGroups": [
                        {
                            "filters": [
                                {"propertyName": "hs_object_id", "operator": "GT", "value": str(last_id)},
                                {
                                    "propertyName": "hs_pipeline",
                                    "operator": "EQ",
                                    "value": settings.PROGRAM_PIPELINE_ID,
                                },
                            ]
                        }
                    ],
                    "properties": ["hs_object_id"],
                    "limit": 200,
                    "sorts": [{"propertyName": "hs_object_id", "direction": "ASCENDING"}],
                }
                results = (await _request(session, "POST", url, json=body)).get("results", [])
                if not results:
                    return ids
                ids.update(r["id"] for r in results)
                last_id = int(results[-1]["id"])

    async def fetch_property_history(self, ticket_ids: list[str]) -> dict[str, dict]:
        """ticket_id -> {property_name: [{value, timestamp, sourceType,
        updatedByUserId}, ...]}, HubSpot's own immutable property-change log
        for HISTORY_PROPERTIES -- source of truth for program_stage_history,
        not something we reconstruct ourselves."""
        if not ticket_ids:
            return {}
        url = f"{_BASE}/crm/v3/objects/tickets/batch/read"
        history: dict[str, dict] = {}
        async with _session() as session:
            for i in range(0, len(ticket_ids), 100):
                body = {
                    "inputs": [{"id": tid} for tid in ticket_ids[i : i + 100]],
                    "propertiesWithHistory": HISTORY_PROPERTIES,
                }
                data = await _request(session, "POST", url, json=body)
                for r in data.get("results", []):
                    history[r["id"]] = r.get("propertiesWithHistory", {})
        return history

    async def fetch_notes(self, ticket_ids: list[str]) -> dict[str, list[dict]]:
        """ticket_id -> [raw note dict, ...] -- the Notes engagements
        associated with each program, i.e. the free-text "why"/comment a rep
        leaves (e.g. explaining a stage move)."""
        if not ticket_ids:
            return {}
        assoc_url = f"{_BASE}/crm/v4/associations/tickets/notes/batch/read"
        note_ids_by_ticket: dict[str, list[str]] = {}
        async with _session() as session:
            for i in range(0, len(ticket_ids), 100):
                body = {"inputs": [{"id": tid} for tid in ticket_ids[i : i + 100]]}
                data = await _request(session, "POST", assoc_url, json=body)
                # Tickets with zero notes come back as entries in `errors`
                # (NO_ASSOCIATIONS_FOUND), not `results` -- expected, not a
                # failure, so they're simply absent from note_ids_by_ticket.
                for r in data.get("results", []):
                    note_ids_by_ticket[r["from"]["id"]] = [
                        str(n["toObjectId"]) for n in r.get("to", [])
                    ]

            all_note_ids = list({nid for ids in note_ids_by_ticket.values() for nid in ids})
            if not all_note_ids:
                return {}

            notes_url = f"{_BASE}/crm/v3/objects/notes/batch/read"
            notes_by_id: dict[str, dict] = {}
            for i in range(0, len(all_note_ids), 100):
                body = {
                    "inputs": [{"id": nid} for nid in all_note_ids[i : i + 100]],
                    "properties": ["hs_note_body", "hs_timestamp", "hs_created_by"],
                }
                data = await _request(session, "POST", notes_url, json=body)
                for r in data.get("results", []):
                    notes_by_id[r["id"]] = r

        return {
            ticket_id: [notes_by_id[nid] for nid in note_ids if nid in notes_by_id]
            for ticket_id, note_ids in note_ids_by_ticket.items()
        }


_user_names_cache: tuple[float, dict[int, str]] = (0.0, {})


async def get_user_names() -> dict[int, str]:
    """fetch_user_names with a 10 minute cache, for per-request use. Never
    raises: on failure the last good names (or {}) are returned, so callers
    fall back to showing the raw id."""
    global _user_names_cache
    fetched_at, names = _user_names_cache
    if not names or time.monotonic() - fetched_at > 600:
        names = await HubSpotClient().fetch_user_names() or names
        _user_names_cache = (time.monotonic(), names)
    return names
