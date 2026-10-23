import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { Health } from "@/lib/ops-api";

// Mirrors backend core/report.py PortfolioOut.
export type PortfolioProgram = {
  ticket_id: string;
  name: string;
  client: string | null;
  stage: string;
  health: Health;
  reasons: string[];
  marketing_live: number;
  marketing_total: number;
  awaiting_approval: number;
  registrations: number;
  target: number | null;
  on_target: boolean | null;
  open_items: number; // this program's items in the CSM queue
};
export type PortfolioActionItems = {
  control_breaches: number;
  pending_approvals: number;
  missing_utm: number;
};
export type Portfolio = {
  active_programs: number;
  health: Record<Health, number>;
  registrations_total: number;
  target_total: number | null;
  stage_distribution: Record<string, number>;
  programs_with_target: number;
  programs_on_target: number;
  open_items: number; // the CSM queue's items across every open program
  action_items: PortfolioActionItems;
  programs: PortfolioProgram[];
};
export const portfolioFullQuery = queryOptions({
  queryKey: ["portfolio", "full"],
  queryFn: () => apiFetch<Portfolio>("/portfolio"),
  refetchInterval: 60_000,
});

// Mirrors backend hubspot_client/weekly_brief.py.
export type WeeklyBrief = {
  generated_at: string;
  period_start: string;
  period_end: string;
  programs_covered: number;
  stage_moves: number;
  notes_logged: number;
  headline: string;
  summary: string;
  highlights: string[];
  needs_attention: string[];
  risks: string[];
  next_week: string[];
};
// Generated on demand, never on page load: each one costs model tokens (the server keeps it 30 minutes).
export const weeklyBrief = (days: number, refresh: boolean) =>
  apiFetch<WeeklyBrief>(
    `/programs/analytics/weekly-brief?days=${days}${refresh ? "&refresh=true" : ""}`,
  );
