import { queryOptions } from "@tanstack/react-query";
import { apiFetch, sendJson } from "@/lib/api";

export type SystemStatus = {
  hubspot_synced_at: string | null;
  redash_registrations_synced_at: string | null;
  sources_fetched_at: string | null;
  outbox_queued: number;
  outbox_failed: number;
  hubspot_writeback_enabled: boolean;
};
export const systemStatusQuery = queryOptions({
  queryKey: ["system", "status"],
  queryFn: () => apiFetch<SystemStatus>("/system/status"),
  refetchInterval: 60_000,
});

export type SearchHit = {
  ticket_id: string;
  name: string;
  client: string | null;
  stage: string;
  csm: string | null;
};
export const searchQuery = (q: string) =>
  queryOptions({
    queryKey: ["search", q],
    queryFn: () => apiFetch<SearchHit[]>(`/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });

// Writes to the live HubSpot ticket. Callers must confirm with the person first (see HubspotConfirm).
export const stageKey = (label: string) => label.toLowerCase().replace(/ /g, "_");
export const setHubspotChecklistItem = (
  ticketId: string,
  body: { stage_key: string; item: string; done: boolean; expected: string[] },
) => sendJson<{ selected: string[] }>("POST", `/programs/${ticketId}/hubspot/checklist`, body);
export const moveHubspotStage = (
  ticketId: string,
  body: { stage_key: string; expected_stage_key: string },
) =>
  sendJson<{ stage_key: string; stage_label: string }>(
    "POST",
    `/programs/${ticketId}/hubspot/stage`,
    body,
  );
