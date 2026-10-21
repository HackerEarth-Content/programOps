import { queryOptions } from "@tanstack/react-query";
import { API_BASE_URL, apiFetch, sendJson } from "@/lib/api";
import type { Activity, AuditEvent } from "@/lib/ops-api";

/** ActivityOut in full (ops-api's `Activity` omits a few fields). */
export type PlanActivity = Activity & {
  source: "poa" | "manual";
  target_note: string | null;
  comes_off_at: string | null;
  tracker_ref: string | null;
};

// Same key as ops-api's activitiesQuery, so every invalidation of the plan reaches this one too.
export const planQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "activities"],
    queryFn: () => apiFetch<PlanActivity[]>(`/programs/${ticketId}/activities`),
  });

export type Assignment = { user_id: string; name: string; role: string };
export const assignmentsQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "assignments"],
    queryFn: () => apiFetch<Assignment[]>(`/programs/${ticketId}/assignments`),
  });

/** Thrown on HTTP 409 (stale If-Match, or a rule conflict). */
export class ConflictError extends Error {}

async function send<T>(method: string, path: string, body: unknown, ifMatch?: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(ifMatch ? { "If-Match": ifMatch } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail: unknown = await response.json().catch(() => null);
    const message =
      detail &&
      typeof detail === "object" &&
      "detail" in detail &&
      typeof detail.detail === "string"
        ? detail.detail
        : `Request failed: ${response.status}`;
    throw response.status === 409 ? new ConflictError(message) : new Error(message);
  }
  return response.json() as Promise<T>;
}

export type PlanPatch = {
  status?: "not_started" | "wip" | "off";
  utm?: string | null;
  creative_proof_url?: string | null;
};
/** PATCH with optimistic concurrency: the activity's `updated_at` goes back as If-Match. */
export const patchPlanActivity = (ticketId: string, a: PlanActivity, body: PlanPatch) =>
  send<PlanActivity>("PATCH", `/programs/${ticketId}/activities/${a.id}`, body, a.updated_at);

export type ChannelInput = {
  channel: string;
  title: string;
  week?: number | null;
  planned_date?: string | null;
  audience?: string | null;
  outcome?: string | null;
  hook?: string | null;
};
export const addChannel = (ticketId: string, body: ChannelInput) =>
  sendJson<PlanActivity>("POST", `/programs/${ticketId}/activities`, body);

export type RereadResult = { added: number; removed: number; edits_kept: number };
export const rereadPlan = (ticketId: string) =>
  sendJson<RereadResult>("POST", `/programs/${ticketId}/plan/reread`);

export const nudgeActivity = (ticketId: string, id: number) =>
  sendJson<{ queued: boolean; recipients: string[] }>(
    "POST",
    `/programs/${ticketId}/activities/${id}/nudge`,
  );

export type MetricTotals = {
  views: number;
  clicks: number;
  sent: number;
  opens: number;
  ctr: number | null;
  open_rate: number | null;
};
export type MetricDay = {
  date: string;
  views: number | null;
  clicks: number | null;
  sent: number | null;
  opens: number | null;
  ctr: number | null;
  open_rate: number | null;
  entered_by_name: string;
  entered_at: string;
};
export type ActivityMetrics = { days: MetricDay[]; totals: MetricTotals };

export const metricsQuery = (ticketId: string, id: number) =>
  queryOptions({
    queryKey: ["programs", ticketId, "activities", id, "metrics"],
    queryFn: () => apiFetch<ActivityMetrics>(`/programs/${ticketId}/activities/${id}/metrics`),
  });
export type MetricsInput = {
  date: string;
  views?: number;
  clicks?: number;
  sent?: number;
  opens?: number;
};
export const putMetrics = (ticketId: string, id: number, body: MetricsInput) =>
  sendJson<ActivityMetrics>("PUT", `/programs/${ticketId}/activities/${id}/metrics`, body);

export const activityAuditQuery = (id: number) =>
  queryOptions({
    queryKey: ["audit", "activity", id],
    queryFn: () =>
      apiFetch<{ items: AuditEvent[]; next_before: number | null }>(
        `/audit?entity=activity&entity_id=${id}&limit=30`,
      ),
  });

export const nudgeAllForApproval = (ticketId: string) =>
  sendJson<{ queued: boolean; recipients: string[] }>(
    "POST",
    `/programs/${ticketId}/activities/nudge-approvals`,
  );

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const dayOf = (v: string | null) => (v ? v.slice(0, 10) : null);

/**
 * Activities that look like the same thing planned twice: same channel, same normalised name and dates that
 * overlap (two undated rows count as overlapping only within the same week). Flagged, never auto-deleted.
 */
export function possibleDuplicates(rows: PlanActivity[]): Set<number> {
  const groups = new Map<string, PlanActivity[]>();
  for (const a of rows) {
    if (a.status === "off") continue;
    const key = `${normalise(a.channel)}|${normalise(a.title)}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const range = (a: PlanActivity) => {
    const start = a.planned_date ?? dayOf(a.go_live_at);
    return start ? ([start, dayOf(a.comes_off_at) ?? start] as const) : null;
  };
  const flagged = new Set<number>();
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i]!, group[j]!];
        const [ra, rb] = [range(a), range(b)];
        const overlap =
          ra && rb ? ra[0] <= rb[1] && rb[0] <= ra[1] : !ra && !rb && a.week === b.week;
        if (overlap) {
          flagged.add(a.id);
          flagged.add(b.id);
        }
      }
    }
  }
  return flagged;
}
