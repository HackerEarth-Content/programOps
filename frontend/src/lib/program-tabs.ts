export const PROGRAM_TABS = [
  { id: "overview", label: "Overview" },
  { id: "marketing", label: "Marketing" },
  { id: "registrations", label: "Registrations" },
  { id: "rounds", label: "Rounds" },
  { id: "requests", label: "Requests & updates" },
  { id: "documents", label: "Documents" },
  { id: "activity", label: "Activity" },
] as const;
export type ProgramTab = (typeof PROGRAM_TABS)[number]["id"];

export const parseTab = (value: unknown): ProgramTab =>
  PROGRAM_TABS.find((t) => t.id === value)?.id ?? "overview";

// The program tab where a queue item gets resolved.
const TAB_BY_KIND: Record<string, ProgramTab> = {
  go_live_due: "marketing",
  ready_to_go_live: "marketing",
  missing_utm_or_proof: "marketing",
  awaiting_approval: "marketing",
  results_to_record: "marketing",
  control_breach: "marketing",
  approval_waiting: "marketing",
  counts_missing: "rounds",
  request_due: "requests",
  update_due: "requests",
  slack_unlinked: "registrations",
};
export const tabFor = (kind: string): ProgramTab => TAB_BY_KIND[kind] ?? "overview";
