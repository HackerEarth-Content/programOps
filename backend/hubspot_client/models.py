"""Program (ticket) data model for the Programs Feasibility Support pipeline."""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel

from hubspot_client.stage_checklist import (
    CHECKLIST_PROPERTY_TO_COLUMN,
    PROGRAM_STAGES,
    STAGE_CHECKLISTS,
)

_MS_PER_HOUR = 3_600_000


def _ms_to_hours(raw: str | None) -> float | None:
    if raw is None or raw == "":
        return None
    return round(float(raw) / _MS_PER_HOUR, 2)


def _split_checkbox(raw: str | None) -> list[str]:
    """HubSpot multi-checkbox properties are semicolon-joined on read."""
    if not raw:
        return []
    return [p.strip() for p in raw.split(";") if p.strip()]


def parse_intake_description(content: str | None) -> dict[str, Any]:
    """The ticket description is the intake form dumped as "Label: value"
    lines. Pulls out the client name and expected deal size (labels can
    themselves contain colons, so the value is whatever follows the last one)."""
    out: dict[str, Any] = {"client_name": None, "deal_size": None}
    for line in (content or "").splitlines():
        if line.startswith("Client's Name:"):
            out["client_name"] = line.split(":", 1)[1].strip() or None
        elif line.startswith("Expected Deal Size"):
            m = re.search(r":\s*(?:INR\s*)?([\d,]+(?:\.\d+)?)\s*$", line)
            if m:
                out["deal_size"] = float(m.group(1).replace(",", ""))
    return out


def _to_float(raw: str | None) -> float | None:
    """A free-typed number field can hold anything; junk means "not set",
    not a failed sync."""
    try:
        return float(raw) if raw else None
    except ValueError:
        return None


def _owner_label(owners: dict[str, str], owner_id: str | None) -> str | None:
    """None only when the field is truly empty; an id HubSpot can't resolve
    (e.g. permanently removed user) shows as such instead of "Unassigned"."""
    if not owner_id:
        return None
    return owners.get(owner_id) or f"Unknown user ({owner_id})"


def _platform(props: dict[str, Any]) -> str | None:
    """platform_details is a dropdown; its "Other..." option pairs with a free-text field."""
    chosen = props.get("platform_details") or None
    other = props.get("other_platform_details") or None
    if other and (chosen is None or chosen.lower().startswith("other")):
        return other
    return chosen


class ProgramTicket(BaseModel):
    """A HubSpot ticket in the Programs Feasibility Support pipeline,
    normalized for program/campaign KPIs."""

    ticket_id: str
    subject: str
    pipeline_id: str
    pipeline_label: str
    stage_id: str
    stage_label: str

    campaign_type: str | None
    campaign_name: str | None
    event_name: str | None
    platform_details: str | None
    other_event_name: str | None
    event_id: str | None
    registration_start_date: str | None  # date string, YYYY-MM-DD
    event_end_date: str | None
    target_audience: list[str]
    geography: list[str]

    blackops_account_name: str | None
    company_name: str | None
    deal_id: str | None
    # account_manager/csm_for_the_deal/content_poc are HubSpot owner-reference
    # properties -- resolved to *_name via the owners lookup, same as owner_id.
    account_manager_id: str | None
    account_manager_name: str | None
    csm_id: str | None
    csm_name: str | None
    content_poc_id: str | None
    content_poc_name: str | None
    internal_team: str | None
    expected_deal_size: float | None
    deal_size_source: str | None

    pre_sales_status: list[str]
    onboarding_status: list[str]
    ongoing_status: list[str]
    post_campaign_status: list[str]
    stage_notes: dict[str, str]

    owner_id: str | None
    owner_name: str | None
    ticket_validity: str | None
    final_resolution: str | None

    created_at: str | None
    closed_at: str | None
    last_modified_at: str | None

    created_by_user_id: int | None
    updated_by_user_id: int | None
    record_source: str | None
    record_source_detail: str | None
    num_notes: int | None
    notes_last_updated: str | None
    # Full raw properties payload -- forward-compatible snapshot, see
    # core.orm.Program.raw_properties.
    raw_properties: dict[str, Any]

    # stage_key -> {entered_at, exited_at, cumulative_hours}, for all 6 stages.
    stage_timings: dict[str, dict[str, Any]]

    @classmethod
    def from_raw(
        cls,
        raw: dict[str, Any],
        pipeline: dict,
        pipeline_id: str,
        owners: dict[str, str] | None = None,
    ) -> "ProgramTicket":
        props = raw.get("properties", {})
        stage_id = props.get("hs_pipeline_stage") or ""
        stage_label = pipeline.get("stages", {}).get(stage_id, stage_id or "-")
        owners = owners or {}
        owner_id = props.get("hubspot_owner_id") or None
        account_manager_id = props.get("account_manager") or None
        csm_id = props.get("csm_for_the_deal") or None
        content_poc_id = props.get("content_poc") or None

        checklist_columns: dict[str, list[str]] = {}
        stage_notes: dict[str, str] = {}
        for stage_key, (checklist_prop, items) in STAGE_CHECKLISTS.items():
            column = CHECKLIST_PROPERTY_TO_COLUMN[checklist_prop]
            checklist_columns[column] = _split_checkbox(props.get(checklist_prop))
            for label, info_prop in items:
                note = props.get(info_prop)
                if note:
                    stage_notes[label] = note

        stage_timings = {
            stage_key: {
                "entered_at": props.get(f"hs_v2_date_entered_{stage['stage_id']}")
                or None,
                "exited_at": props.get(f"hs_v2_date_exited_{stage['stage_id']}")
                or None,
                "cumulative_hours": _ms_to_hours(
                    props.get(f"hs_v2_cumulative_time_in_{stage['stage_id']}")
                ),
            }
            for stage_key, stage in PROGRAM_STAGES.items()
        }

        deal_size_raw = props.get(
            "expected_deal_size_eg_inr_xxx_in_case_its_not_clear_give_us_the_lowest_number_that_he_will_target"
        )

        intake = parse_intake_description(props.get("content"))
        hubspot_deal_size = _to_float(deal_size_raw)
        if hubspot_deal_size is not None:
            deal_size, deal_size_source = hubspot_deal_size, "hubspot"
        elif intake["deal_size"] is not None:
            deal_size, deal_size_source = intake["deal_size"], "description"
        else:
            deal_size, deal_size_source = None, None

        return cls(
            ticket_id=raw.get("id", ""),
            subject=props.get("subject") or "",
            pipeline_id=pipeline_id,
            pipeline_label=pipeline.get("label", pipeline_id),
            stage_id=stage_id,
            stage_label=stage_label,
            campaign_type=props.get("campaign_type") or None,
            campaign_name=props.get("campaign_name") or None,
            # program_name is the authoritative event name; the older dropdown is the fallback.
            event_name=props.get("program_name") or props.get("event_name") or None,
            platform_details=_platform(props),
            other_event_name=props.get("other_event_name") or None,
            event_id=props.get("event_id") or None,
            registration_start_date=props.get("registration_start_date"),
            event_end_date=props.get("event_end_date_skip_if_undefined"),
            target_audience=_split_checkbox(props.get("target_audience")),
            geography=_split_checkbox(
                props.get(
                    "geography_if_its_a_specific_city_or_split_please_specify_in_other"
                )
            ),
            blackops_account_name=props.get("blackops_account_name") or None,
            company_name=props.get("company_name") or intake["client_name"],
            deal_id=props.get("deal_id") or None,
            account_manager_id=account_manager_id,
            account_manager_name=_owner_label(owners, account_manager_id),
            csm_id=csm_id,
            csm_name=_owner_label(owners, csm_id),
            content_poc_id=content_poc_id,
            content_poc_name=_owner_label(owners, content_poc_id),
            internal_team=props.get("internal_team") or None,
            expected_deal_size=deal_size,
            deal_size_source=deal_size_source,
            pre_sales_status=checklist_columns.get("pre_sales_status", []),
            onboarding_status=checklist_columns.get("onboarding_status", []),
            ongoing_status=checklist_columns.get("ongoing_status", []),
            post_campaign_status=checklist_columns.get("post_campaign_status", []),
            stage_notes=stage_notes,
            owner_id=owner_id,
            owner_name=_owner_label(owners, owner_id),
            ticket_validity=props.get("ticket_validity") or None,
            final_resolution=props.get("final_resolution") or None,
            created_at=props.get("createdate"),
            closed_at=props.get("closed_date"),
            last_modified_at=props.get("hs_lastmodifieddate"),
            created_by_user_id=_to_int(props.get("hs_created_by_user_id")),
            updated_by_user_id=_to_int(props.get("hs_updated_by_user_id")),
            record_source=props.get("hs_object_source") or None,
            record_source_detail=props.get("hs_object_source_detail_1") or None,
            num_notes=_to_int(props.get("num_notes")),
            notes_last_updated=props.get("notes_last_updated"),
            raw_properties=props,
            stage_timings=stage_timings,
        )


class StageHistoryEvent(BaseModel):
    """One entry in program_stage_history -- a single property change,
    sourced from HubSpot's own property-history API (see
    HubSpotClient.fetch_property_history)."""

    ticket_id: str
    property_name: str
    old_value: str | None
    new_value: str | None
    changed_at: str
    source_type: str | None
    changed_by_user_id: int | None

    @classmethod
    def from_property_history(
        cls, ticket_id: str, property_history: dict[str, list[dict]]
    ) -> list["StageHistoryEvent"]:
        """HubSpot returns each property's events newest-first; walk them
        oldest-first so `old_value` is the value immediately before each
        change (None for a property's very first recorded value)."""
        events: list["StageHistoryEvent"] = []
        for property_name, changes in property_history.items():
            ordered = sorted(changes, key=lambda c: c["timestamp"])
            previous_value: str | None = None
            for change in ordered:
                events.append(
                    cls(
                        ticket_id=ticket_id,
                        property_name=property_name,
                        old_value=previous_value,
                        new_value=change.get("value"),
                        changed_at=change["timestamp"],
                        source_type=change.get("sourceType"),
                        changed_by_user_id=change.get("updatedByUserId"),
                    )
                )
                previous_value = change.get("value")
        return events


class ProgramNoteModel(BaseModel):
    """A HubSpot Notes engagement associated with a program -- the free-text
    "why"/comment a rep leaves (see HubSpotClient.fetch_notes)."""

    note_id: str
    ticket_id: str
    body: str
    author_user_id: int | None
    created_at: str

    @classmethod
    def from_raw(cls, ticket_id: str, raw: dict[str, Any]) -> "ProgramNoteModel":
        props = raw.get("properties", {})
        return cls(
            note_id=raw["id"],
            ticket_id=ticket_id,
            body=props.get("hs_note_body") or "",
            author_user_id=_to_int(props.get("hs_created_by")),
            created_at=props.get("hs_timestamp"),
        )


def _to_int(raw: str | None) -> int | None:
    if raw is None or raw == "":
        return None
    return int(float(raw))
