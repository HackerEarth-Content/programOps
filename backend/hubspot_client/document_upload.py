"""Replace a program's SOW or marketing POA from the portal.

Order matters and is deliberate:
  1. validate the file and the comment (nothing is touched on a bad request);
  2. read the PDF with the model FIRST -- a file that can't be read never reaches HubSpot, and the current
     document, its details and the plan stay exactly as they were (the attempt is logged);
  3. upload the file to HubSpot and point the ticket's property at it (so HubSpot shows the new file);
  4. in ONE database transaction: swap the stored document, follow the new POA in the plan, record the audit event (which is
     also the version history) and the note. A sync that raced us can't overwrite or delete the result (`lock_document`).
"""

from __future__ import annotations

import re
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import PurePath

import aiohttp
import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from core import activities, audit, internal_programs
from core.config import settings
from core.errors import DomainError
from core.orm import Program, ProgramDocument, ProgramEvent, ProgramNote, User
from hubspot_client import documents
from hubspot_client.client import HubSpotClient

logger = structlog.get_logger(__name__)

MAX_BYTES = 20 * 1024 * 1024
MIN_COMMENT = 10
MAX_COMMENT = 1000
_LABEL = {"sow": "SOW", "poa": "Marketing POA"}


def check_request(content: bytes, comment: str) -> str:
    """Refuse a bad file or a missing comment; return the trimmed comment."""
    comment = comment.strip()
    if len(comment) < MIN_COMMENT:
        raise DomainError("comment_required", f"Say why it's being replaced (at least {MIN_COMMENT} characters).", 422)
    if len(comment) > MAX_COMMENT:
        raise DomainError("comment_too_long", f"The comment can be at most {MAX_COMMENT} characters.", 422)
    if not content:
        raise DomainError("invalid_file", "The file is empty.", 422)
    if len(content) > MAX_BYTES:
        raise DomainError("file_too_large", f"The file is over {MAX_BYTES // (1024 * 1024)} MB.", 413)
    if not content.startswith(b"%PDF-"):
        raise DomainError("invalid_file", "Only PDF files can be uploaded.", 422)
    return comment


def safe_name(filename: str | None, kind: str) -> str:
    """A display-safe .pdf name: no path parts, no odd characters."""
    stem = PurePath((filename or "").replace("\\", "/")).stem
    stem = re.sub(r"[^\w.\- ]+", "_", stem).strip(" .")[:80] or kind
    return f"{stem}.pdf"


def version_out(e: ProgramEvent) -> dict:
    """One history entry, read from the audit trail: an app upload, a rejected upload, or a file the sync picked up."""
    new = e.new or {}
    failed = e.action == "document_reupload_refused" or new.get("status") == "failed"
    return {
        "id": e.id, "kind": e.entity_id, "status": "failed" if failed else "ok",
        "source": "hubspot" if e.action == "document_synced" else "app", "file_name": new.get("file"),
        "size_bytes": new.get("size_bytes"), "comment": new.get("comment"),
        "error": new.get("error") or (new.get("code") if failed else None),
        "uploaded_by_name": e.actor_name if e.action != "document_synced" else None, "created_at": e.at,
    }


async def _refuse(
    session: AsyncSession, actor: User, ticket_id: str, kind: str, file_name: str, size: int, comment: str,
    error: DomainError, *, file_id: str | None = None,
) -> None:
    """An upload that was asked for but not applied: kept in the history and the audit trail, current document untouched."""
    logger.warning("document_upload_refused", ticket_id=ticket_id, kind=kind, user=actor.email, code=error.code)
    audit.record(
        session, actor, entity="document", entity_id=kind, ticket_id=ticket_id, action="document_reupload_refused",
        new={"code": error.code, "error": error.detail[:500], "file": file_name, "size_bytes": size, "comment": comment, "file_id": file_id},
    )
    await session.commit()


async def replace_document(
    session: AsyncSession, actor: User, program: Program, kind: str, filename: str | None, content: bytes, comment: str
) -> dict:
    ticket_id, prop = program.ticket_id, documents.DOCUMENT_PROPERTIES[kind]
    if internal_programs.is_local_only(program):
        raise DomainError("internal_program", "An internal hackathon without a HubSpot ticket has no place to keep a SOW or POA.", 409)
    if not settings.HUBSPOT_WRITEBACK_ENABLED:
        raise DomainError("hubspot_writeback_disabled", "Changing HubSpot from the portal isn't switched on yet.", 503)
    comment = check_request(content, comment)
    name = safe_name(filename, kind)
    actor_name = actor.name or actor.email

    # 2. read it first
    try:
        details = await documents.parse_document(kind, content)
    except Exception as e:  # the model call, schema validation, or the API: whatever it is, nothing has changed yet
        logger.warning("document_upload_unreadable", ticket_id=ticket_id, kind=kind, error=str(e)[:300])
        error = DomainError(
            "extraction_failed",
            f"The {_LABEL[kind]} couldn't be read, so nothing was changed. Check that it is the right, text-based PDF and try again.",
            422,
        )
        await _refuse(session, actor, ticket_id, kind, name, len(content), comment, error)
        raise error from e

    # 3. HubSpot: the file, then the ticket property
    client = HubSpotClient()
    hubspot_name = f"{ticket_id}-{kind}-{datetime.now(timezone.utc):%Y%m%d%H%M%S}-{name}"
    file_id: str | None = None
    try:
        file_id = str((await client.upload_file(hubspot_name, content))["id"])
        await client.update_ticket_properties(ticket_id, {prop: file_id})
    except aiohttp.ClientResponseError as e:
        scope = e.status in (401, 403)
        error = DomainError(
            "hubspot_scope_missing" if scope else "hubspot_unavailable",
            "The HubSpot token isn't allowed to upload files or update tickets." if scope else f"HubSpot refused the upload ({e.status}).",
            502,
        )
        await _refuse(session, actor, ticket_id, kind, name, len(content), comment, error, file_id=file_id)
        raise error from e
    except (aiohttp.ClientError, TimeoutError) as e:
        error = DomainError("hubspot_unavailable", f"Couldn't reach HubSpot: {e}", 502)
        await _refuse(session, actor, ticket_id, kind, name, len(content), comment, error, file_id=file_id)
        raise error from e

    note_body = f"{_LABEL[kind]} replaced in ProgramOps by {actor_name}. File: {name}. Comment: {comment}"
    try:
        hubspot_note_id: str | None = await client.create_note(ticket_id, note_body)
    except Exception:  # the file is already in place; a missing timeline note must not undo it
        logger.warning("document_note_failed", ticket_id=ticket_id, kind=kind, exc_info=True)
        hubspot_note_id = None

    # 4. one transaction
    now = datetime.now(timezone.utc)
    await documents.lock_document(session, ticket_id, kind)
    document = await session.get(ProgramDocument, (ticket_id, kind), populate_existing=True)
    old = {"file": document.file_name, "file_id": document.hubspot_file_id} if document else None
    fields = {
        "hubspot_property": prop, "hubspot_file_id": file_id, "file_name": name, "mime_type": "application/pdf",
        "size_bytes": len(content), "content": content, "uploaded_at": now, "status": "ok", "error": None,
        "attempts": 0, "details": details, "extracted_at": now,
    }
    if document is None:
        session.add(ProgramDocument(ticket_id=ticket_id, kind=kind, **fields))
    else:
        for field, value in fields.items():
            setattr(document, field, value)
    program.raw_properties = {**(program.raw_properties or {}), prop: file_id}  # so the next sync agrees with HubSpot

    plan = await activities.seed_from_poa(session, ticket_id, details) if kind == "poa" else None
    plan_summary = asdict(plan) if plan else None
    event = audit.record(
        session, actor, entity="document", entity_id=kind, ticket_id=ticket_id, action="document_reuploaded",
        old=old, new={"file": name, "file_id": file_id, "size_bytes": len(content), "comment": comment, "status": "ok", "plan": plan_summary},
    )
    await session.merge(
        ProgramNote(
            note_id=hubspot_note_id or f"local-{uuid.uuid4()}", ticket_id=ticket_id, body=note_body,
            author_name=actor_name, author_id=actor.id, kind="note",
            source="hubspot" if hubspot_note_id else "programops", created_at=now,
        )
    )
    await session.commit()
    await session.refresh(event)

    if kind == "sow":  # the SOW fee sets the deal value; it heals on the next sync too, so never fail the upload over it
        try:
            await documents.apply_sow_deal_value(ticket_id)
        except Exception:
            logger.warning("document_deal_value_failed", ticket_id=ticket_id, exc_info=True)

    return {"version": version_out(event), "plan": plan_summary, "hubspot_note": hubspot_note_id is not None}
