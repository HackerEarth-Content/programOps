import { queryOptions } from "@tanstack/react-query";

export const API_BASE_URL = import.meta.env["VITE_API_BASE_URL"] ?? "http://localhost:8000";
// Frontend navigates here directly (not fetch) so the backend's CSRF cookie
// is set as a first-party cookie -- see backend api/auth_routes.py.
export const GOOGLE_LOGIN_URL = `${API_BASE_URL}/api/auth/google/login`;

export const STAGES = [
  "New",
  "Pre Sales",
  "Onboarding",
  "Ongoing",
  "Post Campaign",
  "Closed",
] as const;
export type Stage = (typeof STAGES)[number];

export type Program = {
  ticket_id: string;
  subject: string;
  stage: Stage;
  campaign_type: string | null;
  event_name: string | null;
  platform_details: string | null;
  blackops_account_name: string | null;
  company_name: string | null;
  expected_deal_size: number | null;
  registrations?: number | null; // total registrations so far (list endpoint only)
  owner_name: string | null;
  account_manager_name: string | null;
  csm_name: string | null;
  content_poc_name: string | null;
  created_at: string | null;
  last_modified_at: string | null;
};

export type StageFunnelEntry = { stage: Stage; count: number };
export type ChecklistStatus = {
  ticket_id: string;
  subject: string;
  stage: Stage;
  completed_items: string[];
  derived_items: string[]; // done because of an uploaded document, not a HubSpot tick
  pending_items: string[];
};
export type CampaignTypeCount = { campaign_type: string; count: number };
export type EventCount = { event_name: string; stage: Stage; count: number };

export type HistoryItem = {
  property_name: string;
  property_label: string;
  old_value: string | null;
  new_value: string | null;
  old_value_label: string | null;
  new_value_label: string | null;
  changed_at: string;
  source_type: string | null;
  changed_by_user_id: number | null;
  changed_by_name: string | null;
};

export type Note = {
  note_id: string;
  body: string;
  author_user_id: number | null;
  author_name: string | null;
  source: "hubspot" | "programops";
  created_at: string;
};

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(path: string): Promise<T> {
  // credentials: "include" -- the cookie session is set by the backend on a
  // different port (8000 vs 5173), so it needs to be explicitly sent cross-port.
  const response = await fetch(`${API_BASE_URL}${path}`, { credentials: "include" });
  if (!response.ok) {
    throw new ApiError(
      `${path} failed: ${response.status} ${response.statusText}`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

export type UserRole = "account_manager" | "csm" | "manager" | "other";

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole | null;
  is_active: boolean;
};

// Returns null on 401 (signed out) instead of throwing, so a plain useQuery
// can represent "not signed in" as data rather than an error state.
export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const response = await fetch(`${API_BASE_URL}/users/me`, { credentials: "include" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`GET /users/me failed: ${response.status}`);
  return response.json() as Promise<CurrentUser>;
}

export const currentUserQueryOptions = queryOptions({
  queryKey: ["auth", "me"],
  queryFn: fetchCurrentUser,
});

export async function updateUserRole(role: UserRole): Promise<CurrentUser> {
  const response = await fetch(`${API_BASE_URL}/users/me`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!response.ok) throw new Error(`Failed to save role: ${response.status}`);
  return response.json() as Promise<CurrentUser>;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE_URL}/api/auth/logout`, { method: "POST", credentials: "include" });
}

type SyncStatus = { running: boolean; error: string | null };

async function runSync(path: string): Promise<void> {
  const start = await fetch(`${API_BASE_URL}${path}`, { method: "POST", credentials: "include" });
  if (!start.ok) throw new Error(`Sync failed: ${start.status}`);
  const { status } = (await start.json()) as { status: "started" | "already_running" | "cooldown" };
  if (status === "cooldown") return; // one just finished -- the data is already fresh

  for (let attempt = 0; attempt < 150; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = await apiFetch<SyncStatus>(`${path}/status`);
    if (!current.running) {
      if (current.error) throw new Error(current.error);
      return;
    }
  }
  throw new Error("Sync is taking longer than expected -- it will finish in the background.");
}

// HubSpot tickets (auto every 10 min) and Redash registrations (auto every 6 h): both can be
// forced from the header. The backend answers 202 immediately; these poll until it finishes.
export const syncPrograms = () => runSync("/programs/sync");
export const syncRegistrations = () => runSync("/programs/redash/sync");

export const programsQueryOptions = queryOptions({
  queryKey: ["programs"],
  queryFn: () => apiFetch<Program[]>("/programs"),
});

export const programQueryOptions = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId],
    queryFn: () => apiFetch<Program>(`/programs/${ticketId}`),
  });

export const stageFunnelQueryOptions = queryOptions({
  queryKey: ["programs", "analytics", "stage-funnel"],
  queryFn: () => apiFetch<StageFunnelEntry[]>("/programs/analytics/stage-funnel"),
});

export const checklistStatusQueryOptions = queryOptions({
  queryKey: ["programs", "analytics", "checklist-status"],
  queryFn: () => apiFetch<ChecklistStatus[]>("/programs/analytics/checklist-status"),
});

export const campaignTypesQueryOptions = queryOptions({
  queryKey: ["programs", "analytics", "campaign-types"],
  queryFn: () => apiFetch<CampaignTypeCount[]>("/programs/analytics/campaign-types"),
});

export const eventsQueryOptions = queryOptions({
  queryKey: ["programs", "analytics", "events"],
  queryFn: () => apiFetch<EventCount[]>("/programs/analytics/events"),
});

export const historyQueryOptions = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "history"],
    queryFn: () => apiFetch<HistoryItem[]>(`/programs/${ticketId}/history`),
  });

export const notesQueryOptions = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "notes"],
    queryFn: () => apiFetch<Note[]>(`/programs/${ticketId}/notes`),
  });

// Local-only comment (see backend api/program_routes.py's create_program_note
// docstring for why this doesn't write through to HubSpot).
export async function createNote(
  ticketId: string,
  body: string,
  authorName: string,
): Promise<Note> {
  const response = await fetch(`${API_BASE_URL}/programs/${ticketId}/notes`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, author_name: authorName }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(
      detail?.detail ? String(detail.detail) : `Failed to save note: ${response.status}`,
    );
  }
  return response.json() as Promise<Note>;
}

// ---- Registrations + Slack ----------------------------------------------------

export type RegistrationEntry = {
  id: number;
  date: string;
  role: string;
  registrations: number;
  relevant: number | null; // null = unknown (Redash-sourced days carry registrations only)
  extra: Record<string, string>;
};
export type SlackSettings = {
  channel_id: string | null;
  channel_name: string | null;
  notify: boolean;
};
export type RedashSettings = {
  auto: boolean;
  event_slug: string | null;
  event_name: string | null;
  configured: boolean;
};
export type RedashEvent = {
  slug: string;
  name: string | null;
  type: string | null;
  company: string | null;
  start?: string | null;
  end?: string | null;
  live: boolean;
};
export type RedashCheck = { event: RedashEvent };
export type RegistrationEstimate = {
  start: string | null;
  end: string | null; // real event end when known, else start + the SOW's stated weeks
  end_min: string | null;
  end_is_actual: boolean;
  weeks_min: number | null;
  weeks_max: number | null;
  target: number | null;
  start_source: "event" | "hubspot" | "first entry" | "POA window" | null;
};
export type Registrations = {
  estimate: RegistrationEstimate;
  roles: string[];
  fields: string[];
  entries: RegistrationEntry[];
  slack: SlackSettings;
  slack_configured: boolean;
  redash: RedashSettings;
};

export const registrationsQueryOptions = (ticketId: string) =>
  queryOptions({
    queryKey: ["programs", ticketId, "registrations"],
    queryFn: () => apiFetch<Registrations>(`/programs/${ticketId}/registrations`),
  });

// JSON write helper; surfaces the backend's `detail` message (e.g. Slack errors).
async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(
      typeof detail?.detail === "string" ? detail.detail : `Request failed: ${response.status}`,
    );
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

const regPath = (ticketId: string) => `/programs/${ticketId}`;
export type SaveResult = { saved: number; slack: { sent: boolean; error: string | null } };
export const saveRegistrations = (ticketId: string, entries: Omit<RegistrationEntry, "id">[]) =>
  sendJson<SaveResult>("POST", `${regPath(ticketId)}/registrations`, { entries });
export const deleteRegistration = (ticketId: string, id: number) =>
  sendJson<void>("DELETE", `${regPath(ticketId)}/registrations/${id}`);
export const saveRegistrationConfig = (ticketId: string, roles: string[], fields: string[]) =>
  sendJson<{ roles: string[]; fields: string[] }>(
    "PUT",
    `${regPath(ticketId)}/registrations/config`,
    { roles, fields },
  );
export const lookupSlackChannel = (ticketId: string, channelId: string) =>
  apiFetch<{ channel_id: string; channel_name: string }>(
    `${regPath(ticketId)}/slack/lookup?channel_id=${encodeURIComponent(channelId)}`,
  );
export const saveSlack = (
  ticketId: string,
  body: { channel_id?: string | null; notify?: boolean },
) => sendJson<SlackSettings>("PUT", `${regPath(ticketId)}/slack`, body);
export const saveRedash = (ticketId: string, body: { auto?: boolean; event_slug?: string }) =>
  sendJson<RedashSettings>("PUT", `${regPath(ticketId)}/registrations/redash`, body);
export const checkRedash = (ticketId: string, event_slug: string) =>
  sendJson<RedashCheck>("POST", `${regPath(ticketId)}/registrations/redash/check`, { event_slug });
export const runRedash = (ticketId: string) =>
  sendJson<SaveResult>("POST", `${regPath(ticketId)}/registrations/redash/run`);
export const testSlack = (ticketId: string) =>
  sendJson<{ sent: boolean }>("POST", `${regPath(ticketId)}/slack/test`);

// HubSpot's campaign_type values are "Hackathon" and "Coding Challenge"; the latter is
// the hiring programme (role-wise registrations, "relevant" counts).
export const HIRING_CAMPAIGN_TYPE = "Coding Challenge";
export const previewSlackMessage = (ticketId: string, entries: Omit<RegistrationEntry, "id">[]) =>
  sendJson<{ text: string; channel_name: string | null }>(
    "POST",
    `${regPath(ticketId)}/registrations/preview`,
    { entries },
  );
