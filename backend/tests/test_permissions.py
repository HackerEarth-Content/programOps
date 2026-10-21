"""The approved role matrix, as executable checks. Pure: no database."""

from core.permissions import ROLE_DEFAULTS, Permission as P, Role, effective_permissions


def roles_with(permission: P) -> set[Role]:
    return {role for role in Role if permission in ROLE_DEFAULTS[role]}


def test_only_a_csm_can_approve():
    assert roles_with(P.ACTIVITY_APPROVE) == {Role.CSM}


def test_relevant_registrations_are_csm_only_for_now():
    assert roles_with(P.RELEVANT_ENTER) == {Role.CSM}


def test_only_the_super_admin_manages_users_and_settings():
    assert roles_with(P.USERS_MANAGE) == {Role.SUPER_ADMIN}
    assert roles_with(P.SETTINGS_EDIT) == {Role.SUPER_ADMIN}


def test_marketing_edits_activities_but_cannot_approve_or_run_rounds():
    marketing = ROLE_DEFAULTS[Role.MARKETING]
    assert {P.ACTIVITY_EDIT, P.ACTIVITY_ADD_CHANNEL, P.METRICS_ENTER, P.UPDATE_POST} <= marketing
    assert not marketing & {P.ACTIVITY_APPROVE, P.ROUNDS_EDIT, P.COUNTS_ENTER, P.REGISTRATIONS_MANAGE, P.HUBSPOT_WRITE}


def test_account_manager_can_view_and_comment_only():
    assert ROLE_DEFAULTS[Role.ACCOUNT_MANAGER] == {P.PROGRAM_VIEW, P.AUDIT_VIEW, P.COMMENT_ADD, P.REQUEST_CREATE}


def test_request_templates_are_editable_by_csm_and_super_admin():
    assert roles_with(P.REQUEST_TYPES_EDIT) == {Role.CSM, Role.SUPER_ADMIN}


def test_every_permission_is_given_to_at_least_one_role():
    assert set().union(*ROLE_DEFAULTS.values()) == set(P)


def test_a_user_with_two_roles_gets_the_union():
    both = effective_permissions([Role.SUPER_ADMIN, Role.CSM])
    assert both == ROLE_DEFAULTS[Role.SUPER_ADMIN] | ROLE_DEFAULTS[Role.CSM]


def test_a_grant_adds_a_permission_the_role_lacks():
    assert P.HUBSPOT_WRITE in effective_permissions([Role.MARKETING], grants=[P.HUBSPOT_WRITE])


def test_a_revoke_removes_a_permission_the_role_has():
    assert P.ACTIVITY_EDIT not in effective_permissions([Role.MARKETING], revokes=[P.ACTIVITY_EDIT])


def test_no_roles_means_no_permissions():
    assert effective_permissions([]) == frozenset()
