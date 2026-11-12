import { useState, type MouseEvent, type ReactNode } from "react";
import { Chip, ReadinessDots } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { formatDay } from "@/lib/format";
import type { PlanActivity } from "@/lib/marketing-api";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, nextStep, todayIso } from "./shared";

const LABEL_COL = 96; // px: the channel names column, left of the plot

const dayNum = (iso: string) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
const isoOf = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);
/** The day an activity goes (or went) live, from the plan's own dates; null when nothing is dated. */
const dayOf = (a: PlanActivity) =>
  a.planned_date ?? (a.go_live_at ? a.go_live_at.slice(0, 10) : null);

/** "Tue, 4 Nov 2026". */
const longDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
/** "today", "in 3 days", "3 days ago". */
const relDay = (iso: string, today: string) => {
  const d = dayNum(iso) - dayNum(today);
  if (d === 0) return "today";
  const n = Math.abs(d);
  return d > 0 ? `in ${n} day${n === 1 ? "" : "s"}` : `${n} day${n === 1 ? "" : "s"} ago`;
};

/** What one activity is, when it goes live and what is still missing: shown on hover over a bar or a tray chip. */
function ActivityHover({
  a,
  today,
  children,
}: {
  a: PlanActivity;
  today: string;
  children: ReactNode;
}) {
  const day = dayOf(a);
  const off = a.comes_off_at ? a.comes_off_at.slice(0, 10) : null;
  const step = nextStep(a);
  return (
    <HoverCard openDelay={120} closeDelay={60}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-72 space-y-2.5 p-3.5">
        <div>
          <p className="text-[14px] font-medium leading-5">{a.title}</p>
          <p className="text-[12px] text-ink-2">
            <span className="font-mono">{a.code}</span> · {a.channel}
          </p>
        </div>
        <div className="space-y-0.5 text-[13px]">
          {day ? (
            <>
              <p className="font-medium">
                {a.status === "off"
                  ? "Came off "
                  : a.status === "live" && dayNum(day) <= dayNum(today)
                    ? "Live since "
                    : "Goes live "}
                {longDay(day)}
              </p>
              <p className="text-ink-2">
                {relDay(day, today)}
                {off && off !== day ? ` · comes off ${longDay(off)}` : ""}
              </p>
            </>
          ) : (
            <p className="text-ink-2">No go-live date yet. Click to open it, or use Set dates.</p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <Chip tone={a.status === "live" ? "good" : "neutral"}>{STATUS_LABEL[a.status]}</Chip>
          <ReadinessDots approval={!!a.approved_at} utm={!!a.utm} date={!!day} />
        </div>
        <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[12px]">
          <dt className="text-ink-2">UTM</dt>
          <dd className={cn("truncate", a.utm ? "font-mono" : "text-ink-2")}>{a.utm ?? "—"}</dd>
          <dt className="text-ink-2">Approval</dt>
          <dd className="truncate">
            {a.approved_at
              ? `${a.approved_by_name ?? "Approved"} · ${formatDay(a.approved_at.slice(0, 10))}`
              : "Waiting for the CSM"}
          </dd>
        </dl>
        {step.label && a.status !== "live" && (
          <p className="text-[12px] text-ink-2">
            Next: <span className="font-medium text-foreground">{step.label}</span>
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Go-live calendar: one lane per channel over every day the plan's own dates cover, from the earliest to the
 * latest. The columns are the schedule's own weeks (each from its first to its last dated activity, as the POA
 * groups them), not calendar weeks; a plan without week numbers falls back to 7-day spans from its first date.
 * Dated activities are bars, undated ones wait in the dashed "Not scheduled" tray.
 */
export function GoLiveCalendar({
  rows,
  allRows = rows,
  scope,
  selectedId,
  onSelect,
  onFill,
}: {
  rows: PlanActivity[];
  /** The whole plan: it fixes the calendar's dates and lanes, so picking a week only narrows what is drawn on it. */
  allRows?: PlanActivity[];
  /** What the rows are (All weeks, Week 2): shown in the title with how many there are. */
  scope?: string | undefined;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onFill?: (() => void) | undefined;
}) {
  const dated = rows.filter((a) => dayOf(a));
  const undated = rows.filter((a) => !dayOf(a));
  const today = todayIso();
  const planDays = allRows.filter((a) => dayOf(a)).map((a) => dayNum(dayOf(a)!));
  const start = planDays.length ? Math.min(...planDays) : dayNum(today);
  const end = planDays.length ? Math.max(...planDays) : start;
  const picked = dated.map((a) => dayNum(dayOf(a)!));
  // a week is picked: shade its own dates on the full-length calendar
  const band =
    rows.length < allRows.length && picked.length
      ? { from: Math.min(...picked) - start, to: Math.max(...picked) - start + 1 }
      : null;
  // The schedule's weeks: each column runs from a week's first dated activity to its last.
  const spans = new Map<number, [number, number]>();
  for (const a of allRows) {
    if (a.week == null || !dayOf(a)) continue;
    const d = dayNum(dayOf(a)!) - start;
    const s = spans.get(a.week);
    spans.set(a.week, s ? [Math.min(s[0], d), Math.max(s[1], d)] : [d, d]);
  }
  const scheduleCols = [...spans.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([w, [from, to]]) => ({ label: `Week ${w}`, from, to: to + 1 }));
  // only when the weeks follow one another; a plan whose weeks overlap in time keeps plain 7-day columns
  const bySchedule =
    scheduleCols.length > 0 &&
    scheduleCols.every((c, i) => i === 0 || c.from >= scheduleCols[i - 1]!.to);
  const days = bySchedule ? end - start + 1 : Math.max(3, Math.ceil((end - start + 1) / 7)) * 7;
  const cols = bySchedule
    ? scheduleCols
    : Array.from({ length: days / 7 }, (_, i) => ({
        label: formatDay(isoOf(start + i * 7)),
        from: i * 7,
        to: i * 7 + 7,
      }));
  const colStyle = (c: { from: number; to: number }) => ({
    left: `${(c.from / days) * 100}%`,
    width: `${((c.to - c.from) / days) * 100}%`,
  });
  const todayPct = ((dayNum(today) - start) / days) * 100;
  // lanes come from the whole plan, ordered by when each channel first goes live, so they never jump around
  const first = new Map<string, number>();
  for (const a of allRows) {
    const d = dayOf(a) ? dayNum(dayOf(a)!) : Infinity;
    first.set(a.channel, Math.min(first.get(a.channel) ?? Infinity, d));
  }
  const lanes = [...first.keys()].sort(
    (x, y) => first.get(x)! - first.get(y)! || x.localeCompare(y),
  );
  const liveCount = rows.filter((a) => a.status === "live").length;

  // The day column under the cursor: highlighted across every lane, with its date and go-live count.
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left - LABEL_COL;
    const w = r.width - LABEL_COL;
    setHoverDay(x < 0 || x >= w ? null : Math.floor((x / w) * days));
  };
  const hoverIso = hoverDay === null ? null : isoOf(start + hoverDay);
  const hoverCount = hoverIso ? dated.filter((a) => dayOf(a) === hoverIso).length : 0;

  const lanesLaid = lanes.map((ch) => {
    const items = dated
      .filter((a) => a.channel === ch)
      .map((a) => {
        const s = dayNum(dayOf(a)!);
        const e = a.comes_off_at ? Math.max(s, dayNum(a.comes_off_at.slice(0, 10))) : s;
        return { a, s, span: Math.max(1, e - s + 1) };
      })
      .sort((x, y) => x.s - y.s);
    const ends: number[] = []; // packing: a mark claims at least 3 days so labels do not collide
    const placed = items.map((it) => {
      let row = ends.findIndex((x) => x <= it.s);
      if (row < 0) row = ends.length;
      ends[row] = it.s + Math.max(3, it.span);
      return { ...it, row };
    });
    return { ch, placed, rowsN: Math.max(1, ends.length) };
  });

  return (
    <section className="surface" aria-label="Go-live calendar">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2 pt-3.5">
        <div className="flex-1">
          <h2 className="text-[14px] font-semibold leading-5">
            Go-live calendar
            {scope ? <span className="font-normal text-ink-2"> · {scope}</span> : null}
          </h2>
          <p className="text-[13px] text-ink-2 tabular-nums">
            {rows.length} {rows.length === 1 ? "activity" : "activities"} · {liveCount} live ·{" "}
            {dated.length - liveCount} scheduled · {undated.length} not scheduled
          </p>
        </div>
        <span className="text-[13px] text-ink-2">
          {formatDay(isoOf(start))} – {formatDay(isoOf(start + days - 1))} · today is{" "}
          {formatDay(today)}
        </span>
        <ul className="flex gap-3 text-[13px] text-ink-2">
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-4 rounded-[2px] bg-accent-fill" />
            Live
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2 w-4 rounded-[2px] bg-accent-bg ring-1 ring-primary/40"
            />
            Scheduled
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2 w-4 rounded-[2px] border border-dashed border-placeholder"
            />
            Not scheduled
          </li>
        </ul>
      </header>
      <div className="px-4 pb-4">
        {planDays.length > 0 && (
          <div className="relative overflow-x-auto">
            <div className="min-w-[560px]">
              <div className="grid grid-cols-[96px_minmax(0,1fr)]">
                <div />
                <div className="relative h-7 text-[12px] text-ink-2">
                  {cols.map((c) => (
                    <span
                      key={c.from}
                      className="absolute inset-y-0 truncate border-l border-border px-1.5 py-1"
                      style={colStyle(c)}
                      title={`${c.label}: ${formatDay(isoOf(start + c.from))} – ${formatDay(isoOf(start + c.to - 1))}`}
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
              </div>
              <div
                role="group"
                className="relative"
                onMouseMove={onMove}
                onMouseLeave={() => setHoverDay(null)}
                aria-label={`${liveCount} live, ${dated.length - liveCount} scheduled and ${undated.length} without a go-live date`}
              >
                {hoverDay !== null && hoverIso && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 z-[1] bg-primary/10"
                    style={{
                      left: `calc(${LABEL_COL}px + (100% - ${LABEL_COL}px) * ${hoverDay / days})`,
                      width: `calc((100% - ${LABEL_COL}px) / ${days})`,
                    }}
                  >
                    <span
                      className={cn(
                        "absolute -top-[26px] whitespace-nowrap rounded-[4px] bg-foreground px-1.5 py-0.5 text-[12px] font-medium text-background",
                        hoverDay / days > 0.75
                          ? "right-0"
                          : hoverDay / days < 0.2
                            ? "left-0"
                            : "left-1/2 -translate-x-1/2",
                      )}
                    >
                      {new Date(`${hoverIso}T00:00:00Z`).toLocaleDateString("en-GB", {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                        timeZone: "UTC",
                      })}
                      {hoverIso === today ? " · today" : ""}
                      {hoverCount > 0
                        ? ` · ${hoverCount} go-live${hoverCount === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </div>
                )}
                {lanesLaid.map(({ ch, placed, rowsN }) => (
                  <div
                    key={ch}
                    className="grid grid-cols-[96px_minmax(0,1fr)] border-t border-border"
                  >
                    <div className="truncate py-1.5 pr-2 text-[13px] text-ink-2" title={ch}>
                      {ch}
                    </div>
                    <div className="relative" style={{ height: rowsN * 28 + 6 }}>
                      {cols.map((c, i) => (
                        <div
                          key={c.from}
                          aria-hidden
                          className={cn("absolute inset-y-0", i % 2 === 0 && "bg-raised")}
                          style={colStyle(c)}
                        />
                      ))}
                      {band && (
                        <div
                          aria-hidden
                          className="absolute inset-y-0 bg-primary/10"
                          style={{
                            left: `${(band.from / days) * 100}%`,
                            width: `${((band.to - band.from) / days) * 100}%`,
                          }}
                        />
                      )}
                      {todayPct >= 0 && todayPct < 100 && (
                        <div
                          aria-hidden
                          className="absolute inset-y-0 w-px bg-primary"
                          style={{ left: `${todayPct}%` }}
                        />
                      )}
                      {placed.map(({ a, s, span, row }) => (
                        <ActivityHover key={a.id} a={a} today={today}>
                          <button
                            type="button"
                            onClick={() => onSelect(a.id)}
                            aria-label={`${a.title}, ${longDay(isoOf(s))}`}
                            aria-pressed={selectedId === a.id}
                            className={cn(
                              "absolute h-6 min-w-[28px] truncate rounded-[4px] px-1.5 text-left text-[12px] font-medium",
                              a.status === "live"
                                ? "bg-accent-fill text-on-accent"
                                : a.status === "off"
                                  ? "bg-chip text-ink-2"
                                  : "bg-accent-bg text-primary ring-1 ring-inset ring-primary/40",
                              selectedId === a.id &&
                                "outline outline-2 outline-offset-1 outline-primary",
                            )}
                            style={{
                              left: `${((s - start) / days) * 100}%`,
                              width: `max(${(span / days) * 100}%, 28px)`,
                              top: row * 28 + 3,
                              maxWidth: `${100 - ((s - start) / days) * 100}%`,
                            }}
                          >
                            {a.title}
                          </button>
                        </ActivityHover>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {undated.length > 0 && (
          <div className={cn("flex items-start gap-3", planDays.length > 0 && "mt-3.5")}>
            <p className="w-24 shrink-0 pt-0.5 text-[13px] text-ink-2">
              Not scheduled{" "}
              <b className="font-semibold tabular-nums text-foreground">{undated.length}</b>
            </p>
            <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {undated.map((a) => (
                <li key={a.id}>
                  <ActivityHover a={a} today={today}>
                    <button
                      type="button"
                      onClick={() => onSelect(a.id)}
                      className={cn(
                        "max-w-[220px] truncate rounded-[4px] border border-dashed border-placeholder px-2 py-0.5 text-[12px] text-ink-2 hover:bg-raised",
                        selectedId === a.id && "border-primary text-foreground",
                      )}
                    >
                      {a.title}
                    </button>
                  </ActivityHover>
                </li>
              ))}
            </ul>
            {onFill && (
              <Button variant="outline" size="sm" onClick={onFill}>
                Set dates
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
