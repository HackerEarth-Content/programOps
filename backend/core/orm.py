"""SQLAlchemy ORM models. Schema changes are managed via Alembic migrations --
this module only declares the mapped classes, it never creates or alters tables.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any
from uuid import uuid4

from fastapi_users.db import SQLAlchemyBaseOAuthAccountTable, SQLAlchemyBaseUserTable
from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Index, LargeBinary, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column, relationship, synonym


class Base(DeclarativeBase):
    # Every datetime column is timezone-aware (timestamptz) -- naive columns
    # silently shift if the server or session timezone is ever not UTC.
    type_annotation_map = {datetime: DateTime(timezone=True)}


class Program(Base):
    """A HubSpot ticket in the Programs Feasibility Support pipeline
    (id 934067746), normalized for program/campaign KPIs."""

    __tablename__ = "programs"
    __table_args__ = (
        # Dashboard aggregates group/filter on these.
        Index("ix_programs_stage_label", "stage_label"),
        Index("ix_programs_campaign_type", "campaign_type"),
    )

    ticket_id: Mapped[str] = mapped_column(primary_key=True)
    subject: Mapped[str] = mapped_column(default="")

    pipeline_id: Mapped[str]
    pipeline_label: Mapped[str]
    stage_id: Mapped[str]
    stage_label: Mapped[str]

    campaign_type: Mapped[str | None]
    campaign_name: Mapped[str | None]
    # event_name is a fixed-option dropdown (named hackathon/hiring challenge),
    # other_event_name is the paired free-text fallback for its "others" option.
    event_name: Mapped[str | None]
    other_event_name: Mapped[str | None]
    platform_details: Mapped[str | None]
    event_id: Mapped[str | None]
    registration_start_date: Mapped[date | None] = mapped_column(Date)
    event_end_date: Mapped[date | None] = mapped_column(Date)
    target_audience: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    geography: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)

    blackops_account_name: Mapped[str | None]
    company_name: Mapped[str | None]
    deal_id: Mapped[str | None]
    # account_manager/csm_for_the_deal/content_poc are all HubSpot owner-
    # reference properties (referencedObjectType: OWNER, verified live
    # 2026-09-25) -- the ticket stores a raw owner id, so each is resolved
    # through the owners lookup into a *_name alongside the id, same as
    # owner_id/owner_name below.
    account_manager_id: Mapped[str | None]
    account_manager_name: Mapped[str | None]
    csm_id: Mapped[str | None]
    csm_name: Mapped[str | None]
    content_poc_id: Mapped[str | None]
    content_poc_name: Mapped[str | None]
    internal_team: Mapped[str | None]
    expected_deal_size: Mapped[float | None]
    # Where expected_deal_size came from: "sow" | "description" | "hubspot".
    deal_size_source: Mapped[str | None]

    # Per-stage checklists (HubSpot multi-checkbox properties, semicolon-joined
    # on read) -- see hubspot_client/stage_checklist.py for the full stage ->
    # checklist-item mapping and which items are still pending.
    pre_sales_status: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    onboarding_status: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    ongoing_status: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    post_campaign_status: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    # checklist item label -> its paired free-text note field, non-empty only.
    stage_notes: Mapped[dict[str, str]] = mapped_column(JSONB, default=dict)

    owner_id: Mapped[str | None]
    owner_name: Mapped[str | None]
    ticket_validity: Mapped[str | None]
    final_resolution: Mapped[str | None]

    created_at: Mapped[datetime | None] = mapped_column(index=True)
    closed_at: Mapped[datetime | None]
    last_modified_at: Mapped[datetime | None] = mapped_column(index=True)

    # Provenance -- who/what created or last touched this record in HubSpot,
    # and how it originated (form submission, CRM UI, integration, import).
    created_by_user_id: Mapped[int | None]
    updated_by_user_id: Mapped[int | None]
    record_source: Mapped[str | None]
    record_source_detail: Mapped[str | None]

    num_notes: Mapped[int | None]
    notes_last_updated: Mapped[datetime | None]

    # Full raw HubSpot properties payload from the most recent sync -- a
    # forward-compatible safety net so a property we haven't modeled as its
    # own column yet is never silently dropped.
    raw_properties: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )

    # Our own bookkeeping, separate from HubSpot's own timestamps -- lets a
    # stalled/broken sync be detected (a program HubSpot keeps updating but
    # last_synced_at stops advancing). server_default backfills existing rows
    # on migration; the sync always overwrites both explicitly afterwards.
    first_synced_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    last_synced_at: Mapped[datetime] = mapped_column(server_default=text("now()"))

    # stage_key -> {entered_at, exited_at, cumulative_hours}, see
    # hubspot_client.stage_checklist.PROGRAM_STAGES.
    stage_timings: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class ProgramStageHistory(Base):
    """Append-only audit log of every stage/checklist property change on a
    program, sourced from HubSpot's own property-history API -- not
    reconstructed or inferred. Answers "when did this move, who moved it, and
    how" (CRM_UI/API/INTEGRATION/WORKFLOW/MIGRATION)."""

    __tablename__ = "program_stage_history"
    __table_args__ = (
        UniqueConstraint(
            "ticket_id", "property_name", "changed_at", name="uq_program_stage_history"
        ),
        # The audit trail reads one program's changes newest-first.
        Index("ix_program_stage_history_ticket_changed", "ticket_id", "changed_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("programs.ticket_id", ondelete="CASCADE"), index=True
    )
    property_name: Mapped[str]
    old_value: Mapped[str | None]
    new_value: Mapped[str | None]
    changed_at: Mapped[datetime]
    source_type: Mapped[str | None]
    changed_by_user_id: Mapped[int | None]


class ProgramNote(Base):
    """A comment on a program -- either a HubSpot Notes engagement mirrored
    in by the sync (source="hubspot", keyed by HubSpot's own note id so
    re-syncing never duplicates it), or a note written directly in ProgramOps
    (source="programops", note_id is a locally-generated "local-<uuid4>" so
    it can never collide with a real HubSpot note id)."""

    __tablename__ = "program_notes"
    __table_args__ = (Index("ix_program_notes_ticket_created", "ticket_id", "created_at"),)

    note_id: Mapped[str] = mapped_column(primary_key=True)
    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("programs.ticket_id", ondelete="CASCADE"), index=True
    )
    body: Mapped[str]
    author_user_id: Mapped[int | None]
    # Only set for source="programops" -- there's no login system yet, so an
    # app-authored note is attributed by free-text name, not a real user id.
    author_name: Mapped[str | None]
    source: Mapped[str] = mapped_column(server_default=text("'hubspot'"))
    created_at: Mapped[datetime]


class ProgramDocument(Base):
    """The SOW / marketing POA file uploaded to a HubSpot ticket, downloaded
    and kept in the database, plus the schema-validated details extracted from it.
    kind is "sow" or "poa"; one row per (ticket, kind)."""

    __tablename__ = "program_documents"

    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("programs.ticket_id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(primary_key=True)
    hubspot_property: Mapped[str]
    hubspot_file_id: Mapped[str]
    file_name: Mapped[str]
    mime_type: Mapped[str]
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    # The file itself lives in the database (small PDFs) so it survives
    # redeploys and works with more than one API instance.
    content: Mapped[bytes] = mapped_column(LargeBinary)
    uploaded_at: Mapped[datetime | None]
    # "ok" | "failed" -- failed keeps the file downloadable, details stay null.
    status: Mapped[str]
    error: Mapped[str | None]
    # Failed extractions are retried on later syncs, up to a limit.
    attempts: Mapped[int] = mapped_column(server_default=text("0"))
    details: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    extracted_at: Mapped[datetime | None]


class SyncCursor(Base):
    """Tracks the last successful incremental-sync timestamp per data source."""

    __tablename__ = "sync_cursors"

    key: Mapped[str] = mapped_column(primary_key=True)
    last_synced_at: Mapped[datetime]


# Valid User.role values -- captured once at first login (see
# api/auth_routes.py), since Google OAuth itself carries no notion of role.
USER_ROLES = ("account_manager", "csm", "manager", "other")


class OAuthAccount(SQLAlchemyBaseOAuthAccountTable[str], Base):
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))

    @declared_attr
    def user_id(cls) -> Mapped[str]:
        return mapped_column(
            String, ForeignKey("user.user_id", ondelete="CASCADE"), nullable=False
        )


class User(SQLAlchemyBaseUserTable[str], Base):
    __tablename__ = "user"

    id: Mapped[str] = mapped_column(
        "user_id", String, primary_key=True, default=lambda: str(uuid4())
    )
    name: Mapped[str | None]
    # None until the user picks one on first login -- see the frontend's
    # role-selection gate, which blocks the rest of the app until this is set.
    role: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))

    # fastapi-users' SQLAlchemyUserDatabase expects the PK attribute to be
    # named `id`; the "user_id" column name above is just for readability.
    user_id = synonym("id")

    oauth_accounts: Mapped[list[OAuthAccount]] = relationship(
        "OAuthAccount", lazy="joined", cascade="all, delete-orphan"
    )


class ProgramRegistrationSettings(Base):
    """Per-program registration tracking config + Slack notification target.
    One row per program, created on first save."""

    __tablename__ = "program_registration_settings"

    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("programs.ticket_id", ondelete="CASCADE"), primary_key=True
    )
    roles: Mapped[list[str]] = mapped_column(ARRAY(String), default=list, server_default=text("'{}'"))
    fields: Mapped[list[str]] = mapped_column(ARRAY(String), default=list, server_default=text("'{}'"))
    slack_channel_id: Mapped[str | None]
    slack_channel_name: Mapped[str | None]  # cached from conversations.info at save time
    notify_slack: Mapped[bool] = mapped_column(default=True, server_default=text("true"))
    # Auto mode: counts come from the Redash registrations query for this event slug.
    redash_auto: Mapped[bool] = mapped_column(default=False, server_default=text("false"))
    redash_event_slug: Mapped[str | None]
    redash_event_title: Mapped[str | None]  # confirmed event name, shown in auto mode
    redash_event_start: Mapped[date | None] = mapped_column(Date)  # event window, from Redash;
    redash_event_end: Mapped[date | None] = mapped_column(Date)  # anchors the estimated timeline


class ProgramRegistration(Base):
    """One day's registration count (per role for hiring programs; role = ''
    otherwise, so (ticket, date, role) is always a usable natural key)."""

    __tablename__ = "program_registrations"
    __table_args__ = (
        UniqueConstraint("ticket_id", "date", "role", name="uq_program_registrations"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[str] = mapped_column(
        ForeignKey("programs.ticket_id", ondelete="CASCADE"), index=True
    )
    date: Mapped[date] = mapped_column(Date)
    role: Mapped[str] = mapped_column(default="", server_default="")
    registrations: Mapped[int]
    # NULL = unknown (Redash gives registrations only); manual entries always set it.
    relevant: Mapped[int | None]
    extra: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
