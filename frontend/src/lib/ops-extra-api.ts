// Typed calls for the program Ops tabs that ops-api.ts doesn't cover. Shapes mirror
// backend/api/{round,checklist,ops,update,admin}_routes.py.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { apiFetch, sendJson } from "@/lib/api";
import type { AuditEvent, Checklist, Counts, Health, Round, UpdateNote } from "@/lib/ops-api";

const p = (t: string) => `/programs/${t}`;

// ---- rounds ----------------------------------------------------------------------------
export type RoundKind = "assessment" | "project" | "interview" | "onsite" | "custom";
export const ROUND_KINDS: RoundKind[] = ["assessment", "project", "interview", "onsite", "custom"];
export type RoundStatus = Round["status"];
export const ROUND_STATUSES: RoundStatus[] = ["planned", "live", "evaluating", "done"];

export type RoundFull = Round & { source: "sow" | "manual" };
export const roundsFullQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "rounds", "full"],
    queryFn: () => apiFetch<RoundFull[]>(`${p(ticketId)}/rounds`),
  });

export type CountsRow = Counts & { supersedes_id: number | null };
export type CountsFields = {
  invited?: number | null;
  attempted?: number | null;
  submitted?: number | null;
  cleared?: number | null;
  shortlisted?: number | null;
  note?: string | null;
};
export type RoundInput = {
  name: string;
  kind?: RoundKind;
  starts_on?: string | null;
  ends_on?: string | null;
  cutoff_rule?: string | null;
  cutoff_value?: number | null;
  source?: "sow" | "manual";
};
export type RoundPatchInput = Partial<Omit<RoundInput, "source">> & { status?: RoundStatus };
export type SuggestedRound = { name: string; notes: string };

export const countsHistoryQuery = (ticketId: string, roundId: number) =>
  queryOptions({
    queryKey: ["programs", ticketId, "rounds", roundId, "counts"],
    queryFn: () => apiFetch<CountsRow[]>(`${p(ticketId)}/rounds/${roundId}/counts`),
  });
export const suggestedRoundsQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "rounds", "suggested"],
    queryFn: () => apiFetch<SuggestedRound[]>(`${p(ticketId)}/rounds/suggested`),
  });
export const createRound = (ticketId: string, body: RoundInput) =>
  sendJson<Round>("POST", `${p(ticketId)}/rounds`, body);
export const patchRound = (ticketId: string, roundId: number, body: RoundPatchInput) =>
  sendJson<Round>("PATCH", `${p(ticketId)}/rounds/${roundId}`, body);
export const recordCounts = (
  ticketId: string,
  roundId: number,
  body: CountsFields & { as_of: string },
) => sendJson<CountsRow>("POST", `${p(ticketId)}/rounds/${roundId}/counts`, body);
export const deleteRound = (ticketId: string, roundId: number) =>
  sendJson<void>("DELETE", `${p(ticketId)}/rounds/${roundId}`);
export const supersedeCounts = (
  ticketId: string,
  roundId: number,
  countId: number,
  body: CountsFields,
) =>
  sendJson<CountsRow>("POST", `${p(ticketId)}/rounds/${roundId}/counts/${countId}/supersede`, body);

// ---- requests ----------------------------------------------------------------------------
export type RequestStatus = Checklist["status"];
export type RequestFull = Checklist & { created_at: string; resolution: string | null };
export const requestsFullQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "requests", "full"],
    queryFn: () => apiFetch<RequestFull[]>(`${p(ticketId)}/requests`),
  });
export type RaiseRequestInput = {
  template_id: number;
  detail?: string | null;
  due_at?: string | null;
  owner_id?: string | null;
};
export const raiseRequest = (ticketId: string, body: RaiseRequestInput) =>
  sendJson<Checklist>("POST", `${p(ticketId)}/requests`, body);
export const patchRequest = (
  ticketId: string,
  id: number,
  body: { status?: RequestStatus; resolution?: string | null; owner_id?: string | null },
) => sendJson<Checklist>("PATCH", `${p(ticketId)}/requests/${id}`, body);
/** Same endpoint ops-api uses, but returns the updated checklist for any kind (gates too). */
export const confirmChecklistItem = (
  ticketId: string,
  checklistId: number,
  itemId: number,
  confirmed: boolean,
  detail?: string,
) =>
  sendJson<Checklist>("PUT", `${p(ticketId)}/checklists/${checklistId}/items/${itemId}`, {
    confirmed,
    detail: detail ?? null,
  });

// ---- lifecycle ---------------------------------------------------------------------------
export type PhaseStatus = "not_started" | "in_progress" | "done" | "skipped";
export type GateChecklist = Checklist & {
  round_id: number | null;
  phase: string | null;
  resolution: string | null;
};
export type Phase = {
  phase: string;
  title: string;
  status: PhaseStatus;
  starts_on: string | null;
  due_on: string | null;
  completed_at: string | null;
  completed_by_name: string | null;
  skip_reason: string | null;
  gate: GateChecklist | null;
};
export const lifecycleQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "lifecycle"],
    queryFn: () => apiFetch<Phase[]>(`${p(ticketId)}/lifecycle`),
  });
export const patchPhase = (
  ticketId: string,
  phase: string,
  body: { status?: PhaseStatus; skip_reason?: string | null },
) => sendJson<Phase>("PATCH", `${p(ticketId)}/lifecycle/${phase}`, body);

// ---- updates feed (cursor pagination) ----------------------------------------------------------
export type NotePage = { items: UpdateNote[]; next_before: string | null };
export const updatesFeedQuery = (ticketId: string) =>
  infiniteQueryOptions({
    queryKey: ["programs", ticketId, "updates", "feed"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiFetch<NotePage>(
        `${p(ticketId)}/updates?limit=20${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    getNextPageParam: (last) => last.next_before,
  });
export type { Health };

// ---- dependencies --------------------------------------------------------------------------
export type DependencyStatus = "open" | "received" | "waived";
export type DependencyKind = "input" | "approval" | "asset" | "decision" | "other";
export type Dependency = {
  id: number;
  title: string;
  kind: string;
  client_owner: string | null;
  owner_id: string | null;
  owner_name: string | null;
  due_on: string | null;
  status: DependencyStatus;
  blocks_phase: string | null;
  blocks_round_id: number | null;
  notes: string | null;
  received_at: string | null;
  overdue: boolean;
  delay_days: number;
};
export type DependencyImpact = {
  open: number;
  overdue: number;
  max_delay_days: number;
  projected_slip_days: number;
  blocked_phases: string[];
  blocked_round_ids: number[];
};
export const dependenciesQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "dependencies"],
    queryFn: () =>
      apiFetch<{ items: Dependency[]; impact: DependencyImpact }>(`${p(ticketId)}/dependencies`),
  });
export const addDependency = (
  ticketId: string,
  body: { title: string; client_owner?: string | null; due_on?: string | null },
) => sendJson<Dependency>("POST", `${p(ticketId)}/dependencies`, body);
export const patchDependency = (
  ticketId: string,
  id: number,
  body: { status?: DependencyStatus; owner_id?: string | null },
) => sendJson<Dependency>("PATCH", `${p(ticketId)}/dependencies/${id}`, body);

// ---- communications ----------------------------------------------------------------------
export type CommStatus = "planned" | "sent" | "skipped";
export type CommKind = "invitation" | "reminder" | "shortlist" | "rsvp" | "announcement" | "other";
export type Comm = {
  id: number;
  kind: string;
  audience: string;
  round_id: number | null;
  planned_for: string;
  sent_at: string | null;
  recipients: number | null;
  status: CommStatus;
  owner_name: string | null;
  notes: string | null;
  overdue: boolean;
};
export const communicationsQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "communications"],
    queryFn: () => apiFetch<Comm[]>(`${p(ticketId)}/communications`),
  });
export const planCommunication = (
  ticketId: string,
  body: { kind: string; audience: string; planned_for: string; recipients?: number | null },
) => sendJson<Comm>("POST", `${p(ticketId)}/communications`, body);
export const patchCommunication = (ticketId: string, id: number, body: { status: CommStatus }) =>
  sendJson<Comm>("PATCH", `${p(ticketId)}/communications/${id}`, body);

// ---- timeline changes ----------------------------------------------------------------------
export type ChangeStatus = "proposed" | "approved" | "rejected";
export type SubjectType = "round" | "phase" | "activity";
export type ChangeTask = { id: number; label: string; done: boolean; done_by_name: string | null };
export type TimelineChange = {
  id: number;
  subject_type: SubjectType;
  subject_id: string;
  label: string;
  field: string;
  original: string | null;
  revised: string;
  reason: string;
  status: ChangeStatus;
  proposed_by_name: string;
  decided_by_name: string | null;
  decided_at: string | null;
  created_at: string;
  tasks: ChangeTask[];
};
export const timelineChangesQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "timeline-changes"],
    queryFn: () => apiFetch<TimelineChange[]>(`${p(ticketId)}/timeline-changes`),
  });
export const proposeChange = (
  ticketId: string,
  body: {
    subject_type: SubjectType;
    subject_id: string;
    field: string;
    revised: string;
    reason: string;
  },
) => sendJson<TimelineChange>("POST", `${p(ticketId)}/timeline-changes`, body);
export const decideChange = (ticketId: string, id: number, decision: "approve" | "reject") =>
  sendJson<TimelineChange>("POST", `${p(ticketId)}/timeline-changes/${id}/${decision}`);
export const setChangeTask = (ticketId: string, id: number, taskId: number, done: boolean) =>
  sendJson<TimelineChange>("PATCH", `${p(ticketId)}/timeline-changes/${id}/tasks/${taskId}`, {
    done,
  });

// ---- audit (keyset pagination) ----------------------------------------------------------
export const AUDIT_ENTITIES = [
  "activity",
  "round",
  "round_counts",
  "checklist",
  "phase",
  "dependency",
  "communication",
  "timeline_change",
  "update",
  "comment",
] as const;
export type AuditPage = { items: AuditEvent[]; next_before: number | null };
export const auditFeedQuery = (ticketId: string, entity: string | null) =>
  infiniteQueryOptions({
    queryKey: ["programs", ticketId, "audit", "feed", entity],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      apiFetch<AuditPage>(
        `/audit?ticket_id=${ticketId}&limit=40${entity ? `&entity=${entity}` : ""}${pageParam ? `&before=${pageParam}` : ""}`,
      ),
    getNextPageParam: (last) => last.next_before,
  });
