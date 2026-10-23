import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { apiFetch, sendJson, ROLE_LABELS, type UserRole } from "@/lib/api";

export const SECTIONS = ["users", "roles", "audit", "settings"] as const;
export type Section = (typeof SECTIONS)[number];
export const parseSection = (v: unknown): Section => SECTIONS.find((s) => s === v) ?? "users";

// ---- role defaults (mirrors backend/core/permissions.py ROLE_DEFAULTS) -----------------------

const BASE = ["program.view", "audit.view", "comment.add", "request.create"];
export const ROLE_DEFAULTS: Record<UserRole, readonly string[]> = {
  super_admin: [...BASE, "request_types.edit", "users.manage", "settings.edit"],
  csm: [
    ...BASE,
    "update.post",
    "activity.edit",
    "activity.add_channel",
    "activity.approve",
    "metrics.enter",
    "relevant.enter",
    "registrations.manage",
    "rounds.edit",
    "counts.enter",
    "request.manage",
    "request_types.edit",
    "hubspot.write",
    "integrations.link",
    "program.create",
  ],
  marketing: [...BASE, "update.post", "activity.edit", "activity.add_channel", "metrics.enter"],
  account_manager: BASE,
  viewer: ["program.view"],
};
export const ROLES = Object.keys(ROLE_LABELS) as UserRole[];

export const roleDefaults = (roles: UserRole[]): Set<string> =>
  new Set(roles.flatMap((r) => [...ROLE_DEFAULTS[r]]));

export const PERMISSION_GROUPS: { title: string; keys: string[] }[] = [
  {
    title: "View & comment",
    keys: ["program.view", "audit.view", "comment.add", "request.create", "update.post"],
  },
  {
    title: "Marketing",
    keys: [
      "activity.edit",
      "activity.add_channel",
      "activity.approve",
      "metrics.enter",
      "relevant.enter",
    ],
  },
  {
    title: "Registrations & rounds",
    keys: ["registrations.manage", "rounds.edit", "counts.enter"],
  },
  {
    title: "Requests & HubSpot",
    keys: [
      "request.manage",
      "request_types.edit",
      "hubspot.write",
      "integrations.link",
      "program.create",
    ],
  },
  { title: "Administration", keys: ["users.manage", "settings.edit"] },
];

// ---- portal settings -------------------------------------------------------------------------

export type PortalSettings = {
  reminders: {
    reminder_time: string | null;
    work_start: string;
    work_end: string;
    work_days: number[];
    timezone: string;
  };
  redash_sync_time: string | null;
  retention_days: number | null;
};
export const settingsQuery = queryOptions({
  queryKey: ["admin", "settings"],
  queryFn: () => apiFetch<PortalSettings>("/admin/settings"),
});
export const saveSettings = (body: PortalSettings) =>
  sendJson<PortalSettings>("PUT", "/admin/settings", body);

// ---- audit log -------------------------------------------------------------------------------

export type AuditRow = {
  id: number;
  ticket_id: string | null;
  entity: string;
  entity_id: string;
  action: string;
  field: string | null;
  old: unknown;
  new: unknown;
  actor_id: string | null;
  actor_name: string;
  at: string;
};
export type AuditPage = { items: AuditRow[]; next_before: number | null };
export type AuditFilters = { entity: string; actor: string; ticket: string };

export const globalAuditQuery = (f: AuditFilters) =>
  infiniteQueryOptions({
    queryKey: ["admin", "audit", f],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "50" });
      if (f.entity) p.set("entity", f.entity);
      if (f.actor) p.set("actor_id", f.actor);
      if (f.ticket.trim()) p.set("ticket_id", f.ticket.trim());
      if (pageParam !== null) p.set("before", String(pageParam));
      return apiFetch<AuditPage>(`/audit?${p}`);
    },
    getNextPageParam: (last) => last.next_before,
  });

export const AUDIT_ENTITIES = [
  "user",
  "invite",
  "settings",
  "rounds",
  "round",
  "activity",
  "communication",
  "registrations",
  "checklist",
  "timeline_change",
  "hubspot_stage",
  "note",
  "assignments",
];

const VERBS: Record<string, string> = {
  roles_changed: "changed roles of",
  permissions_changed: "changed permissions of",
  activated: "reactivated",
  deactivated: "deactivated",
  invite_created: "pre-granted access to",
  invite_revoked: "revoked the pre-granted access of",
  invite_deleted: "deleted the pre-granted access of",
  settings_changed: "changed portal settings",
  stage_moved: "moved the stage of",
  status_changed: "changed the status of",
  note_added: "added a note on",
  created: "created",
  approved: "approved",
  round_added: "added a round to",
  round_deleted: "removed a round from",
  round_updated: "updated a round of",
};
const humanize = (s: string) => s.replace(/_/g, " ");

/** "Priya changed roles of a@b.com" style sentence (without the actor, which is its own column). */
export function describeEvent(e: AuditRow, userName: (id: string) => string | undefined): string {
  const verb = VERBS[e.action] ?? humanize(e.action);
  let target = "";
  if (e.ticket_id) target = `program ${e.ticket_id}`;
  else if (e.entity === "user") target = userName(e.entity_id) ?? "a user";
  else if (e.entity === "invite")
    target = (e.new as { email?: string } | null)?.email ?? "an invite";
  else if (e.entity !== "settings") target = humanize(e.entity);
  return [verb, target, e.field && e.entity !== "user" ? `(${humanize(e.field)})` : ""]
    .filter(Boolean)
    .join(" ");
}

export function showValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
