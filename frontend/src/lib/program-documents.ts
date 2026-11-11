import { queryOptions } from "@tanstack/react-query";
import { API_BASE_URL, apiFetch } from "@/lib/api";

// Shapes mirror backend hubspot_client/documents.py (schema-validated extraction).
export type DocFile = {
  file_name: string;
  url: string;
  size_bytes: number;
  uploaded_at: string | null;
  hubspot_property: string;
};
export type Milestone = {
  task: string;
  owner: string;
  start: string | null; // null = the SOW gives this stage no date
  end: string | null;
  open_ended: boolean;
};
export type PoaChannel = "Email" | "Social" | "Community" | "Newsletter" | "Partner";
export type PoaActivity = {
  date: string | null; // null = the document gave no date (never guessed)
  week: string;
  channel: PoaChannel;
  activity: string;
  objective: string;
  description: string;
};

export type SowDetails = {
  title: string;
  customer: string;
  order_date: string;
  validity: string;
  fee: string;
  fee_amount_inr: number | null;
  payment_terms: string;
  exclusions: string;
  objective: string;
  services: string[];
  commitments: { label: string; value: string }[];
  rounds: { name: string; details: string[] }[];
  content: string[];
  client_requirements: { item: string; details: string }[];
  reports: { type: string; frequency: string }[];
  timeline: Milestone[];
  registration_window_weeks_min: number | null;
  registration_window_weeks_max: number | null;
  registration_target: number | null;
  contacts: { name: string; role: string; contact: string; side: string }[];
  sla: { audience: string; hours: string; response: string }[];
};

export type PoaDetails = {
  title: string;
  window_start: string | null;
  window_end: string | null;
  activities: PoaActivity[];
};

export type ProgramDocument<D> = {
  file: DocFile;
  status: "ok" | "failed";
  error: string | null;
  details: D | null;
};

export type ProgramDocuments = {
  sow: ProgramDocument<SowDetails> | null;
  poa: ProgramDocument<PoaDetails> | null;
};

export type DocKind = "sow" | "poa";

export const programDocumentsQueryOptions = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "documents"],
    queryFn: () => apiFetch<ProgramDocuments>(`/programs/${ticketId}/documents`),
  });

export type DueItem = {
  ticket_id: string;
  subject: string;
  kind: DocKind;
  title: string;
  date: string;
  owner: string;
};

export const dueTodayQueryOptions = (on: string) =>
  queryOptions({
    queryKey: ["programs", "analytics", "due-today", on],
    queryFn: () => apiFetch<DueItem[]>(`/programs/analytics/due-today?on=${on}`),
  });

// ---- replacing a document from the portal ------------------------------------------------------------

export const DOC_LABEL: Record<DocKind, string> = {
  sow: "Statement of Work",
  poa: "Plan of Action",
};
export const MIN_COMMENT = 10;
export const MAX_COMMENT = 1000;

export type DocVersion = {
  id: number;
  kind: DocKind;
  source: "app" | "hubspot"; // uploaded in ProgramOps, or picked up from a change made in HubSpot
  status: "ok" | "failed";
  file_name: string | null;
  size_bytes: number | null;
  comment: string | null;
  error: string | null;
  uploaded_by_name: string | null;
  created_at: string;
};

export type PlanChange = {
  added: number;
  removed: number;
  updated: number;
  flagged: number;
  edits_kept: number;
};
export type UploadResult = { version: DocVersion; plan: PlanChange | null; hubspot_note: boolean };

export const documentVersionsQueryOptions = (ticketId: string, kind: DocKind) =>
  queryOptions({
    queryKey: ["programs", ticketId, "documents", kind, "versions"],
    queryFn: () => apiFetch<DocVersion[]>(`/programs/${ticketId}/documents/${kind}/versions`),
  });

/** Multipart upload (sendJson is JSON-only). Surfaces the server's reason, e.g. "couldn't be read". */
export async function uploadDocument(
  ticketId: string,
  kind: DocKind,
  file: File,
  comment: string,
): Promise<UploadResult> {
  const body = new FormData();
  body.append("file", file);
  body.append("comment", comment);
  const response = await fetch(`${API_BASE_URL}/programs/${ticketId}/documents/${kind}`, {
    method: "POST",
    credentials: "include",
    body, // no Content-Type header: the browser sets the multipart boundary
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(
      typeof detail?.detail === "string" ? detail.detail : `Upload failed: ${response.status}`,
    );
  }
  return response.json() as Promise<UploadResult>;
}

/** One line for what a new POA did to the marketing plan. */
export function planChangeText(plan: PlanChange): string {
  const parts = [
    plan.added && `${plan.added} added`,
    plan.updated && `${plan.updated} updated`,
    plan.removed && `${plan.removed} removed`,
    plan.flagged &&
      `${plan.flagged} edited ${plan.flagged === 1 ? "row" : "rows"} no longer in the POA (kept, please review)`,
  ].filter(Boolean);
  const kept = plan.edits_kept
    ? ` ${plan.edits_kept} you edited ${plan.edits_kept === 1 ? "was" : "were"} left as is.`
    : "";
  return parts.length
    ? `Marketing plan: ${parts.join(", ")}.${kept}`
    : `Marketing plan unchanged.${kept}`;
}
