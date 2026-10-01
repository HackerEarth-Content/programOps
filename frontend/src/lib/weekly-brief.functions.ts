import { API_BASE_URL, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

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

export async function fetchWeeklyBrief(days = 7): Promise<WeeklyBrief> {
  const response = await fetch(
    `${API_BASE_URL}/programs/analytics/weekly-brief?days=${days}`,
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new ApiError(
      `weekly-brief failed: ${response.status} ${response.statusText}`,
      response.status,
    );
  }
  return response.json() as Promise<WeeklyBrief>;
}

// Shown when generation fails (OpenAI outage, missing key, network error) so
// the dialog still demonstrates what a brief looks like instead of just an
// error state.
export function getDemoWeeklyBrief(): WeeklyBrief {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    generated_at: now.toISOString(),
    period_start: weekAgo.toISOString(),
    period_end: now.toISOString(),
    programs_covered: 6,
    stage_moves: 9,
    notes_logged: 4,
    headline: "Example brief: live generation unavailable",
    summary:
      "This is a sample layout. Once generation succeeds, this space shows a 2-4 sentence " +
      "summary of what actually happened across the portfolio this week.",
    highlights: [
      "CloudSprint Hackathon moved from Pre Sales to Onboarding after contract signoff.",
      "TalentForge Hiring Challenge closed its expected deal size discussion at $42K.",
    ],
    needs_attention: [
      "DevRise Hackathon has been in Onboarding for 2 weeks awaiting a kickoff date.",
    ],
    risks: [
      "GreenTech Challenge's account manager slot is still unassigned going into launch week.",
    ],
    next_week: [
      "Confirm kickoff date for DevRise Hackathon.",
      "Assign an account manager to GreenTech Challenge before its campaign starts.",
    ],
  };
}

export function formatWeeklyBriefForClipboard(brief: WeeklyBrief): string {
  const section = (title: string, items: string[]) =>
    items.length ? `${title}\n${items.map((item) => `- ${item}`).join("\n")}\n\n` : "";

  return (
    `${brief.headline}\n` +
    `${brief.programs_covered} programs covered since ${formatDateTime(brief.period_start)}\n\n` +
    `${brief.summary}\n\n` +
    section("Highlights", brief.highlights) +
    section("Needs attention", brief.needs_attention) +
    section("Risks", brief.risks) +
    section("Next week", brief.next_week)
  ).trim();
}
