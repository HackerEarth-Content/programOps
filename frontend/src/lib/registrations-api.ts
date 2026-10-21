import { queryOptions } from "@tanstack/react-query";
import { apiFetch, sendJson, type Registrations } from "@/lib/api";

// GET /programs/{id}/registrations plus the two totals the backend keeps apart.
export type RegistrationsView = Registrations & { raw_total: number; relevant_total: number };
export const registrationsViewQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "registrations"],
    queryFn: () => apiFetch<RegistrationsView>(`/programs/${ticketId}/registrations`),
  });

// ---- relevant registrations (CSM-entered, append-only) -------------------------------
export type RelevantEntry = {
  id: number;
  date: string;
  count: number;
  criteria: string | null;
  note: string | null;
  source: string;
  entered_by_name: string;
  entered_at: string;
  supersedes_id: number | null;
};
export type RelevantLog = { total: number; entries: RelevantEntry[] };
export const relevantQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "relevant"],
    queryFn: () => apiFetch<RelevantLog>(`/programs/${ticketId}/relevant-registrations`),
  });
export type RelevantBody = { count: number; criteria: string | null; note: string | null };
export const addRelevant = (ticketId: string, body: RelevantBody & { date: string }) =>
  sendJson<RelevantEntry>("POST", `/programs/${ticketId}/relevant-registrations`, body);
export const supersedeRelevant = (ticketId: string, id: number, body: RelevantBody) =>
  sendJson<RelevantEntry>(
    "POST",
    `/programs/${ticketId}/relevant-registrations/${id}/supersede`,
    body,
  );

// ---- target and campaign dates ----------------------------------------------------------
export type Targets = {
  target: number | null;
  campaign_start: string | null;
  campaign_end: string | null;
};
export const saveTargets = (ticketId: string, body: Targets) =>
  sendJson<Targets>("PUT", `/programs/${ticketId}/registrations/targets`, body);

// ---- sources and lift ------------------------------------------------------------------------
export type SourceBucket =
  "organic" | "organic_registered_before" | "referral" | "activity" | "unmatched";
export type SourceLine = {
  source_medium: string;
  campaign: string;
  users: number;
  share_pct: number;
  bucket: SourceBucket;
  activity_id: number | null;
  activity_code: string | null;
};
export type SourcesReport = {
  total: number;
  lines: SourceLine[];
  reconciles: boolean;
  organic_pct: number;
  matched_users: number;
  unmatched_users: number;
};
export type Sources = {
  fetched_at: string | null;
  stale: boolean;
  running: boolean;
  error: string | null;
  report: SourcesReport | null;
};
export const sourcesQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "sources"],
    queryFn: () => apiFetch<Sources>(`/programs/${ticketId}/sources`),
  });
export const refreshSources = (ticketId: string) =>
  sendJson<{ status: string }>("POST", `/programs/${ticketId}/sources/refresh`);

export type Lift = {
  activity_id: number;
  code: string;
  title: string;
  go_live_on: string;
  before_avg: number;
  after_avg: number;
  lift_pct: number | null;
};
export const liftQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "lift"],
    queryFn: () => apiFetch<Lift[]>(`/programs/${ticketId}/lift`),
  });
