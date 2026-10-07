"""Minimal async Redash client (same API shape as Content-Pulse's): run a saved query
fresh with parameters, poll the job, return {"columns", "rows"}. Auth is one global
REDASH_API_KEY. Raises RedashError (message is user-safe) so callers can report it."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from core.config import settings


class RedashError(Exception):
    pass


async def run_query(query_id: str, parameters: dict[str, Any] | None = None,
                    poll_interval: float = 2, max_wait: float = 300, max_age: int = 0) -> dict[str, Any]:
    """Params use the query's parameter names, without the `p_` browser-URL prefix."""
    if not settings.REDASH_API_KEY:
        raise RedashError("Redash isn't configured (REDASH_API_KEY is not set).")
    try:
        async with httpx.AsyncClient(
            base_url=settings.REDASH_BASE_URL.rstrip("/"),
            headers={"Authorization": f"Key {settings.REDASH_API_KEY}"},
            timeout=httpx.Timeout(15.0, read=60.0),
        ) as c:
            r = await c.post(f"/api/queries/{query_id}/results",
                             json={"parameters": parameters or {}, "max_age": max_age})
            if r.status_code != 200:
                raise RedashError(f"Redash rejected query {query_id} ({r.status_code}): {r.text[:200]}")
            data = r.json()
            if "query_result" in data:
                result_id = data["query_result"]["id"]
            else:
                job_id, waited = data["job"]["id"], 0.0
                while True:
                    job = (await c.get(f"/api/jobs/{job_id}")).json()["job"]
                    if job["status"] == 3:  # success
                        result_id = job["query_result_id"]
                        break
                    if job["status"] == 4:  # failure
                        raise RedashError(f"Query {query_id} failed: {job.get('error', 'unknown error')}")
                    if waited >= max_wait:
                        raise RedashError(f"Query {query_id} timed out after {max_wait:.0f}s.")
                    await asyncio.sleep(poll_interval)
                    waited += poll_interval
            r = await c.get(f"/api/queries/{query_id}/results/{result_id}.json")
            r.raise_for_status()
            result = r.json()["query_result"]["data"]
            return {"columns": result.get("columns", []), "rows": result.get("rows", [])}
    except (httpx.HTTPError, KeyError, ValueError) as e:
        raise RedashError(f"Couldn't reach Redash (VPN?): {e.__class__.__name__}") from e
