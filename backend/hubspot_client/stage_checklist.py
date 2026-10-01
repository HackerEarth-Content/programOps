"""Stage identity and per-stage checklist config for the Programs Feasibility
Support pipeline (id 934067746). Verified live against this portal's pipeline
and ticket-property schema on 2026-09-25.

Every non-terminal stage after "New" has its own HubSpot multi-checkbox
property (e.g. `pre_sales_status`) whose options are the parameters required
to move a program through that stage; each option is paired with a free-text
"*_info" property carrying the note/detail for when that item was completed.
A program's "what's it pending on" is exactly the checklist items not yet
selected for its current stage.
"""

from __future__ import annotations

# stage_key -> {stage_id, label}, all 6 Programs Feasibility Support stages.
PROGRAM_STAGES: dict[str, dict[str, str]] = {
    "new": {"stage_id": "1435441940", "label": "New"},
    "pre_sales": {"stage_id": "1445425472", "label": "Pre Sales"},
    "onboarding": {"stage_id": "1435441941", "label": "Onboarding"},
    "ongoing": {"stage_id": "1438248025", "label": "Ongoing"},
    "post_campaign": {"stage_id": "1438248026", "label": "Post Campaign"},
    "closed": {"stage_id": "1445425466", "label": "Closed"},
}

# stage_key -> (checklist property, [(option label, paired info property), ...]).
# "New" and "Closed" have no checklist -- New is pre-qualification, Closed is terminal.
STAGE_CHECKLISTS: dict[str, tuple[str, list[tuple[str, str]]]] = {
    "pre_sales": (
        "pre_sales_status",
        [
            ("Requirement Gathering", "requirement_gathering_info"),
            ("Proposal Shared", "proposal_shared_info"),
            ("PO Closed", "po_closed_info"),
            ("SOW Shared", "sow_shared_info"),
            ("SOW Signed", "sow_signed_info"),
        ],
    ),
    "onboarding": (
        "onboarding_status",
        [
            ("Kickoff Done", "kickoff_done_info"),
            ("Pre-requisites Pending", "prerequisites_pending_info"),
            ("Pre-requisites Received", "prerequisites_received_info"),
            ("Content Format Finalization", "content_format_finalization_info"),
            ("Page Build", "page_build_info"),
            ("Client Review on page", "client_review_on_page__info"),
            ("Client Review on Content", "client_review_on_content___info"),
            ("Changes in Progress Page", "changes_in_progress_page"),
            ("Go-Live Approved", "golive_approved__info"),
        ],
    ),
    "ongoing": (
        "ongoing",
        [
            ("Live – Registrations Open", "live__registrations_open__info"),
            ("Phase in Progress", "phase_in_progress__info"),
            ("Evaluation in Progress", "evaluation_in_progress__info"),
            ("Results Shared", "results_shared__info"),
            ("Shortlist Announced", "shortlist_announced"),
            ("Finale Planning (if applicable)", "finale_planning_if_applicable__info"),
            ("Finale Completed (if applicable)", "finale_completed_if_applicable__info"),
        ],
    ),
    "post_campaign": (
        "post_campaign",
        [
            ("Winners Announced", "winners_announced__info"),
            ("Rewards Distribution", "rewards_distribution__info"),
            ("Report Shared", "report_shared__info"),
            ("Feedback & Retro", "feedback__retro__info"),
        ],
    ),
}

# ORM column each checklist property maps to (core.orm.Program).
CHECKLIST_PROPERTY_TO_COLUMN: dict[str, str] = {
    "pre_sales_status": "pre_sales_status",
    "onboarding_status": "onboarding_status",
    "ongoing": "ongoing_status",
    "post_campaign": "post_campaign_status",
}

# Every checklist + info property, for the HubSpot ticket search request.
CHECKLIST_PROPERTIES: list[str] = [
    prop
    for _, (checklist_prop, items) in STAGE_CHECKLISTS.items()
    for prop in [checklist_prop] + [info for _, info in items]
]


def pending_items(stage_key: str, selected: list[str]) -> list[str]:
    """Checklist item labels not yet selected for this stage -- "what it's
    pending on". Empty for stages with no checklist (New/Closed) or once
    everything is selected."""
    checklist = STAGE_CHECKLISTS.get(stage_key)
    if not checklist:
        return []
    _, items = checklist
    selected_set = set(selected)
    return [label for label, _ in items if label not in selected_set]


# hs_pipeline_stage's raw value is a HubSpot internal stage id (e.g.
# "1435441940") -- everything else in program_stage_history (the checklist
# properties) already stores human-readable option labels, semicolon-joined.
_STAGE_ID_TO_LABEL: dict[str, str] = {
    stage["stage_id"]: stage["label"] for stage in PROGRAM_STAGES.values()
}

# Friendly display name for each property_name that shows up in
# program_stage_history -- avoids surfacing raw HubSpot internal property
# names (e.g. "hs_pipeline_stage") to API consumers/the frontend.
PROPERTY_LABELS: dict[str, str] = {
    "hs_pipeline_stage": "Stage",
    "pre_sales_status": "Pre Sales checklist",
    "onboarding_status": "Onboarding checklist",
    "ongoing": "Ongoing checklist",
    "post_campaign": "Post Campaign checklist",
}


def resolve_history_value(property_name: str, value: str | None) -> str | None:
    """Human-readable form of a program_stage_history old_value/new_value.
    Only hs_pipeline_stage needs translation (raw stage id -> label); every
    other tracked property already stores readable checklist-item labels."""
    if value is None:
        return None
    if property_name == "hs_pipeline_stage":
        return _STAGE_ID_TO_LABEL.get(value, value)
    return value
