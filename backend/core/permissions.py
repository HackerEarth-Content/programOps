"""Roles, permissions and the role defaults. Pure data and one pure function: no database here."""

from __future__ import annotations

from collections.abc import Iterable
from enum import StrEnum


class Role(StrEnum):
    SUPER_ADMIN = "super_admin"
    CSM = "csm"
    MARKETING = "marketing"
    ACCOUNT_MANAGER = "account_manager"
    VIEWER = "viewer"  # signs in with a company account, sees progress, changes nothing


class Permission(StrEnum):
    PROGRAM_VIEW = "program.view"
    PROGRAM_CREATE = "program.create"  # start an internal hackathon
    AUDIT_VIEW = "audit.view"
    COMMENT_ADD = "comment.add"
    REQUEST_CREATE = "request.create"
    UPDATE_POST = "update.post"
    ACTIVITY_EDIT = "activity.edit"
    ACTIVITY_ADD_CHANNEL = "activity.add_channel"
    ACTIVITY_APPROVE = "activity.approve"
    METRICS_ENTER = "metrics.enter"
    RELEVANT_ENTER = "relevant.enter"
    REGISTRATIONS_MANAGE = "registrations.manage"
    ROUNDS_EDIT = "rounds.edit"
    COUNTS_ENTER = "counts.enter"
    REQUEST_MANAGE = "request.manage"
    REQUEST_TYPES_EDIT = "request_types.edit"
    HUBSPOT_WRITE = "hubspot.write"
    INTEGRATIONS_LINK = "integrations.link"
    USERS_MANAGE = "users.manage"
    SETTINGS_EDIT = "settings.edit"


P = Permission

_INTERNAL_BASE = frozenset({P.PROGRAM_VIEW, P.AUDIT_VIEW, P.COMMENT_ADD, P.REQUEST_CREATE})

ROLE_DEFAULTS: dict[Role, frozenset[Permission]] = {
    Role.SUPER_ADMIN: frozenset(Permission),  # everything, including any permission added later
    Role.CSM: _INTERNAL_BASE
    | {
        P.UPDATE_POST, P.ACTIVITY_EDIT, P.ACTIVITY_ADD_CHANNEL, P.ACTIVITY_APPROVE, P.METRICS_ENTER,
        P.RELEVANT_ENTER, P.REGISTRATIONS_MANAGE, P.ROUNDS_EDIT, P.COUNTS_ENTER, P.REQUEST_MANAGE,
        P.REQUEST_TYPES_EDIT, P.HUBSPOT_WRITE, P.INTEGRATIONS_LINK, P.PROGRAM_CREATE,
    },
    Role.MARKETING: _INTERNAL_BASE
    | {P.UPDATE_POST, P.ACTIVITY_EDIT, P.ACTIVITY_ADD_CHANNEL, P.METRICS_ENTER},
    Role.ACCOUNT_MANAGER: _INTERNAL_BASE,
    Role.VIEWER: frozenset({P.PROGRAM_VIEW}),
}


def effective_permissions(
    roles: Iterable[Role], grants: Iterable[Permission] = (), revokes: Iterable[Permission] = ()
) -> frozenset[Permission]:
    """Union of every role's defaults, plus individual grants, minus individual revokes."""
    defaults: frozenset[Permission] = frozenset().union(*(ROLE_DEFAULTS[r] for r in roles))
    return (defaults | frozenset(grants)) - frozenset(revokes)
