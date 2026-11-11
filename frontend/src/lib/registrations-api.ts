import { useEffect, useRef, useState } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, sendJson, type Registrations } from "@/lib/api";

// GET /programs/{id}/registrations plus the two totals the backend keeps apart.
// `slack_paused`: the master Slack switch is off in the admin settings.
export type RegistrationsView = Registrations & {
  raw_total: number;
  relevant_total: number;
  slack_paused?: boolean;
};
export const registrationsViewQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "registrations"],
    queryFn: () => apiFetch<RegistrationsView>(`/programs/${ticketId}/registrations`),
  });

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

// ---- candidates: who registered (experience, city) and who meets the requirement --------------
export type CandidateRequirement = { yoe: string | null; cities: string[] }; // yoe: "2+" or "0-2"
export type YoeBand = { label: string; count: number; matching: number };
export type CityItem = {
  name: string;
  count: number;
  relevant: number;
  possibly: number;
  selected: boolean;
};
export type CandidateSnapshot = {
  fetched_at: string;
  requirement: CandidateRequirement;
  total: number;
  relevant: number;
  possibly: number; // city matches, experience not on the profile
  yoe: { unknown: number; bands: YoeBand[] };
  cities: { unknown: number; other: number; items: CityItem[] };
};
// While a refresh runs: where it is (waiting for a Redash worker, or running) and how long it has been going.
export type CandidateProgress = { phase: "starting" | "queued" | "running"; elapsed: number };
export type Candidates = {
  progress: CandidateProgress | null;
  requirement: CandidateRequirement;
  snapshot: CandidateSnapshot | null;
  outdated: boolean; // the requirement changed after this snapshot
  stale: boolean;
  error: string | null; // why the newest refresh failed; the snapshot is then the last good one
  running: boolean;
};
/** "0-0" -> "0 yrs (freshers)", "3-3" -> "3 yrs", "0-2" -> "0 to 2 yrs", "2+" -> "2+ yrs". */
export function yrs(yoe: string): string {
  const m = yoe.match(/^(\d+)(?:(\+)|-(\d+))$/);
  if (!m) return `${yoe} yrs`;
  const [lo, hi] = [Number(m[1]), m[3] == null ? null : Number(m[3])];
  if (m[2]) return `${lo}+ yrs`;
  if (hi === lo) return lo === 0 ? "0 yrs (freshers)" : `${lo} yrs`;
  return `${lo} to ${hi} yrs`;
}
export const candidatesQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "candidates"],
    queryFn: () => apiFetch<Candidates>(`/programs/${ticketId}/candidates`),
  });
/** One query for the tab, polled while a refresh runs; when one finishes the daily chart's relevant counts
 *  (rewritten on the server) are refetched too. */
export function useCandidates(ticketId: string, enabled: boolean) {
  const qc = useQueryClient();
  const q = useQuery({
    ...candidatesQuery(ticketId),
    enabled,
    refetchInterval: (s) => (s.state.data?.running ? 3000 : false),
  });
  const running = q.data?.running;
  const was = useRef(false);
  useEffect(() => {
    if (was.current && running === false)
      void qc.invalidateQueries({ queryKey: ["programs", ticketId, "registrations"] });
    was.current = !!running;
  }, [running, qc, ticketId]);
  return q;
}
export const saveRequirement = (ticketId: string, body: CandidateRequirement) =>
  sendJson<Candidates>("PUT", `/programs/${ticketId}/candidates/requirement`, body);
// "fresh": a snapshot for this event and requirement is under 5 minutes old, so nothing was fetched.
export type RefreshStatus = "started" | "already_running" | "fresh";
export const refreshCandidates = (ticketId: string) =>
  sendJson<{ status: RefreshStatus }>("POST", `/programs/${ticketId}/candidates/refresh`);

/** "Any experience · all cities", "0 yrs (freshers) · Bengaluru": the requirement as one short label. */
export function requirementLabel(r: CandidateRequirement): string {
  return `${r.yoe ? yrs(r.yoe) : "Any experience"} · ${r.cities.length ? r.cities.join(", ") : "all cities"}`;
}

/** Seconds a refresh has been running, ticking every second between the 3 s polls; null when none is running. */
export function useLiveElapsed(q: {
  data: Candidates | undefined;
  dataUpdatedAt: number;
}): number | null {
  const [now, setNow] = useState(() => Date.now());
  const active = !!q.data?.running && !!q.data.progress;
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  if (!active || !q.data?.progress) return null;
  return Math.max(0, Math.floor(q.data.progress.elapsed + (now - q.dataUpdatedAt) / 1000));
}

/** The status line for a running refresh (null when none is). A real run takes about a minute. */
export function progressText(c: Candidates, seconds: number | null): string | null {
  if (!c.running) return null;
  const s = seconds ?? c.progress?.elapsed ?? 0;
  const phase = c.progress?.phase;
  const base =
    phase === "starting"
      ? "Contacting Redash…"
      : phase === "queued"
        ? "Waiting in the Redash queue…"
        : phase === "running"
          ? `Redash is running the query · ${s}s (usually about a minute)`
          : "Refreshing…";
  return phase && s > 120
    ? `${base} Taking longer than usual. It will finish in the background; you can leave this page.`
    : base;
}

// ---- the requirement being edited (shared by the dialog and the "use this event" step) ----
export type Mode = "any" | "exact" | "min" | "range";

/** The requirement being edited. mode "none" = nothing chosen yet (the confirm step makes the person choose). */
export type ReqDraft = { mode: Mode | "none"; a: string; b: string; cities: string[] };
export const EMPTY_DRAFT: ReqDraft = { mode: "none", a: "", b: "", cities: [] };

/** "0-0" / "3-3" -> Exactly, "2+" -> At least, "0-2" -> Between. */
function parseYoe(yoe: string | null): { mode: Mode; a: string; b: string } {
  const min = yoe?.match(/^(\d+)\+$/);
  if (min) return { mode: "min", a: min[1]!, b: "" };
  const range = yoe?.match(/^(\d+)-(\d+)$/);
  if (range) {
    return range[1] === range[2]
      ? { mode: "exact", a: range[1]!, b: "" }
      : { mode: "range", a: range[1]!, b: range[2]! };
  }
  return { mode: "any", a: "", b: "" };
}

export const draftFrom = (req: CandidateRequirement): ReqDraft => ({
  ...parseYoe(req.yoe),
  cities: req.cities,
});

const validYears = (s: string) => /^\d{1,2}$/.test(s) && Number(s) <= 40;

/**
 * The guided inputs -> the form the server accepts: "N-N" (exactly N, 0 = freshers), "N+" (at least N, N >= 1: "0+" would
 * mean no requirement), "N-M". null = any experience (an explicit choice); undefined = nothing chosen, incomplete or not allowed.
 */
export function draftYoe(d: ReqDraft): string | null | undefined {
  if (d.mode === "none") return undefined;
  if (d.mode === "any") return null;
  if (!validYears(d.a)) return undefined;
  if (d.mode === "exact") return `${Number(d.a)}-${Number(d.a)}`;
  if (d.mode === "min") return Number(d.a) >= 1 ? `${Number(d.a)}+` : undefined;
  if (!validYears(d.b)) return undefined;
  const [lo, hi] = [Number(d.a), Number(d.b)].sort((x, y) => x - y);
  return `${lo}-${hi}`;
}
