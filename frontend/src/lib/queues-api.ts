// Queue-screen types and calls that ops-api.ts doesn't carry (it types queue items without their refs).
import { queryOptions } from "@tanstack/react-query";
import { apiFetch, sendJson } from "@/lib/api";
import type { CsmKind, Health, MarketingKind, QueueItem } from "@/lib/ops-api";

export type CsmItem = QueueItem<CsmKind> & { ref_type: string | null; ref_id: number | null };
export type MarketingItem = QueueItem<MarketingKind> & { activity_id: number };

export type PortfolioProgram = {
  ticket_id: string;
  name: string;
  client: string | null;
  stage: string;
  health: Health;
  registrations: number;
  target: number | null;
};
export const portfolioFullQuery = queryOptions({
  queryKey: ["portfolio", "full"],
  queryFn: () => apiFetch<{ programs: PortfolioProgram[] }>("/portfolio"),
});

export type OutboxRow = {
  id: number;
  kind: string;
  body: string;
  status: "queued" | "sent" | "failed" | "skipped";
  error: string | null;
  created_at: string;
  sent_at: string | null;
};
export const outboxQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "outbox"],
    queryFn: () => apiFetch<OutboxRow[]>(`/programs/${ticketId}/outbox`),
  });

export type MetricTotals = {
  views: number;
  clicks: number;
  sent: number;
  opens: number;
  ctr: number | null;
  open_rate: number | null;
};
export type ChannelMetrics = { channel: string; activities: number; totals: MetricTotals };
export const channelMetricsQuery = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "metrics", "channels"],
    queryFn: () => apiFetch<ChannelMetrics[]>(`/programs/${ticketId}/metrics/channels`),
  });

const act = (ticketId: string, id: number) => `/programs/${ticketId}/activities/${id}`;
export const goLiveAt = (ticketId: string, id: number, go_live_at: string | null) =>
  sendJson<unknown>("POST", `${act(ticketId, id)}/go-live`, go_live_at ? { go_live_at } : {});
export const nudgeActivity = (ticketId: string, id: number) =>
  sendJson<{ queued: boolean; recipients: string[] }>("POST", `${act(ticketId, id)}/nudge`);
export type MetricsEntry = {
  date: string;
  views?: number;
  clicks?: number;
  sent?: number;
  opens?: number;
};
export const putMetrics = (ticketId: string, id: number, body: MetricsEntry) =>
  sendJson<{ totals: MetricTotals }>("PUT", `${act(ticketId, id)}/metrics`, body);
export const addChannel = (ticketId: string, body: { channel: string; title: string }) =>
  sendJson<unknown>("POST", `/programs/${ticketId}/activities`, body);
