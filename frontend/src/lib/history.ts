import type { HistoryItem } from "@/lib/api";

/** HubSpot stores a multi-select checklist as "A;B;C". */
export const splitList = (value: string | null | undefined): string[] =>
  (value ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean);

export type HistoryLine = {
  /** The sentence, e.g. "Stage moved Onboarding → Ongoing". */
  text: string;
  /** Checklist items ticked / unticked by this change, shown as chips instead of one long string. */
  added: string[];
  removed: string[];
};

/** A HubSpot property change as one readable line. */
export function describeHistory(h: HistoryItem): HistoryLine {
  if (h.property_name === "hs_pipeline_stage") {
    return {
      text: `Stage moved ${h.old_value_label ?? "empty"} → ${h.new_value_label ?? "empty"}`,
      added: [],
      removed: [],
    };
  }
  const before = splitList(h.old_value);
  const after = splitList(h.new_value);
  const looksLikeChecklist = h.property_label.toLowerCase().includes("checklist");
  if (looksLikeChecklist || before.length > 1 || after.length > 1) {
    const added = after.filter((i) => !before.includes(i));
    const removed = before.filter((i) => !after.includes(i));
    return { text: `${h.property_label} updated`, added, removed };
  }
  return {
    text: `${h.property_label} changed ${h.old_value_label ?? "empty"} → ${h.new_value_label ?? "empty"}`,
    added: [],
    removed: [],
  };
}

// ---- audit log: sentences, day groups and collapsed runs ---------------------------------------------

export type LogEvent = {
  id: number;
  ticket_id: string | null;
  entity: string;
  entity_id: string;
  action: string;
  field: string | null;
  old: unknown;
  new: unknown;
  actor_name: string;
  at: string;
};

const NOUN: Record<string, string> = {
  activity: "activity",
  round: "round",
  rounds: "rounds",
  round_counts: "counts",
  checklist: "checklist",
  phase: "phase",
  dependency: "dependency",
  communication: "communication",
  timeline_change: "timeline change",
  update: "update",
  comment: "comment",
  note: "note",
  plan: "marketing plan",
  registrations: "registrations",
  registration_config: "registration settings",
  registration_targets: "registration targets",
  relevant_registrations: "relevant registrations",
  activity_metrics: "results",
  assignments: "assignments",
  redash_link: "Redash link",
  slack_link: "Slack link",
  hubspot_stage: "the ticket stage",
  hubspot_checklist: "a HubSpot checklist",
};
// Entities whose id is a small number worth quoting ("activity 52").
const NUMBERED = new Set([
  "activity",
  "round",
  "dependency",
  "communication",
  "timeline_change",
  "checklist",
]);
// Entities that hang off another object ("counts (round 4)").
const OWNER: Record<string, string> = { round_counts: "round", activity_metrics: "activity" };

const VERB: Record<string, string> = {
  approved: "approved",
  approval_withdrawn: "withdrew approval of",
  activated: "took live",
  activity_updated: "updated",
  status_changed: "changed the status of",
  round_added: "added",
  round_updated: "updated",
  round_deleted: "deleted",
  rounds_reordered: "reordered",
  counts_corrected: "corrected",
  counts_added: "recorded",
  checklist_created: "raised",
  item_confirmed: "confirmed an item on",
  request_updated: "updated",
  dependency_added: "added",
  dependency_updated: "updated",
  communication_planned: "planned",
  communication_updated: "updated",
  change_proposed: "proposed",
  change_approved: "approved",
  change_rejected: "rejected",
  task_done: "completed a task on",
  phase_status: "changed the status of",
  phase_updated: "updated",
  metrics_recorded: "recorded",
  channel_added: "added",
  plan_seeded: "seeded",
  note_added: "added",
  update_posted: "posted an",
  comment_posted: "posted a",
  entries_saved: "saved",
  entry_deleted: "deleted an entry in",
  targets_changed: "changed",
  config_changed: "changed",
  stage_moved: "moved",
  checklist_item_set: "changed",
  roles_changed: "changed roles of",
  permissions_changed: "changed permissions of",
  deactivated: "deactivated",
  invite_created: "invited",
  invite_resent: "re-issued the invite for",
  invite_revoked: "revoked the invite for",
  invite_deleted: "deleted the invite for",
  settings_changed: "changed portal settings",
};
const words = (s: string) => s.replace(/_/g, " ");
const STAGE_NAME: Record<string, string> = {
  new: "New",
  pre_sales: "Pre sales",
  onboarding: "Onboarding",
  ongoing: "Ongoing",
  post_campaign: "Post campaign",
  closed: "Closed",
};

/** The sentence without the person: "corrected counts (round 4)", "moved the ticket stage Onboarding → Ongoing". */
export function logSentence(e: LogEvent): string {
  if (e.action === "stage_moved" && typeof e.old === "string" && typeof e.new === "string")
    return `moved the ticket stage ${STAGE_NAME[e.old] ?? e.old} → ${STAGE_NAME[e.new] ?? e.new}`;
  if (e.action.endsWith("_refused"))
    return `tried to change HubSpot, but it was refused (${words(String((e.new as { code?: string } | null)?.code ?? "refused"))})`;
  const verb = VERB[e.action] ?? words(e.action);
  const noun = NOUN[e.entity] ?? words(e.entity);
  const owner = OWNER[e.entity];
  if (owner) return `${verb} ${noun} (${owner} ${e.entity_id})`;
  if (NUMBERED.has(e.entity) && /^\d+$/.test(e.entity_id)) return `${verb} ${noun} ${e.entity_id}`;
  return `${verb} ${noun}`;
}

export type LogEntry<T extends LogEvent> = {
  key: string;
  actor: string;
  at: string;
  events: T[]; // newest first; more than one when consecutive edits were collapsed
};
export type LogDay<T extends LogEvent> = { day: string; label: string; entries: LogEntry<T>[] };

const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
const dayKey = (at: string) =>
  IST_DAY.format(new Date(/[Zz]|[+-]\d{2}:\d{2}$/.test(at) ? at : `${at}Z`));

/**
 * Newest-first events grouped by day, with consecutive edits by the same person on the same object folded into
 * one entry ("csm1 updated activity 52 · 4 changes").
 */
export function groupLog<T extends LogEvent>(
  events: T[],
  dayLabel: (iso: string) => string,
): LogDay<T>[] {
  const days: LogDay<T>[] = [];
  for (const e of events) {
    const day = dayKey(e.at);
    let group = days[days.length - 1];
    if (!group || group.day !== day) {
      group = { day, label: dayLabel(day), entries: [] };
      days.push(group);
    }
    const last = group.entries[group.entries.length - 1];
    const head = last?.events[0];
    if (
      last &&
      head &&
      head.actor_name === e.actor_name &&
      head.entity === e.entity &&
      head.entity_id === e.entity_id &&
      head.action === e.action
    ) {
      last.events.push(e);
    } else {
      group.entries.push({ key: `${e.id}`, actor: e.actor_name, at: e.at, events: [e] });
    }
  }
  return days;
}
