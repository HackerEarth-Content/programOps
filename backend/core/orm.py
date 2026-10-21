"""SQLAlchemy ORM models. Schema changes are managed via Alembic migrations --
this module only declares the mapped classes, it never creates or alters tables.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi_users.db import SQLAlchemyBaseOAuthAccountTable, SQLAlchemyBaseUserTable
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column, relationship, synonym

from core.permissions import Role


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
    csm_email: Mapped[str | None]  # the HubSpot owner's email, lower-case: how a signed-in CSM finds their programs
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

    @property
    def is_untitled(self) -> bool:
        """No program name on the ticket, and the subject is just HubSpot's auto-generated "New form submission …"."""
        return not (self.event_name or self.other_event_name) and bool(
            re.match(r"^\s*new form submission\b", self.subject or "", re.IGNORECASE)
        )

    @property
    def display_name(self) -> str:
        """The name shown everywhere: the program name, else the subject, else a clear "Untitled program (client)"."""
        if self.event_name or self.other_event_name:
            return self.event_name or self.other_event_name or ""
        if self.is_untitled:
            return f"Untitled program ({self.company_name or 'no client'})"
        return self.subject or self.ticket_id


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
    author_user_id: Mapped[int | None]  # HubSpot's user id, for source="hubspot"
    # For source="programops": the signed-in portal user who wrote it (never taken from the request body).
    author_name: Mapped[str | None]
    author_id: Mapped[str | None]
    # "note" (the original free note), "comment", or "update" (the CSM's daily update, which carries a health).
    kind: Mapped[str] = mapped_column(default="note", server_default=text("'note'"))
    health: Mapped[str | None]  # good | warning | critical, for kind="update"
    blockers: Mapped[str | None]
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
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))

    # fastapi-users' SQLAlchemyUserDatabase expects the PK attribute to be
    # named `id`; the "user_id" column name above is just for readability.
    user_id = synonym("id")

    oauth_accounts: Mapped[list[OAuthAccount]] = relationship(
        "OAuthAccount", lazy="joined", cascade="all, delete-orphan"
    )


class UserRoleAssignment(Base):
    """One row per role a user holds (a user may hold several, e.g. super admin + CSM)."""

    __tablename__ = "user_roles"
    __table_args__ = (
        CheckConstraint("role IN (" + ", ".join(f"'{r.value}'" for r in Role) + ")", name="ck_user_roles_role"),
    )

    user_id: Mapped[str] = mapped_column(ForeignKey("user.user_id", ondelete="CASCADE"), primary_key=True)
    role: Mapped[str] = mapped_column(primary_key=True)


class UserPermissionOverride(Base):
    """An individual grant (granted=True) or revoke (granted=False) on top of the user's role defaults."""

    __tablename__ = "user_permission_overrides"

    user_id: Mapped[str] = mapped_column(ForeignKey("user.user_id", ondelete="CASCADE"), primary_key=True)
    permission: Mapped[str] = mapped_column(primary_key=True)
    granted: Mapped[bool]
    set_by: Mapped[str | None]
    set_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Invite(Base):
    """Roles a super admin set for an email before that person first signs in. Applied once, on their first
    sign-in (instead of the default Viewer role). No link, no token."""

    __tablename__ = "invites"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'accepted', 'revoked')", name="ck_invites_status"),
        # At most one live invitation per email.
        Index("uq_invites_pending_email", "email", unique=True, postgresql_where=text("status = 'pending'")),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    email: Mapped[str]  # stored lower-case
    roles: Mapped[list[str]] = mapped_column(ARRAY(String))
    status: Mapped[str] = mapped_column(server_default=text("'pending'"))
    created_by: Mapped[str | None] = mapped_column(ForeignKey("user.user_id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    accepted_at: Mapped[datetime | None]
    accepted_user_id: Mapped[str | None] = mapped_column(ForeignKey("user.user_id", ondelete="SET NULL"))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ProgramActivity(Base):
    """One row of a program's marketing plan of action. Seeded from the extracted POA (source="poa",
    keyed by a stable `poa_key` so a re-read never duplicates or overwrites it) or added by hand
    (source="manual"). Approval is the CSM's and nothing goes live without it: the service checks it and a
    database trigger (see the migration) refuses a transition into 'live' without `approved_at`."""

    __tablename__ = "program_activities"
    __table_args__ = (
        UniqueConstraint("ticket_id", "code", name="uq_program_activities_code"),
        Index(
            "uq_program_activities_poa_key", "ticket_id", "poa_key", unique=True,
            postgresql_where=text("poa_key IS NOT NULL"),
        ),
        CheckConstraint("source IN ('poa', 'manual')", name="ck_program_activities_source"),
        CheckConstraint("status IN ('not_started', 'wip', 'live', 'off')", name="ck_program_activities_status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("programs.ticket_id", ondelete="CASCADE"), index=True)
    code: Mapped[str]  # display code, unique per program: W1-ACT-04, ADD-01
    poa_key: Mapped[str | None]
    source: Mapped[str]
    week: Mapped[int | None]
    channel: Mapped[str]
    title: Mapped[str]
    action: Mapped[str | None]
    audience: Mapped[str | None]
    outcome: Mapped[str | None]
    hook: Mapped[str | None]
    target_note: Mapped[str | None]
    planned_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(default="not_started", server_default=text("'not_started'"))
    approved_by: Mapped[str | None]
    approved_by_name: Mapped[str | None]  # copied at approval time, like the audit trail
    approved_at: Mapped[datetime | None]  # None = not approved yet
    go_live_at: Mapped[datetime | None]
    comes_off_at: Mapped[datetime | None]
    utm: Mapped[str | None]
    creative_proof_url: Mapped[str | None]
    tracker_ref: Mapped[str | None]
    updated_by: Mapped[str | None]  # None = nobody has edited this row since it was seeded
    updated_at: Mapped[datetime] = mapped_column(default=_utcnow)
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)


class ProgramEvent(Base):
    """Append-only audit trail of every change made in the portal (a database trigger refuses
    UPDATE and DELETE). No foreign keys on purpose: history must outlive a deleted program or user,
    and `actor_name` is copied at write time so it still reads correctly later."""

    __tablename__ = "program_events"
    __table_args__ = (
        Index("ix_program_events_ticket_at", "ticket_id", "id"),
        Index("ix_program_events_entity", "entity", "entity_id", "id"),
        Index("ix_program_events_actor", "actor_id", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str | None]  # None for portal-wide events such as user admin
    entity: Mapped[str]
    entity_id: Mapped[str]
    action: Mapped[str]
    field: Mapped[str | None]
    old: Mapped[Any] = mapped_column(JSONB(none_as_null=True), nullable=True)
    new: Mapped[Any] = mapped_column(JSONB(none_as_null=True), nullable=True)
    actor_id: Mapped[str | None]
    actor_name: Mapped[str]
    at: Mapped[datetime] = mapped_column(server_default=text("now()"))


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
    # CSM overrides: the registration target (else the SOW's) and the campaign window (else Redash/HubSpot).
    target: Mapped[int | None]
    campaign_start: Mapped[date | None] = mapped_column(Date)
    campaign_end: Mapped[date | None] = mapped_column(Date)


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


class RelevantRegistration(Base):
    """New relevant registrations for one day, entered by the CSM. Kept apart from the Redash totals and never
    added into them. Append-only: a correction is a new row that `supersedes` the old one."""

    __tablename__ = "relevant_registrations"
    __table_args__ = (
        CheckConstraint("count >= 0", name="ck_relevant_registrations_count"),
        CheckConstraint("source IN ('manual', 'auto')", name="ck_relevant_registrations_source"),
        Index("ix_relevant_registrations_ticket_date", "ticket_id", "date"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("programs.ticket_id", ondelete="CASCADE"))
    date: Mapped[date] = mapped_column(Date)
    count: Mapped[int]
    criteria: Mapped[str | None]  # what made these relevant, e.g. "Tier 1/2 full-stack"
    note: Mapped[str | None]
    source: Mapped[str] = mapped_column(default="manual", server_default=text("'manual'"))  # 'auto' for a later automation
    entered_by: Mapped[str | None]
    entered_by_name: Mapped[str]
    entered_at: Mapped[datetime] = mapped_column(default=_utcnow)
    supersedes_id: Mapped[int | None] = mapped_column(ForeignKey("relevant_registrations.id", ondelete="SET NULL"))


class ChannelSnapshot(Base):
    """One run of Redash query 6170 (registrations by source) for a program. A failed run is kept too,
    so the last good snapshot stays visible with the reason the refresh failed."""

    __tablename__ = "channel_snapshots"
    __table_args__ = (
        CheckConstraint("status IN ('ok', 'failed')", name="ck_channel_snapshots_status"),
        Index("ix_channel_snapshots_ticket", "ticket_id", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("programs.ticket_id", ondelete="CASCADE"))
    fetched_at: Mapped[datetime] = mapped_column(default=_utcnow)
    status: Mapped[str]
    error: Mapped[str | None]
    rows: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    total: Mapped[int | None]


class ProgramRound(Base):
    """One round of selection for a program (assessment, project, interview, onsite finale, custom). The CSM
    adds, renames, reorders and removes them, so any program shape fits. Each round gets a readiness checklist."""

    __tablename__ = "program_rounds"
    __table_args__ = (
        CheckConstraint("kind IN ('assessment', 'project', 'interview', 'onsite', 'custom')", name="ck_program_rounds_kind"),
        CheckConstraint("status IN ('planned', 'live', 'evaluating', 'done')", name="ck_program_rounds_status"),
        CheckConstraint("source IN ('sow', 'manual')", name="ck_program_rounds_source"),
        UniqueConstraint("ticket_id", "seq", name="uq_program_rounds_seq", deferrable=True, initially="DEFERRED"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("programs.ticket_id", ondelete="CASCADE"), index=True)
    seq: Mapped[int]
    name: Mapped[str]
    kind: Mapped[str] = mapped_column(default="assessment")
    starts_on: Mapped[date | None] = mapped_column(Date)
    ends_on: Mapped[date | None] = mapped_column(Date)
    cutoff_rule: Mapped[str | None]  # the shortlisting criterion in words
    cutoff_value: Mapped[float | None]
    status: Mapped[str] = mapped_column(default="planned", server_default=text("'planned'"))
    source: Mapped[str] = mapped_column(default="manual", server_default=text("'manual'"))
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)


class RoundCount(Base):
    """Counts for a round as of a date, entered by the CSM. Append-only: a correction supersedes the old row."""

    __tablename__ = "round_counts"
    __table_args__ = (
        CheckConstraint(
            "COALESCE(invited, 0) >= 0 AND COALESCE(attempted, 0) >= 0 AND COALESCE(submitted, 0) >= 0 "
            "AND COALESCE(cleared, 0) >= 0 AND COALESCE(shortlisted, 0) >= 0",
            name="ck_round_counts_non_negative",
        ),
        CheckConstraint("attempted IS NULL OR invited IS NULL OR attempted <= invited", name="ck_round_counts_attempted"),
        CheckConstraint("cleared IS NULL OR attempted IS NULL OR cleared <= attempted", name="ck_round_counts_cleared"),
        CheckConstraint("submitted IS NULL OR attempted IS NULL OR submitted <= attempted", name="ck_round_counts_submitted"),
        Index("ix_round_counts_round", "round_id", "as_of"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    round_id: Mapped[int] = mapped_column(ForeignKey("program_rounds.id", ondelete="CASCADE"))
    as_of: Mapped[date] = mapped_column(Date)
    invited: Mapped[int | None]
    attempted: Mapped[int | None]  # participation
    submitted: Mapped[int | None]  # for project-style rounds
    cleared: Mapped[int | None]  # cleared the cutoff
    shortlisted: Mapped[int | None]
    note: Mapped[str | None]
    entered_by: Mapped[str | None]
    entered_by_name: Mapped[str]
    entered_at: Mapped[datetime] = mapped_column(default=_utcnow)
    supersedes_id: Mapped[int | None] = mapped_column(ForeignKey("round_counts.id", ondelete="SET NULL"))


class ChecklistTemplate(Base):
    """A reusable checklist: a special-request type ('request'), a lifecycle phase gate ('phase') or an
    assessment readiness list ('readiness'). Editing it never changes checklists already created from it."""

    __tablename__ = "checklist_templates"
    __table_args__ = (
        CheckConstraint("kind IN ('request', 'phase', 'readiness')", name="ck_checklist_templates_kind"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(unique=True)
    name: Mapped[str]
    kind: Mapped[str]
    active: Mapped[bool] = mapped_column(default=True, server_default=text("true"))


class ChecklistTemplateItem(Base):
    __tablename__ = "checklist_template_items"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    template_id: Mapped[int] = mapped_column(ForeignKey("checklist_templates.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int]
    label: Mapped[str]
    instruction: Mapped[str] = mapped_column(default="", server_default=text("''"))
    required: Mapped[bool] = mapped_column(default=True, server_default=text("true"))
    needs_detail: Mapped[bool] = mapped_column(default=False, server_default=text("false"))  # "what exactly was confirmed"


class Checklist(Base):
    """A checklist on a program: a special request, a lifecycle phase gate or a round's readiness. Its items are
    a snapshot of the template when it was created. It becomes `ready` when every required item is confirmed."""

    __tablename__ = "checklists"
    __table_args__ = (
        CheckConstraint("kind IN ('request', 'phase', 'readiness')", name="ck_checklists_kind"),
        CheckConstraint("status IN ('open', 'in_progress', 'ready', 'done', 'declined')", name="ck_checklists_status"),
        Index("uq_checklists_phase", "ticket_id", "phase", unique=True, postgresql_where=text("kind = 'phase'")),
        Index("uq_checklists_readiness", "round_id", unique=True, postgresql_where=text("kind = 'readiness'")),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("programs.ticket_id", ondelete="CASCADE"), index=True)
    template_id: Mapped[int | None] = mapped_column(ForeignKey("checklist_templates.id", ondelete="SET NULL"))
    kind: Mapped[str]
    title: Mapped[str]
    status: Mapped[str] = mapped_column(default="open", server_default=text("'open'"))
    round_id: Mapped[int | None] = mapped_column(ForeignKey("program_rounds.id", ondelete="CASCADE"))
    phase: Mapped[str | None]
    owner_id: Mapped[str | None]
    owner_name: Mapped[str | None]
    due_at: Mapped[datetime | None]
    requested_by: Mapped[str | None]
    requested_by_name: Mapped[str | None]
    detail: Mapped[str | None]
    resolution: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=_utcnow)


class ChecklistItem(Base):
    __tablename__ = "checklist_items"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    checklist_id: Mapped[int] = mapped_column(ForeignKey("checklists.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int]
    label: Mapped[str]
    instruction: Mapped[str] = mapped_column(default="", server_default=text("''"))
    required: Mapped[bool] = mapped_column(default=True, server_default=text("true"))
    needs_detail: Mapped[bool] = mapped_column(default=False, server_default=text("false"))
    confirmed_by: Mapped[str | None]
    confirmed_by_name: Mapped[str | None]
    confirmed_at: Mapped[datetime | None]
    detail: Mapped[str | None]


class ProgramPhase(Base):
    """A program's position in the seven-phase lifecycle. Portal-owned: HubSpot's stage stays the ticket's master."""

    __tablename__ = "program_phases"
    __table_args__ = (
        CheckConstraint("status IN ('not_started', 'in_progress', 'done', 'skipped')", name="ck_program_phases_status"),
    )

    ticket_id: Mapped[str] = mapped_column(ForeignKey("programs.ticket_id", ondelete="CASCADE"), primary_key=True)
    phase: Mapped[str] = mapped_column(primary_key=True)
    status: Mapped[str] = mapped_column(default="not_started", server_default=text("'not_started'"))
    starts_on: Mapped[date | None] = mapped_column(Date)
    due_on: Mapped[date | None] = mapped_column(Date)
    completed_at: Mapped[datetime | None]
    completed_by_name: Mapped[str | None]
    skip_reason: Mapped[str | None]


class ProgramAssignment(Base):
    """Who works a program, so queues can show "my programs". HubSpot has no marketing owner field."""

    __tablename__ = "program_assignments"
    __table_args__ = (
        CheckConstraint("role IN ('csm', 'marketing', 'account_manager')", name="ck_program_assignments_role"),
    )

    ticket_id: Mapped[str] = mapped_column(ForeignKey("programs.ticket_id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("user.user_id", ondelete="CASCADE"), primary_key=True)
    role: Mapped[str] = mapped_column(primary_key=True)


class ClientDependency(Base):
    """Something the program is waiting on from the client (an input, approval, asset or decision). Overdue and
    delay days are derived from the due date, never stored."""

    __tablename__ = "client_dependencies"
    __table_args__ = (
        CheckConstraint("kind IN ('input', 'approval', 'asset', 'decision', 'other')", name="ck_client_dependencies_kind"),
        CheckConstraint("status IN ('open', 'received', 'waived')", name="ck_client_dependencies_status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("programs.ticket_id", ondelete="CASCADE"), index=True)
    title: Mapped[str]
    kind: Mapped[str] = mapped_column(default="input", server_default=text("'input'"))
    client_owner: Mapped[str | None]  # who on the client side owes it (free text)
    owner_id: Mapped[str | None]  # who on our side follows up
    owner_name: Mapped[str | None]
    due_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(default="open", server_default=text("'open'"))
    blocks_phase: Mapped[str | None]
    blocks_round_id: Mapped[int | None] = mapped_column(ForeignKey("program_rounds.id", ondelete="SET NULL"))
    notes: Mapped[str | None]
    received_at: Mapped[datetime | None]
    created_by: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=_utcnow)


class ParticipantComm(Base):
    """A participant communication (invitation, reminder, shortlist announcement, RSVP...) planned and then sent.
    A record only: the portal never sends it."""

    __tablename__ = "participant_comms"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('invitation', 'reminder', 'shortlist', 'rsvp', 'announcement', 'other')", name="ck_participant_comms_kind"
        ),
        CheckConstraint("status IN ('planned', 'sent', 'skipped')", name="ck_participant_comms_status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("programs.ticket_id", ondelete="CASCADE"), index=True)
    kind: Mapped[str]
    audience: Mapped[str]
    round_id: Mapped[int | None] = mapped_column(ForeignKey("program_rounds.id", ondelete="SET NULL"))
    planned_for: Mapped[datetime]
    sent_at: Mapped[datetime | None]
    recipients: Mapped[int | None]
    status: Mapped[str] = mapped_column(default="planned", server_default=text("'planned'"))
    owner_id: Mapped[str | None]
    owner_name: Mapped[str | None]
    notes: Mapped[str | None]
    created_by: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=_utcnow)


class TimelineChange(Base):
    """A change to a planned date, with the original, the revised date, the reason and the approver. Approving
    applies it to the round, phase or activity it names. The original is never overwritten."""

    __tablename__ = "timeline_changes"
    __table_args__ = (
        CheckConstraint("subject_type IN ('round', 'phase', 'activity')", name="ck_timeline_changes_subject"),
        CheckConstraint("status IN ('proposed', 'approved', 'rejected')", name="ck_timeline_changes_status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("programs.ticket_id", ondelete="CASCADE"), index=True)
    subject_type: Mapped[str]
    subject_id: Mapped[str]
    label: Mapped[str]
    field: Mapped[str]  # starts_on, ends_on, due_on or planned_date
    original: Mapped[date | None] = mapped_column(Date)
    revised: Mapped[date] = mapped_column(Date)
    reason: Mapped[str]
    status: Mapped[str] = mapped_column(default="proposed", server_default=text("'proposed'"))
    proposed_by: Mapped[str | None]
    proposed_by_name: Mapped[str]
    decided_by: Mapped[str | None]
    decided_by_name: Mapped[str | None]
    decided_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)


class TimelineChangeTask(Base):
    """A downstream task a timeline change opens (e.g. re-send a reminder, re-check readiness)."""

    __tablename__ = "timeline_change_tasks"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    change_id: Mapped[int] = mapped_column(ForeignKey("timeline_changes.id", ondelete="CASCADE"), index=True)
    label: Mapped[str]
    ref_type: Mapped[str | None]
    ref_id: Mapped[str | None]
    done: Mapped[bool] = mapped_column(default=False, server_default=text("false"))
    done_by_name: Mapped[str | None]
    done_at: Mapped[datetime | None]


class ActivityMetric(Base):
    """What one marketing activity produced on one day, typed in by the marketing team (an integration with the
    marketing tools can fill it later). CTR and open rate are derived, never stored."""

    __tablename__ = "activity_metrics"
    __table_args__ = (
        CheckConstraint(
            "COALESCE(views, 0) >= 0 AND COALESCE(clicks, 0) >= 0 AND COALESCE(sent, 0) >= 0 AND COALESCE(opens, 0) >= 0",
            name="ck_activity_metrics_non_negative",
        ),
    )

    activity_id: Mapped[int] = mapped_column(ForeignKey("program_activities.id", ondelete="CASCADE"), primary_key=True)
    date: Mapped[date] = mapped_column(Date, primary_key=True)
    views: Mapped[int | None]  # impressions or views
    clicks: Mapped[int | None]
    sent: Mapped[int | None]  # for email-style activities
    opens: Mapped[int | None]
    entered_by: Mapped[str | None]
    entered_by_name: Mapped[str]
    entered_at: Mapped[datetime] = mapped_column(default=_utcnow)


class SlackOutbox(Base):
    """Every Slack message the portal sends goes through here: queued, then sent by a worker. Nothing is lost if
    Slack is down, a repeated reminder is recognised by its `dedupe_key`, and the log shows what went out."""

    __tablename__ = "slack_outbox"
    __table_args__ = (
        CheckConstraint("status IN ('queued', 'sent', 'failed', 'skipped')", name="ck_slack_outbox_status"),
        Index("uq_slack_outbox_dedupe", "dedupe_key", unique=True, postgresql_where=text("dedupe_key IS NOT NULL")),
        Index("ix_slack_outbox_status", "status", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str | None] = mapped_column(ForeignKey("programs.ticket_id", ondelete="SET NULL"), index=True)
    channel_id: Mapped[str | None]
    kind: Mapped[str]
    body: Mapped[str]
    dedupe_key: Mapped[str | None]
    status: Mapped[str] = mapped_column(default="queued", server_default=text("'queued'"))
    attempts: Mapped[int] = mapped_column(default=0, server_default=text("0"))
    error: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)
    sent_at: Mapped[datetime | None]


class AppSetting(Base):
    """Portal-wide settings (reminder time, working hours, time zone, retention) as one JSON value per key."""

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB)
    updated_by: Mapped[str | None]
    updated_at: Mapped[datetime] = mapped_column(default=_utcnow)
