import { queryOptions } from "@tanstack/react-query";
import { apiFetch, sendJson, type UserRole } from "@/lib/api";

// ---- admin: users and invites ------------------------------------------------

export type AdminUser = {
  id: string;
  email: string;
  name: string | null;
  is_active: boolean;
  roles: UserRole[];
  grants: string[];
  revokes: string[];
  permissions: string[];
  created_at: string; // first sign-in
  hubspot_csm_programs: number; // programs where HubSpot names this email as CSM
};
export type InviteStatus = "pending" | "accepted" | "revoked";
export type Invite = {
  id: string;
  email: string;
  roles: UserRole[];
  status: InviteStatus;
  created_at: string;
};
export type InvitesResult = { created: Invite[]; skipped: { email: string; reason: string }[] };

export const adminUsersQuery = queryOptions({
  queryKey: ["admin", "users"],
  queryFn: () => apiFetch<AdminUser[]>("/admin/users"),
});
export const invitesQuery = queryOptions({
  queryKey: ["admin", "invites"],
  queryFn: () => apiFetch<Invite[]>("/admin/invites"),
});

export const createInvites = (emails: string[], roles: UserRole[]) =>
  sendJson<InvitesResult>("POST", "/admin/invites", { emails, roles });
export const revokeInvite = (id: string) => sendJson<Invite>("POST", `/admin/invites/${id}/revoke`);
export const patchUser = (id: string, body: { roles?: UserRole[]; is_active?: boolean }) =>
  sendJson<AdminUser>("PATCH", `/admin/users/${id}`, body);
export const setUserPermissions = (id: string, grants: string[], revokes: string[]) =>
  sendJson<AdminUser>("PUT", `/admin/users/${id}/permissions`, { grants, revokes });

// Mirrors core/permissions.py: label per permission, grouped for the editor.
export const PERMISSION_LABELS: Record<string, string> = {
  "program.view": "View programs",
  "audit.view": "View audit log",
  "comment.add": "Add comments",
  "request.create": "Raise requests",
  "update.post": "Post updates",
  "activity.edit": "Edit marketing plan",
  "activity.add_channel": "Add channels",
  "activity.approve": "Approve activities",
  "metrics.enter": "Enter views and clicks",
  "relevant.enter": "Enter relevant registrations",
  "registrations.manage": "Manage registrations",
  "rounds.edit": "Edit rounds",
  "counts.enter": "Enter round counts",
  "request.manage": "Manage requests",
  "request_types.edit": "Edit request types",
  "hubspot.write": "Write to HubSpot",
  "integrations.link": "Link integrations",
  "users.manage": "Manage users",
  "settings.edit": "Edit settings",
};

// ---- queues ---------------------------------------------------------------------

export type Severity = "critical" | "amber" | "info";
export type QueueItem<K extends string> = {
  id: string;
  kind: K;
  severity: Severity;
  ticket_id: string;
  program_name: string;
  client: string | null;
  title: string;
  detail: string;
  since: string | null;
};
export type MarketingKind =
  | "go_live_due"
  | "ready_to_go_live"
  | "missing_utm_or_proof"
  | "awaiting_approval"
  | "results_to_record";
export type CsmKind =
  | "control_breach"
  | "approval_waiting"
  | "request_due"
  | "counts_missing"
  | "update_due"
  | "slack_unlinked"
  | "dependency_overdue"
  | "comm_overdue"
  | "readiness_incomplete"
  | "change_awaiting_approval";
export type Queue<K extends string> = { counts: Partial<Record<K, number>>; items: QueueItem<K>[] };

export const KIND_LABELS: Record<MarketingKind | CsmKind, string> = {
  go_live_due: "Go-live due",
  ready_to_go_live: "Ready to go live",
  missing_utm_or_proof: "Missing UTM or proof",
  awaiting_approval: "Awaiting approval",
  results_to_record: "Results to record",
  control_breach: "Control breach",
  approval_waiting: "Approval waiting",
  request_due: "Request due",
  counts_missing: "Counts missing",
  update_due: "Update due",
  slack_unlinked: "Slack not linked",
  dependency_overdue: "Dependency overdue",
  comm_overdue: "Communication overdue",
  readiness_incomplete: "Readiness incomplete",
  change_awaiting_approval: "Change awaiting approval",
};

export const marketingQueueQuery = queryOptions({
  queryKey: ["queues", "marketing"],
  queryFn: () => apiFetch<Queue<MarketingKind>>("/queues/marketing"),
});
export const csmQueueQuery = (scope: "mine" | "all") =>
  queryOptions({
    queryKey: ["queues", "csm", scope],
    queryFn: () => apiFetch<Queue<CsmKind>>(`/queues/csm?scope=${scope}`),
  });

// ---- marketing plan -----------------------------------------------------------------

export type ActivityStatus = "not_started" | "wip" | "live" | "off";
export type Activity = {
  id: number;
  code: string;
  channel: string;
  title: string;
  action: string | null;
  audience: string | null;
  outcome: string | null;
  hook: string | null;
  week: number | null;
  planned_date: string | null;
  status: ActivityStatus;
  approved_by_name: string | null;
  approved_at: string | null;
  go_live_at: string | null;
  utm: string | null;
  creative_proof_url: string | null;
  breach: boolean;
  updated_at: string;
};
export type ActivitySummary = {
  total: number;
  live: number;
  approved: number;
  awaiting_approval: number;
  breaches: number;
  ramp_pct: number;
};

export const activitiesQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "activities"],
    queryFn: () => apiFetch<Activity[]>(`/programs/${ticketId}/activities`),
  });
export const activitySummaryQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "activities", "summary"],
    queryFn: () => apiFetch<ActivitySummary>(`/programs/${ticketId}/activities/summary`),
  });

const act = (ticketId: string, id: number) => `/programs/${ticketId}/activities/${id}`;
export const patchActivity = (
  ticketId: string,
  id: number,
  body: { utm?: string | null; status?: ActivityStatus; creative_proof_url?: string | null },
) => sendJson<Activity>("PATCH", act(ticketId, id), body);
export const approveActivity = (ticketId: string, id: number) =>
  sendJson<Activity>("POST", `${act(ticketId, id)}/approve`);
export const withdrawApproval = (ticketId: string, id: number) =>
  sendJson<Activity>("DELETE", `${act(ticketId, id)}/approve`);
export const goLive = (ticketId: string, id: number) =>
  sendJson<Activity>("POST", `${act(ticketId, id)}/go-live`, {});

// ---- report, rounds, requests, updates, audit ------------------------------------------

export type Health = "good" | "warning" | "critical";
export type FunnelStep = {
  round_id: number;
  name: string;
  seq: number;
  status: string;
  as_of: string | null;
  invited: number | null;
  attempted: number | null;
  submitted: number | null;
  cleared: number | null;
  shortlisted: number | null;
  participation_pct: number | null;
  clearance_pct: number | null;
  shortlist_pct: number | null;
  drop_off: number | null;
};
export type Report = {
  registrations: {
    raw_total: number;
    relevant_total: number;
    relevant_pct: number | null;
    target: number | null;
    pct_of_target: number | null;
  };
  funnel: FunnelStep[];
  funnel_summary: {
    participants: number | null;
    final_shortlisted: number | null;
    registered_to_shortlist_pct: number | null;
  };
  sources: {
    fetched_at: string | null;
    organic_pct: number | null;
    matched_users: number | null;
    unmatched_users: number | null;
  };
  marketing: Omit<ActivitySummary, "ramp_pct">;
  operations: {
    health: Health;
    reasons: string[];
    open_requests: number;
    dependencies_open: number;
    dependencies_overdue: number;
    projected_slip_days: number;
    communications_planned: number;
    communications_overdue: number;
    phases_done: number;
    phases_total: number;
    changes_proposed: number;
    changes_approved: number;
  };
};
export const reportQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "report"],
    queryFn: () => apiFetch<Report>(`/programs/${ticketId}/report`),
  });

// What needs a person on one program today (backend core/needs.py): merged, grouped, most urgent first.
export type NeedsItem = {
  id: string;
  type: string;
  severity: "danger" | "warn" | "neutral";
  title: string;
  detail: string;
  action: string | null;
  tab: string;
};
export const needsQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "needs"],
    queryFn: () => apiFetch<NeedsItem[]>(`/programs/${ticketId}/needs`),
  });

export const HEALTH_REASONS: Record<string, string> = {
  control_breach: "An activity is live without approval",
  update_critical: "Latest update reports critical",
  dependency_badly_overdue: "A client dependency is badly overdue",
  update_stale: "No update in 3+ days",
  update_warning: "Latest update reports a warning",
  request_overdue: "A request is overdue",
  round_counts_missing: "A round has no counts",
  dependency_overdue: "A client dependency is overdue",
  communication_overdue: "A participant communication is overdue",
  readiness_incomplete: "A round's readiness checklist is incomplete",
  change_awaiting_approval: "A timeline change awaits approval",
};

export type Counts = {
  id: number;
  round_id: number;
  as_of: string;
  invited: number | null;
  attempted: number | null;
  submitted: number | null;
  cleared: number | null;
  shortlisted: number | null;
  note: string | null;
  entered_by_name: string;
  entered_at: string;
};
export type Round = {
  id: number;
  seq: number;
  name: string;
  kind: string;
  starts_on: string | null;
  ends_on: string | null;
  cutoff_rule: string | null;
  cutoff_value: number | null;
  status: "planned" | "live" | "evaluating" | "done";
  source: "sow" | "manual";
  latest_counts: Counts | null;
  readiness: { checklist_id: number; status: string; done: number; total: number } | null;
};
export const roundsQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "rounds"],
    queryFn: () => apiFetch<Round[]>(`/programs/${ticketId}/rounds`),
  });
export type CountsInput = {
  as_of: string;
  invited?: number;
  attempted?: number;
  submitted?: number;
  cleared?: number;
  shortlisted?: number;
};
export const addRound = (ticketId: string, name: string) =>
  sendJson<Round>("POST", `/programs/${ticketId}/rounds`, { name });
export const addCounts = (ticketId: string, roundId: number, body: CountsInput) =>
  sendJson<Counts>("POST", `/programs/${ticketId}/rounds/${roundId}/counts`, body);

export type ChecklistItem = {
  id: number;
  label: string;
  instruction: string;
  required: boolean;
  needs_detail: boolean;
  confirmed_by_name: string | null;
  confirmed_at: string | null;
  detail: string | null;
};
export type Checklist = {
  id: number;
  title: string;
  status: "open" | "in_progress" | "ready" | "done" | "declined";
  owner_id: string | null;
  owner_name: string | null;
  due_at: string | null;
  requested_by_name: string | null;
  detail: string | null;
  resolution: string | null;
  created_at: string;
  progress: { done: number; total: number };
  items: ChecklistItem[];
};
export type Template = { id: number; name: string; kind: string; active: boolean };
export const requestsQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "requests"],
    queryFn: () => apiFetch<Checklist[]>(`/programs/${ticketId}/requests`),
  });
export const requestTemplatesQuery = queryOptions({
  queryKey: ["checklist-templates", "request"],
  queryFn: () => apiFetch<Template[]>("/checklist-templates?kind=request"),
});
export const createRequest = (ticketId: string, template_id: number, detail: string | null) =>
  sendJson<Checklist>("POST", `/programs/${ticketId}/requests`, { template_id, detail });
export const confirmItem = (
  ticketId: string,
  checklistId: number,
  itemId: number,
  confirmed: boolean,
  detail?: string | undefined,
) =>
  sendJson<Checklist>("PUT", `/programs/${ticketId}/checklists/${checklistId}/items/${itemId}`, {
    confirmed,
    detail,
  });

export type UpdateNote = {
  note_id: string;
  kind: "note" | "comment" | "update";
  body: string;
  health: Health | null;
  blockers: string | null;
  author_name: string | null;
  source: string;
  created_at: string;
};
export const updatesQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "updates"],
    queryFn: () => apiFetch<{ items: UpdateNote[] }>(`/programs/${ticketId}/updates`),
  });
export const postUpdate = (
  ticketId: string,
  body: { health: Health; summary: string; blockers: string | null },
) => sendJson<UpdateNote>("POST", `/programs/${ticketId}/updates`, body);
export const postComment = (ticketId: string, body: string) =>
  sendJson<UpdateNote>("POST", `/programs/${ticketId}/comments`, { body });

export type AuditEvent = {
  id: number;
  ticket_id: string | null;
  entity: string;
  entity_id: string;
  action: string;
  field: string | null;
  old: unknown;
  new: unknown;
  actor_name: string;
  at: string;
};
export const auditQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "audit"],
    queryFn: () =>
      apiFetch<{ items: AuditEvent[]; next_before: number | null }>(`/audit?ticket_id=${ticketId}`),
  });

export const portfolioQuery = queryOptions({
  queryKey: ["portfolio"],
  queryFn: () => apiFetch<{ programs: { ticket_id: string; health: Health }[] }>("/portfolio"),
});
