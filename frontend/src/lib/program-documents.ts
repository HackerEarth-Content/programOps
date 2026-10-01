import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

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
  start: string;
  end: string | null;
  open_ended: boolean;
};
export type PoaChannel = "Email" | "Social" | "Community" | "Newsletter" | "Partner";
export type PoaActivity = {
  date: string;
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
  contacts: { name: string; role: string; contact: string; side: string }[];
  sla: { audience: string; hours: string; response: string }[];
};

export type PoaDetails = {
  title: string;
  window_start: string;
  window_end: string;
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
