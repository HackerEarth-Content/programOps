import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Bar,
  Chip,
  EmptyState,
  KpiCell,
  KpiStrip,
  Notice,
  ReadinessDots,
  Skeleton,
} from "@/components/kit";
import { BulkUtmDialog } from "@/components/marketing/bulk-utm";
import { GoLiveCalendar } from "@/components/marketing/calendar";
import { ActivityDetail } from "@/components/marketing/detail";
import {
  errText,
  isBlocked,
  isReady,
  maxGoLiveIso,
  nextStep,
  STATUS_LABEL,
  todayIso,
  weekKey,
  weekLabel,
} from "@/components/marketing/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { registrationsQueryOptions, useCan } from "@/lib/api";
import { formatDay, formatRange } from "@/lib/format";
import {
  assignmentsQuery,
  addChannel,
  ConflictError,
  nudgeActivity,
  nudgeAllForApproval,
  patchPlanActivity,
  planQuery,
  possibleDuplicates,
  rereadPlan,
  type ChannelInput,
  type PlanActivity,
  type RereadResult,
} from "@/lib/marketing-api";
import { activitySummaryQuery, type ActivityStatus } from "@/lib/ops-api";
import { cn } from "@/lib/utils";

const FILTER_TRIGGER =
  "h-8 w-auto min-w-[140px] gap-2 rounded-[6px] border-border bg-card px-2.5 text-[13px] shadow-none";
// 5 columns when there is room beside the 380px panel; below that each row is two lines.
const ROW_COLS = "min-[1360px]:grid-cols-[minmax(0,1fr)_84px_160px_100px_124px]";

const hashId = () => {
  const m = /^#a=(\d+)$/.exec(window.location.hash);
  return m ? Number(m[1]) : null;
};
const sortWeeks = (a: [string, unknown], b: [string, unknown]) => {
  if (a[0] === "none") return 1;
  if (b[0] === "none") return -1;
  return Number(a[0]) - Number(b[0]);
};
const earliest = (items: PlanActivity[]) =>
  items
    .map((i) => i.planned_date)
    .filter((d): d is string => !!d)
    .sort()[0] ?? null;

/** True from the `lg` breakpoint up, where the detail panel sits beside the list instead of in a sheet. */
function useWide() {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mql.matches);
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, []);
  return wide;
}

export function ProgramMarketing({ ticketId }: { ticketId: string }) {
  const qc = useQueryClient();
  const plan = useQuery(planQuery(ticketId));
  const summary = useQuery(activitySummaryQuery(ticketId));
  const regs = useQuery(registrationsQueryOptions(ticketId)).data;
  const csm =
    useQuery(assignmentsQuery(ticketId)).data?.find((p) => p.role === "csm")?.name ?? null;
  const canEdit = useCan("activity.edit");
  const canReread = useCan("integrations.link"); // the backend gates plan re-read on this, not on activity.edit
  const canApprove = useCan("activity.approve");
  const canAdd = useCan("activity.add_channel");
  const wide = useWide();

  const [selectedId, setSelectedId] = useState<number | null>(hashId);
  const [week, setWeek] = useState("all");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ActivityStatus>("all");
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [channel, setChannel] = useState("all");
  const [adding, setAdding] = useState(false);
  const [bulkUtm, setBulkUtm] = useState(false);
  const [banner, setBanner] = useState<RereadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const select = (id: number | null) => {
    setSelectedId(id);
    window.history.replaceState(
      null,
      "",
      id === null ? window.location.pathname + window.location.search : `#a=${id}`,
    );
  };

  const reload = () => qc.invalidateQueries({ queryKey: ["programs", ticketId] });
  const run = useMutation({
    mutationFn: ({ fn }: { id: number; fn: () => Promise<unknown> }) => fn(),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: () => {
      void reload();
      void qc.invalidateQueries({ queryKey: ["audit"] });
      toast.success("Saved");
    },
    onError: (e) => {
      if (e instanceof ConflictError) {
        void reload();
        setNotice(`${e.message} The plan was reloaded with the latest values.`);
      } else setError(errText(e));
    },
  });
  const pendingId = run.isPending ? run.variables.id : null;
  const act = (id: number, fn: () => Promise<unknown>) => run.mutate({ id, fn });

  const reread = useMutation({
    mutationFn: () => rereadPlan(ticketId),
    onMutate: () => setError(null),
    onSuccess: (r) => {
      setBanner(r);
      void reload();
    },
    onError: (e) => setError(errText(e)),
  });
  const nudgeAll = useMutation({
    mutationFn: () => nudgeAllForApproval(ticketId),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (r) =>
      setNotice(
        r.queued
          ? `Asked ${r.recipients.join(", ")} in Slack to approve.`
          : "Nudge recorded, but the program has no Slack channel linked.",
      ),
    onError: (e) => setError(errText(e)),
  });

  const rows = useMemo(() => plan.data ?? [], [plan.data]);
  const duplicates = useMemo(() => possibleDuplicates(rows), [rows]);
  const channels = useMemo(() => [...new Set(rows.map((r) => r.channel))].sort(), [rows]);
  const weekCards = useMemo(() => {
    const m = new Map<string, PlanActivity[]>();
    rows.forEach((r) => m.set(weekKey(r), [...(m.get(weekKey(r)) ?? []), r]));
    return [...m.entries()].sort(sortWeeks);
  }, [rows]);
  const q = query.trim().toLowerCase();
  // the calendar follows the week rail (search / status filters only narrow the list below it)
  const calendarRows = useMemo(
    () => (week === "all" ? rows : rows.filter((r) => weekKey(r) === week)),
    [rows, week],
  );
  const visible = rows.filter(
    (r) =>
      (week === "all" || weekKey(r) === week) &&
      (channel === "all" || r.channel === channel) &&
      (statusFilter === "all" || r.status === statusFilter) &&
      (!blockedOnly || isBlocked(r)) &&
      (!q || [r.title, r.channel, r.utm, r.code].some((x) => x?.toLowerCase().includes(q))),
  );
  const groups = useMemo(() => {
    const m = new Map<string, PlanActivity[]>();
    visible.forEach((r) => m.set(weekKey(r), [...(m.get(weekKey(r)) ?? []), r]));
    return [...m.entries()].sort(sortWeeks);
  }, [visible]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  if (plan.isLoading) return <PlanSkeleton />;
  if (plan.isError)
    return (
      <EmptyState
        icon={<AlertTriangle />}
        title="Could not load the marketing plan"
        hint={errText(plan.error)}
        action={
          <Button size="sm" variant="outline" onClick={() => void plan.refetch()}>
            Retry
          </Button>
        }
      />
    );

  const s = summary.data;
  const total = s?.total ?? rows.length;
  const nLive = s?.live ?? rows.filter((r) => r.status === "live").length;
  const nApproved = s?.approved ?? rows.filter((r) => r.approved_at).length;
  const nUtm = rows.filter((a) => a.utm).length;
  const nDate = rows.filter((a) => a.planned_date).length;
  const pct = (n: number) => (total ? (100 * n) / total : 0);
  const regEnd = regs?.estimate.end ?? null;
  const regClosed = regEnd !== null && regEnd < todayIso();
  // `end` is only the real close date when it is known (linked event or CSM override); otherwise it is the start
  // plus the SOW's registration weeks, so it must be worded as an expectation, not as a fact.
  const regLabel = !regs?.estimate.end_is_actual
    ? "after the expected registration end"
    : regClosed
      ? "after registration closed"
      : "after registration closes";
  const blocked = rows.filter(isBlocked);
  const unapproved = blocked.filter((a) => !a.approved_at).length;
  const noUtm = blocked.filter((a) => !a.utm).length;
  const noDate = blocked.filter((a) => !a.planned_date).length;
  const afterClose = regEnd ? blocked.filter((a) => a.planned_date && a.planned_date > regEnd) : [];
  const who = csm ?? "the CSM";
  const needs = [
    unapproved > 0 && `${unapproved} the CSM's approval`,
    noUtm > 0 && `${noUtm} a UTM`,
    noDate > 0 && `${noDate} a go-live date`,
  ].filter(Boolean);

  const feedback = (
    <>
      {notice && (
        <Dismissable tone="warn" onDismiss={() => setNotice(null)}>
          {notice}
        </Dismissable>
      )}
      {error && (
        <Dismissable tone="danger" onDismiss={() => setError(null)}>
          {error}
        </Dismissable>
      )}
    </>
  );
  const detail = selected && (
    <ActivityDetail
      key={selected.id}
      ticketId={ticketId}
      a={selected}
      csm={csm}
      busy={pendingId === selected.id}
      canApprove={canApprove}
      canEdit={canEdit}
      onClose={wide ? () => select(null) : undefined}
      feedback={feedback}
      act={(fn) => act(selected.id, fn)}
      onNudge={() =>
        act(selected.id, async () => {
          const r = await nudgeActivity(ticketId, selected.id);
          setNotice(
            r.queued
              ? `Nudged ${r.recipients.join(", ")} in Slack.`
              : "Nudge recorded, but the program has no Slack channel.",
          );
        })
      }
    />
  );

  return (
    <div className="space-y-4">
      <KpiStrip label="Launch readiness">
        <KpiCell label="Live" value={nLive} unit={`of ${total}`} pct={pct(nLive)} />
        <KpiCell
          label="Approved by the CSM"
          value={nApproved}
          unit={`of ${total}`}
          pct={pct(nApproved)}
        />
        <KpiCell label="UTM set" value={nUtm} unit={`of ${total}`} pct={pct(nUtm)} />
        <KpiCell label="Go-live date set" value={nDate} unit={`of ${total}`} pct={pct(nDate)} />
      </KpiStrip>

      {blocked.length > 0 && (
        <Notice
          actions={
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBlockedOnly(true);
                  setWeek("all");
                }}
              >
                Show them
              </Button>
              {canEdit && (noUtm > 0 || noDate > 0) && (
                <Button variant="outline" size="sm" onClick={() => setBulkUtm(true)}>
                  Fill UTMs and dates
                </Button>
              )}
              {canEdit && unapproved > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={nudgeAll.isPending}
                  onClick={() => nudgeAll.mutate()}
                >
                  Remind {who} in Slack
                </Button>
              )}
            </>
          }
        >
          <b>
            {blocked.length} {blocked.length === 1 ? "activity" : "activities"} can't go live yet.
          </b>{" "}
          Still waiting on {needs.join(", ")}.
          {afterClose.length > 0 &&
            ` ${afterClose.length === blocked.length ? "All" : afterClose.length} start ${regLabel} (${formatDay(regEnd)}).`}
        </Notice>
      )}

      {banner && (
        <Dismissable tone="ok" onDismiss={() => setBanner(null)}>
          <b>Plan synced:</b> {banner.added} new rows added, {banner.removed} removed,{" "}
          {banner.edits_kept} custom edits kept intact.
        </Dismissable>
      )}
      {!selected && feedback}

      {rows.length > 0 && (
        <div className="hidden md:block">
          <GoLiveCalendar
            rows={calendarRows}
            allRows={rows}
            scope={week === "all" ? "All weeks" : weekLabel(week)}
            selectedId={selectedId}
            onSelect={select}
            onFill={
              canEdit && rows.some((a) => !a.planned_date && isBlocked(a))
                ? () => setBulkUtm(true)
                : undefined
            }
          />
        </div>
      )}

      {rows.length > 0 && (
        <div
          role="group"
          aria-label="Weeks"
          className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 md:mx-0 md:grid md:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] md:overflow-visible md:px-0 md:pb-0"
        >
          {[["all", rows] as [string, PlanActivity[]], ...weekCards].map(([k, items]) => {
            const n = items.filter(isReady).length;
            const from = k === "all" ? null : earliest(items);
            return (
              <button
                key={k}
                type="button"
                aria-pressed={week === k}
                onClick={() => setWeek(k)}
                className={cn(
                  "w-[140px] shrink-0 rounded-lg border px-3 py-2.5 text-left md:w-auto",
                  week === k
                    ? "border-primary bg-accent-bg"
                    : "border-border bg-card hover:bg-raised",
                )}
              >
                <p className="text-[14px] font-medium">
                  {k === "all" ? "All weeks" : weekLabel(k)}
                </p>
                <p className="text-[12px] text-ink-2">
                  {k === "all"
                    ? `${items.length} activities · `
                    : from
                      ? `from ${formatDay(from)} · `
                      : ""}
                  {n} of {items.length} ready
                </p>
                <Bar
                  pct={items.length ? (100 * n) / items.length : 0}
                  className="mt-2"
                  label={`${k === "all" ? "All weeks" : weekLabel(k)} ready`}
                />
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          className="w-full sm:w-60"
          placeholder="Search title, channel or UTM"
          aria-label="Search activities"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select value={channel} onValueChange={setChannel}>
          <SelectTrigger aria-label="Channel" className={FILTER_TRIGGER}>
            <SelectValue>Channel: {channel === "all" ? "All" : channel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            {channels.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as "all" | ActivityStatus)}
        >
          <SelectTrigger aria-label="Status" className={FILTER_TRIGGER}>
            <SelectValue>
              Status: {statusFilter === "all" ? "Any" : STATUS_LABEL[statusFilter]}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            {(Object.keys(STATUS_LABEL) as ActivityStatus[]).map((st) => (
              <SelectItem key={st} value={st}>
                {STATUS_LABEL[st]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex cursor-pointer items-center gap-2 text-[14px] text-ink-2">
          <Checkbox checked={blockedOnly} onCheckedChange={(v) => setBlockedOnly(v === true)} />
          Blocked only
        </label>
        <div className="flex-1" />
        {canReread && (
          <Button variant="ghost" disabled={reread.isPending} onClick={() => reread.mutate()}>
            Re-read plan
          </Button>
        )}
        <Button
          variant="outline"
          disabled={visible.length === 0}
          onClick={() => exportCsv(visible)}
        >
          Export CSV
        </Button>
        {canAdd && <Button onClick={() => setAdding(true)}>Add activity</Button>}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No marketing plan yet"
          hint="It is read from the plan of action once one is attached in HubSpot."
        />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section aria-label="Activities" className="surface min-w-0 overflow-hidden">
            <div
              className={cn(
                "hidden gap-3 border-b border-border px-4 py-2.5 text-[13px] text-ink-2 min-[1360px]:grid",
                ROW_COLS,
              )}
            >
              <span>Activity</span>
              <span>Go-live</span>
              <span>UTM campaign</span>
              <span>Ready</span>
              <span>Next step</span>
            </div>
            {groups.length === 0 && (
              <p className="px-4 py-8 text-center text-[14px] text-ink-2">
                No activities match these filters.
              </p>
            )}
            {groups.map(([wk, items]) => {
              const from = earliest(items);
              const dates = items
                .map((i) => i.planned_date)
                .filter((d): d is string => !!d)
                .sort();
              const late =
                !!regEnd &&
                items.some(
                  (i) =>
                    i.status !== "live" &&
                    i.status !== "off" &&
                    !!i.planned_date &&
                    i.planned_date > regEnd,
                );
              return (
                <div key={wk}>
                  {week === "all" && (
                    <div className="flex flex-wrap items-baseline gap-x-2 border-b border-border bg-raised px-4 py-2 text-[13px]">
                      <b className="font-semibold">{weekLabel(wk)}</b>
                      <span className="text-ink-2">
                        {from ? `${formatRange(dates[0], dates[dates.length - 1])} · ` : ""}
                        {items.length} {items.length === 1 ? "activity" : "activities"}
                      </span>
                      {late && (
                        <span className="ml-auto text-warn">
                          Starts {regLabel} · {formatDay(regEnd)}
                        </span>
                      )}
                    </div>
                  )}
                  {items.map((a) => (
                    <ActivityRow
                      key={a.id}
                      a={a}
                      selected={selectedId === a.id}
                      duplicate={duplicates.has(a.id)}
                      onSelect={() => select(a.id === selectedId ? null : a.id)}
                    />
                  ))}
                </div>
              );
            })}
            <div className="flex flex-wrap justify-between gap-2 px-4 py-2.5 text-[13px] text-ink-2">
              <span>
                Showing {visible.length} of {rows.length} planned activities
              </span>
              <span className="hidden sm:inline">Approval · UTM · go-live date</span>
            </div>
          </section>

          {wide && (
            <aside
              aria-label="Activity details"
              className="surface min-w-0 lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto"
            >
              {detail || (
                <div className="p-4">
                  <p className="font-medium">Select an activity</p>
                  <p className="mt-1 text-[13px] text-ink-2">
                    Open a row to approve it, set its UTM and go-live date, add creative proof, log
                    results and read its history.
                  </p>
                </div>
              )}
            </aside>
          )}
        </div>
      )}

      {!wide && (
        <Sheet open={!!selected} onOpenChange={(o) => !o && select(null)}>
          <SheetContent
            side="bottom"
            className="max-h-[88vh] gap-0 overflow-y-auto rounded-t-xl p-0 pr-0"
          >
            <SheetTitle className="sr-only">{selected?.title ?? "Activity details"}</SheetTitle>
            <SheetDescription className="sr-only">
              Approve the activity, set its UTM and go-live date, and save.
            </SheetDescription>
            <div className="pt-4 pr-6">{detail}</div>
          </SheetContent>
        </Sheet>
      )}

      <AddChannelDialog
        open={adding}
        onOpenChange={setAdding}
        channels={channels}
        onAdd={async (body) => {
          const a = await addChannel(ticketId, body);
          await reload();
          select(a.id);
        }}
      />
      <BulkUtmDialog
        open={bulkUtm}
        onOpenChange={setBulkUtm}
        rows={blocked.filter((a) => !a.utm || !a.planned_date)}
        allRows={rows}
        onSave={async (entries) => {
          const failed: string[] = [];
          for (const [a, body] of entries) {
            try {
              await patchPlanActivity(ticketId, a, body);
            } catch (e) {
              failed.push(`${a.title}: ${errText(e)}`);
            }
          }
          await reload();
          void qc.invalidateQueries({ queryKey: ["audit"] });
          if (failed.length) {
            toast.warning(`Saved ${entries.length - failed.length} of ${entries.length}`);
            throw new Error(`Not saved — ${failed.join("; ")}`);
          }
          toast.success(
            `Saved ${entries.length} ${entries.length === 1 ? "activity" : "activities"}`,
          );
        }}
      />
    </div>
  );
}

/** A quiet notice with a Dismiss button (reread result, conflicts, errors). */
function Dismissable({
  tone,
  children,
  onDismiss,
}: {
  tone: "ok" | "warn" | "danger";
  children: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div role={tone === "danger" ? "alert" : "status"}>
      <Notice
        tone={tone}
        actions={
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        }
      >
        {children}
      </Notice>
    </div>
  );
}

function PlanSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-[88px]" />
      <Skeleton className="h-12" />
      <Skeleton className="h-[200px]" />
      <Skeleton className="h-[360px]" />
    </div>
  );
}

function ActivityRow({
  a,
  selected,
  duplicate,
  onSelect,
}: {
  a: PlanActivity;
  selected: boolean;
  duplicate: boolean;
  onSelect: () => void;
}) {
  const step = nextStep(a);
  const overdue =
    !!a.planned_date && a.planned_date < todayIso() && a.status !== "live" && a.status !== "off";
  const date = a.planned_date ? (
    <span
      className={cn(overdue && "font-medium text-danger")}
      title={overdue ? "Overdue" : undefined}
    >
      {formatDay(a.planned_date)}
      {overdue && <span className="sr-only"> (overdue)</span>}
    </span>
  ) : (
    <span className="text-ink-3">—</span>
  );
  const utm = a.utm ? (
    <span className="font-mono text-[12px]">{a.utm}</span>
  ) : (
    <span className="text-ink-3">—</span>
  );
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left text-[14px] min-[1360px]:grid",
        ROW_COLS,
        selected ? "bg-selected" : "hover:bg-raised",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {a.breach && (
            <TriangleAlert
              className="size-4 shrink-0 text-danger"
              aria-label="Live without approval"
            />
          )}
          <span className="truncate font-medium">{a.title}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-ink-2">
          <span className="font-mono text-[12px]">{a.code}</span>
          <span>· {a.channel}</span>
          <span className="min-[1360px]:hidden">· {date}</span>
          <span className="min-w-0 truncate min-[1360px]:hidden">· {utm}</span>
          {duplicate && <span className="text-primary">· Possible duplicate</span>}
          {a.not_in_poa && <span className="text-warn">· Not in the latest POA</span>}
        </span>
      </span>
      <span className="hidden tabular-nums min-[1360px]:block">{date}</span>
      <span className="hidden min-w-0 truncate min-[1360px]:block">{utm}</span>
      <span className="hidden min-[1360px]:block">
        <ReadinessDots approval={!!a.approved_at} utm={!!a.utm} date={!!a.planned_date} />
      </span>
      <span className="shrink-0">
        <Chip tone={step.tone}>{step.label}</Chip>
      </span>
    </button>
  );
}

function AddChannelDialog({
  open,
  onOpenChange,
  channels,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  channels: string[];
  onAdd: (b: ChannelInput) => Promise<void>;
}) {
  const empty = {
    channel: "",
    title: "",
    week: "",
    planned_date: "",
    audience: "",
    outcome: "",
    hook: "",
  };
  const [f, setF] = useState(empty);
  const add = useMutation({
    mutationFn: () =>
      onAdd({
        channel: f.channel.trim(),
        title: f.title.trim(),
        week: f.week ? Number(f.week) : null,
        planned_date: f.planned_date || null,
        audience: f.audience.trim() || null,
        outcome: f.outcome.trim() || null,
        hook: f.hook.trim() || null,
      }),
    onSuccess: () => {
      setF(empty);
      onOpenChange(false);
    },
  });
  const field = (
    k: keyof typeof empty,
    label: string,
    props: Partial<ComponentProps<typeof Input>> = {},
  ) => (
    <label className="block space-y-1 text-[14px] text-ink-2">
      {label}
      <Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} />
    </label>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add activity</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <datalist id="plan-channels">
            {channels.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          {field("channel", "Channel", {
            required: true,
            list: "plan-channels",
            placeholder: "e.g. Email",
          })}
          {field("title", "Activity", { required: true })}
          <div className="grid grid-cols-2 gap-3">
            {field("week", "Week", { type: "number", min: 1 })}
            {field("planned_date", "Go-live date", {
              type: "date",
              min: todayIso(),
              max: maxGoLiveIso(),
            })}
          </div>
          {field("audience", "Target segment")}
          {field("outcome", "Outcome")}
          {field("hook", "Hook / description")}
          {add.isError && (
            <p role="alert" className="text-[14px] text-danger">
              {errText(add.error)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? "Adding…" : "Add activity"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function exportCsv(rows: PlanActivity[]) {
  const cols: [string, (a: PlanActivity) => string | number | null][] = [
    ["code", (a) => a.code],
    ["week", (a) => a.week],
    ["channel", (a) => a.channel],
    ["activity", (a) => a.title],
    ["audience", (a) => a.audience],
    ["outcome", (a) => a.outcome],
    ["status", (a) => a.status],
    ["approved_by", (a) => a.approved_by_name],
    ["approved_at", (a) => a.approved_at],
    ["go_live_date", (a) => a.planned_date],
    ["utm", (a) => a.utm],
    ["breach", (a) => (a.breach ? "yes" : "no")],
  ];
  const esc = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [
    cols.map(([h]) => h).join(","),
    ...rows.map((a) => cols.map(([, g]) => esc(g(a))).join(",")),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = Object.assign(document.createElement("a"), {
    href: url,
    download: "marketing_plan.csv",
  });
  link.click();
  URL.revokeObjectURL(url);
}
