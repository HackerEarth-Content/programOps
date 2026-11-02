// Small pure helpers shared by the marketing tab, its detail panel and the bulk UTM dialog.
import type { PlanActivity } from "@/lib/marketing-api";
import type { ActivityStatus } from "@/lib/ops-api";

export const STATUS_LABEL: Record<ActivityStatus, string> = {
  not_started: "Not started",
  wip: "In progress",
  live: "Live",
  off: "Done",
};

export const errText = (e: unknown) => (e instanceof Error ? e.message : "Action failed");
export const weekKey = (a: PlanActivity) => String(a.week ?? "none");
export const weekLabel = (k: string) => (k === "none" ? "Unscheduled" : `Week ${k}`);
export const todayIso = () => new Date().toISOString().slice(0, 10);
/** Go-live dates run from today to 60 days out (the backend enforces the same window). */
export const maxGoLiveIso = () => new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);

/** Not live or done yet, and still missing approval, a UTM or a go-live date. */
export const isBlocked = (a: PlanActivity) =>
  a.status !== "off" && a.status !== "live" && (!a.approved_at || !a.utm || !a.planned_date);
/** Approval, UTM and go-live date are all in place. */
export const isReady = (a: PlanActivity) => !!a.approved_at && !!a.utm && !!a.planned_date;

export type NextStep = { label: string; tone: "good" | "warning" | "neutral" };
/** The one thing an activity needs next (replaces three "missing" chips per row). */
export function nextStep(a: PlanActivity): NextStep {
  if (a.status === "live") return { label: "Live", tone: "good" };
  if (a.status === "off") return { label: "Done", tone: "neutral" };
  if (!a.approved_at) return { label: "Needs approval", tone: "warning" };
  if (!a.utm) return { label: "Needs UTM", tone: "warning" };
  if (!a.planned_date) return { label: "Needs date", tone: "warning" };
  return { label: "Ready", tone: "good" };
}

/** UTMs compare case-insensitively. */
export const utmKey = (s: string) => s.trim().toLowerCase();

/** "dd/mm/yyyy", "dd-mm-yyyy" or "yyyy-mm-dd" to ISO; null when it is not a real date. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  const m =
    /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s) ?? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] =
    s.includes("-") && m[1]!.length === 4 ? [m[1]!, m[2]!, m[3]!] : [m[3]!, m[2]!, m[1]!];
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso;
}

export type SheetRow = { id: string; utm: string; date: string };

function splitLine(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if ((ch === "," || ch === ";") && !q) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * Rows pasted from a sheet or read from a CSV: activity id, UTM, go-live date. A header row (as in this tab's
 * own CSV export) maps the columns by name; otherwise the order is id, UTM, date.
 */
export function parseSheet(text: string): SheetRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let [iId, iUtm, iDate] = [0, 1, 2];
  const first = lines[0] ? splitLine(lines[0]) : [];
  if (first.some((c) => /^(code|id|activity id)$/i.test(c))) {
    iId = first.findIndex((c) => /^(code|id|activity id)$/i.test(c));
    iUtm = first.findIndex((c) => /utm/i.test(c));
    iDate = first.findIndex((c) => /date/i.test(c));
    lines.shift();
  }
  return lines.map((l) => {
    const c = splitLine(l);
    return {
      id: c[iId] ?? "",
      utm: iUtm < 0 ? "" : (c[iUtm] ?? ""),
      date: iDate < 0 ? "" : (c[iDate] ?? ""),
    };
  });
}
