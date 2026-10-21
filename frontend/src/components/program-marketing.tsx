import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";
import { Chip, EmptyState, Skeleton, StatusDot } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { registrationsQueryOptions, useCan } from "@/lib/api";
import { formatDay, formatRange, formatWhen, safeUrl } from "@/lib/format";
import {
  activityAuditQuery,
  addChannel,
  assignmentsQuery,
  ConflictError,
  metricsQuery,
  nudgeActivity,
  nudgeAllForApproval,
  patchPlanActivity,
  planQuery,
  possibleDuplicates,
  putMetrics,
  rereadPlan,
  type ActivityMetrics,
  type ChannelInput,
  type PlanActivity,
  type RereadResult,
} from "@/lib/marketing-api";
import {
  activitySummaryQuery,
  approveActivity,
  goLive,
  withdrawApproval,
  type ActivityStatus,
  type AuditEvent,
} from "@/lib/ops-api";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<ActivityStatus, string> = {
  not_started: "Not started",
  wip: "In progress",
  live: "Live",
  off: "Off",
};
const SELECT_CLS =
  "h-9 rounded-[8px] border border-border bg-surface px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
const FIELD_CLS = "bg-raised";
const GRID = "grid grid-cols-[minmax(0,2.4fr)_minmax(0,1.6fr)_110px_150px_110px] gap-4";

const errText = (e: unknown) => (e instanceof Error ? e.message : "Action failed");
const hashId = () => {
  const m = /^#a=(\d+)$/.exec(window.location.hash);
  return m ? Number(m[1]) : null;
};
const weekKey = (a: PlanActivity) => String(a.week ?? "none");
const weekLabel = (k: string) => (k === "none" ? "Unscheduled" : `Week ${k}`);
const todayIso = () => new Date().toISOString().slice(0, 10);

/** The week to open first: the one that contains today, else the next one, else the first. */
function currentWeek(groups: [string, PlanActivity[]][]): string | null {
  const today = todayIso();
  const spans = groups.map(([k, items]) => {
    const dates = items
      .map((i) => i.planned_date)
      .filter((d): d is string => !!d)
      .sort();
    return { k, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
  });
  return (
    spans.find((s) => s.from && s.to && s.from <= today && today <= s.to)?.k ??
    spans.find((s) => s.from && s.from > today)?.k ??
    groups[0]?.[0] ??
    null
  );
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

  const [selectedId, setSelectedId] = useState<number | null>(hashId);
  const [week, setWeek] = useState("all");
  const [dupOnly, setDupOnly] = useState(false);
  const [channel, setChannel] = useState("all");
  const [open, setOpen] = useState<Record<string, boolean> | null>(null);
  const [adding, setAdding] = useState(false);
  const [bulkUtm, setBulkUtm] = useState(false);
  const [banner, setBanner] = useState<RereadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inspector = useRef<HTMLElement>(null);

  const select = (id: number | null) => {
    setSelectedId(id);
    window.history.replaceState(
      null,
      "",
      id === null ? window.location.pathname + window.location.search : `#a=${id}`,
    );
    if (id !== null && window.innerWidth < 1024)
      setTimeout(
        () => inspector.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
        50,
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
  const weekCounts = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r) => m.set(weekKey(r), (m.get(weekKey(r)) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => {
      if (a[0] === "none") return 1;
      if (b[0] === "none") return -1;
      return Number(a[0]) - Number(b[0]);
    });
  }, [rows]);
  const visible = rows.filter(
    (r) =>
      (week === "all" || weekKey(r) === week) &&
      (!dupOnly || duplicates.has(r.id)) &&
      (channel === "all" || r.channel === channel),
  );
  const groups = useMemo(() => {
    const m = new Map<string, PlanActivity[]>();
    visible.forEach((r) => m.set(weekKey(r), [...(m.get(weekKey(r)) ?? []), r]));
    return [...m.entries()].sort((a, b) => {
      if (a[0] === "none") return 1;
      if (b[0] === "none") return -1;
      return Number(a[0]) - Number(b[0]);
    });
  }, [visible]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const defaultOpen = useMemo(() => currentWeek(groups), [groups]);
  const isOpen = (k: string) =>
    week !== "all" ? true : open ? (open[k] ?? false) : k === defaultOpen;

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
  const regEnd = regs?.estimate.end ?? null;
  const regClosed = regEnd !== null && regEnd < todayIso();
  const blocked = rows.filter(
    (a) => a.status !== "off" && a.status !== "live" && (!a.approved_at || !a.utm),
  );
  const unapproved = blocked.filter((a) => !a.approved_at).length;
  const noUtm = blocked.filter((a) => !a.utm).length;
  const afterClose = regEnd ? blocked.filter((a) => a.planned_date && a.planned_date > regEnd) : [];
  const withUtm = rows.filter((a) => a.utm).length;
  const who = csm ?? "the CSM";
  const toggleWeek = (k: string) =>
    setOpen((cur) => {
      const base = cur ?? Object.fromEntries(groups.map(([g]) => [g, g === defaultOpen]));
      return { ...base, [k]: !(base[k] ?? false) };
    });

  return (
    <div className="space-y-5">
      <section
        aria-label="Marketing summary"
        className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3"
      >
        <StatTile
          label="Live"
          value={`${s?.live ?? 0} / ${s?.total ?? 0}`}
          note={s && s.live > 0 ? `${s.live} running` : "Nothing running yet"}
        />
        <StatTile
          label="Approved"
          value={`${s?.approved ?? 0} / ${s?.total ?? 0}`}
          warn={!!s && s.total > 0 && s.approved === 0}
          note={
            s && s.total > 0 && s.approved === 0
              ? `All waiting on ${who}`
              : `${s?.approved ?? 0} signed off`
          }
        />
        <StatTile
          label="Missing UTM"
          value={String(rows.length - withUtm)}
          note={`${withUtm} have a UTM`}
        />
        <StatTile
          label="Possible duplicates"
          value={String(duplicates.size)}
          note="Same channel and name, overlapping dates"
        />
      </section>

      {blocked.length > 0 && (
        <section className="flex flex-wrap items-center gap-3 rounded-[12px] bg-warn-bg px-4 py-3.5">
          <TriangleAlert aria-hidden className="size-[18px] shrink-0 text-warn" />
          <div className="min-w-0 flex-[1_1_400px]">
            <p className="font-medium">
              {blocked.length} {blocked.length === 1 ? "activity" : "activities"} can't go live yet
            </p>
            <p className="text-[13px] text-ink-2">
              {unapproved === blocked.length
                ? `Each needs ${who}'s approval`
                : `${unapproved} need ${who}'s approval`}
              {noUtm > 0 && ` and ${noUtm === blocked.length ? "also " : ""}${noUtm} need a UTM`}
              {". "}
              {regClosed && afterClose.length > 0
                ? afterClose.length === blocked.length
                  ? `All of them start after registration closed on ${formatDay(regEnd)}.`
                  : `${afterClose.length} start after registration closed on ${formatDay(regEnd)}.`
                : ""}
            </p>
          </div>
          {canEdit && noUtm > 0 && (
            <Button variant="outline" onClick={() => setBulkUtm(true)}>
              Add UTMs in bulk
            </Button>
          )}
          {canEdit && unapproved > 0 && (
            <Button
              variant="outline"
              disabled={nudgeAll.isPending}
              onClick={() => nudgeAll.mutate()}
            >
              Nudge {who}
            </Button>
          )}
        </section>
      )}

      {banner && (
        <Notice tone="ok" onDismiss={() => setBanner(null)}>
          <b>Plan synced:</b> {banner.added} new rows added, {banner.removed} removed,{" "}
          {banner.edits_kept} custom edits kept intact.
        </Notice>
      )}
      {notice && (
        <Notice tone="warn" onDismiss={() => setNotice(null)}>
          {notice}
        </Notice>
      )}
      {error && (
        <Notice tone="danger" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="Filter by week"
          className="flex gap-0.5 rounded-[10px] bg-raised p-[3px]"
        >
          {[
            ["all", "All", rows.length] as const,
            ...weekCounts.map(([k, n]) => [k, weekLabel(k), n] as const),
          ].map(([k, label, n]) => (
            <button
              key={k}
              type="button"
              aria-pressed={week === k}
              onClick={() => setWeek(k)}
              className={cn(
                "h-8 rounded-[8px] px-3 text-[13px] font-medium",
                week === k ? "bg-surface text-foreground" : "text-ink-2 hover:text-foreground",
              )}
            >
              {label} <span className="text-ink-3">{n}</span>
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
          <Checkbox checked={dupOnly} onCheckedChange={(v) => setDupOnly(v === true)} />
          Show possible duplicates only
        </label>
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          Channel
          <select
            className={SELECT_CLS}
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            aria-label="Channel"
          >
            <option value="all">All channels</option>
            {channels.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
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
        {canAdd && (
          <Button variant="outline" onClick={() => setAdding(true)}>
            Add activity
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No marketing plan yet"
          hint="It is read from the plan of action once one is attached in HubSpot."
        />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <section className="surface min-w-0 overflow-hidden">
            <div className="overflow-x-auto">
              <div className="min-w-[760px]">
                <div
                  className={cn(GRID, "border-b border-border px-5 py-2.5 text-[12px] text-ink-3")}
                >
                  <span>Activity</span>
                  <span>Goal</span>
                  <span>Dates</span>
                  <span>Ready to go live</span>
                  <span>Status</span>
                </div>
                {groups.length === 0 && (
                  <p className="px-5 py-8 text-center text-[14px] text-ink-2">
                    No activities match these filters.
                  </p>
                )}
                {groups.map(([wk, items]) => {
                  const dates = items
                    .map((i) => i.planned_date)
                    .filter((d): d is string => !!d)
                    .sort();
                  const range = dates.length
                    ? formatRange(dates[0], dates[dates.length - 1])
                    : null;
                  const late = !!regEnd && !!dates[0] && dates[0] > regEnd;
                  const expanded = isOpen(wk);
                  return (
                    <div key={wk}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => toggleWeek(wk)}
                        className="flex w-full items-center gap-2.5 border-b border-border bg-raised px-5 py-3 text-left text-[13px]"
                      >
                        {expanded ? (
                          <ChevronDown className="size-3.5 text-ink-2" />
                        ) : (
                          <ChevronRight className="size-3.5 text-ink-2" />
                        )}
                        <span className="font-semibold">{weekLabel(wk)}</span>
                        <span className="text-ink-2">
                          {range ? `${range} · ` : ""}
                          {items.length} {items.length === 1 ? "activity" : "activities"}
                        </span>
                        {late && (
                          <span className="ml-auto rounded-full bg-warn-bg px-2 py-0.5 text-[12px] text-warn">
                            After registration closed
                          </span>
                        )}
                      </button>
                      {expanded &&
                        items.map((a) => (
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
              </div>
            </div>
            <p className="px-5 py-3 text-[12px] text-ink-3">
              Showing {visible.length} of {rows.length} planned activities
            </p>
          </section>

          <aside
            ref={inspector}
            aria-label="Activity details"
            className="surface min-w-0 p-5 lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto"
          >
            {selected ? (
              <Inspector
                key={selected.id}
                ticketId={ticketId}
                a={selected}
                csm={csm}
                busy={pendingId === selected.id}
                canApprove={canApprove}
                canEdit={canEdit}
                onClose={() => select(null)}
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
            ) : (
              <>
                <p className="font-medium">Select an activity</p>
                <p className="mt-1 text-[13px] text-ink-2">
                  Open a row to approve it, set its UTM and creative proof, log results and read its
                  history.
                </p>
              </>
            )}
          </aside>
        </div>
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
        rows={blocked.filter((a) => !a.utm)}
        onSave={async (entries) => {
          for (const [a, utm] of entries) await patchPlanActivity(ticketId, a, { utm });
          await reload();
          void qc.invalidateQueries({ queryKey: ["audit"] });
        }}
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: string;
  note: string;
  warn?: boolean;
}) {
  return (
    <div className="surface px-4 py-3.5">
      <p className="text-[13px] text-ink-2">{label}</p>
      <p className="mt-0.5 text-[24px] font-semibold leading-8">{value}</p>
      <p className={cn("text-[12px]", warn ? "text-warn" : "text-ink-3")}>{note}</p>
    </div>
  );
}

function Notice({
  tone,
  children,
  onDismiss,
}: {
  tone: "ok" | "warn" | "danger";
  children: ReactNode;
  onDismiss: () => void;
}) {
  const cls = {
    ok: "bg-ok-bg text-ok",
    warn: "bg-warn-bg text-warn",
    danger: "bg-danger-bg text-danger",
  }[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-center justify-between gap-3 rounded-[10px] px-3.5 py-2.5 text-[14px]",
        cls,
      )}
    >
      <span>{children}</span>
      <button
        className="shrink-0 text-[13px] underline-offset-2 hover:underline"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}

function PlanSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[88px]" />
        ))}
      </div>
      <Skeleton className="h-12" />
      <Skeleton className="h-[420px]" />
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
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        GRID,
        "w-full items-center border-b border-border px-5 py-3 text-left text-[13px]",
        selected ? "bg-selected" : "hover:bg-raised",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {a.breach && (
          <TriangleAlert
            className="size-3.5 shrink-0 text-danger"
            aria-label="Live without approval"
          />
        )}
        <span className="truncate font-medium">{a.title}</span>
        <span className="shrink-0 rounded-[6px] bg-chip px-2 py-px text-[12px] text-ink-2">
          {a.channel}
        </span>
        {duplicate && (
          <span className="shrink-0 rounded-[6px] bg-accent-bg px-2 py-px text-[12px] text-primary">
            Possible duplicate
          </span>
        )}
      </span>
      <span className="truncate text-ink-2">{a.audience ?? a.outcome ?? "—"}</span>
      <span className={a.planned_date ? "" : "text-ink-3"}>
        {a.planned_date ? formatDay(a.planned_date) : "—"}
      </span>
      <span className="flex gap-3">
        <StatusDot hollow={!a.approved_at} tone="ok" label="Approval" />
        <StatusDot hollow={!a.utm} tone="ok" label="UTM" />
      </span>
      <span>
        <Chip tone={a.status === "live" ? "good" : "neutral"}>{STATUS_LABEL[a.status]}</Chip>
      </span>
    </button>
  );
}

function Inspector({
  ticketId,
  a,
  csm,
  busy,
  canApprove,
  canEdit,
  onClose,
  act,
  onNudge,
}: {
  ticketId: string;
  a: PlanActivity;
  csm: string | null;
  busy: boolean;
  canApprove: boolean;
  canEdit: boolean;
  onClose: () => void;
  act: (fn: () => Promise<unknown>) => void;
  onNudge: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [utm, setUtm] = useState(a.utm ?? "");
  const [proof, setProof] = useState(a.creative_proof_url ?? "");
  const eligible = !!a.approved_at && !!a.utm;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = (body: { utm?: string | null; creative_proof_url?: string | null }) =>
    act(() => patchPlanActivity(ticketId, a, body));

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] text-ink-3">
            {weekLabel(weekKey(a))} · {a.channel} · <span className="font-mono">{a.code}</span>
          </p>
          <h2 className="mt-0.5 text-[18px] font-semibold leading-6">{a.title}</h2>
          <p className="mt-1 text-[13px] text-ink-2">{a.audience ?? a.outcome ?? a.hook ?? ""}</p>
        </div>
        <button
          aria-label="Close details"
          className="rounded p-1 text-ink-3 hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>

      <section className="flex flex-col gap-2.5 rounded-[10px] bg-raised p-3.5">
        <div className="flex items-center justify-between">
          <span className="font-medium">Approval</span>
          {a.approved_at ? (
            <Chip tone="good">Approved by {a.approved_by_name}</Chip>
          ) : (
            <Chip tone="warning">Waiting for {csm ?? "the CSM"}</Chip>
          )}
        </div>
        <p className="text-[13px] text-ink-2">
          {a.approved_at
            ? `Approved ${formatWhen(a.approved_at)}.`
            : "Can't go live without CSM approval and a UTM."}
        </p>
        {canApprove && !a.approved_at && (
          <Button disabled={busy} onClick={() => act(() => approveActivity(ticketId, a.id))}>
            {busy ? "Approving…" : "Approve activity"}
          </Button>
        )}
        {!a.approved_at && canEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={onNudge}
            className="self-start text-[13px] text-primary hover:underline disabled:opacity-50"
          >
            Nudge {csm ?? "the CSM"}
          </button>
        )}
        {canApprove && a.approved_at && !confirming && (
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Withdraw approval
          </Button>
        )}
        {canApprove && a.approved_at && confirming && (
          <div className="space-y-2">
            {a.status === "live" && (
              <p className="flex items-start gap-1.5 text-[13px] text-danger">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> This activity is live.
                Withdrawing the approval makes it a control breach and alerts the program channel.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => {
                  act(() => withdrawApproval(ticketId, a.id));
                  setConfirming(false);
                }}
              >
                Confirm withdraw
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>

      <label className="flex flex-col gap-1.5 text-[13px]">
        <span className="font-medium">UTM campaign</span>
        <span className="flex gap-2">
          <Input
            className={cn("min-w-0 flex-1 font-mono text-[12px]", FIELD_CLS)}
            value={utm}
            readOnly={!canEdit}
            placeholder="he_embark_onsite_banner"
            onChange={(e) => setUtm(e.target.value)}
            aria-label="UTM campaign"
          />
          {canEdit && (
            <Button
              variant="outline"
              disabled={busy || utm.trim() === (a.utm ?? "")}
              onClick={() => save({ utm: utm.trim() || null })}
            >
              Save
            </Button>
          )}
        </span>
      </label>

      <label className="flex flex-col gap-1.5 text-[13px]">
        <span className="font-medium">Creative proof link</span>
        <span className="flex gap-2">
          <Input
            className={cn("min-w-0 flex-1", FIELD_CLS)}
            value={proof}
            readOnly={!canEdit}
            placeholder="https://drive.google.com/…"
            onChange={(e) => setProof(e.target.value)}
            aria-label="Creative proof link"
          />
          {safeUrl(a.creative_proof_url) && (
            <Button variant="outline" asChild>
              <a
                href={safeUrl(a.creative_proof_url) ?? undefined}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Open creative proof"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          )}
          {canEdit && (
            <Button
              variant="outline"
              disabled={busy || proof.trim() === (a.creative_proof_url ?? "")}
              onClick={() => save({ creative_proof_url: proof.trim() || null })}
            >
              Save
            </Button>
          )}
        </span>
      </label>

      {canEdit && (
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">Status</span>
          <select
            className={SELECT_CLS}
            aria-label={`Status of ${a.title}`}
            value={a.status}
            disabled={busy}
            onChange={(e) => {
              const st = e.target.value as ActivityStatus;
              act(() =>
                st === "live"
                  ? goLive(ticketId, a.id)
                  : patchPlanActivity(ticketId, a, { status: st }),
              );
            }}
          >
            {(Object.keys(STATUS_LABEL) as ActivityStatus[]).map((st) => (
              <option
                key={st}
                value={st}
                disabled={
                  (st === "live" && a.status !== "live" && !eligible) ||
                  (st === "off" && a.status !== "live" && a.status !== "off")
                }
              >
                {STATUS_LABEL[st]}
              </option>
            ))}
          </select>
        </label>
      )}

      <Telemetry ticketId={ticketId} a={a} />
      <History id={a.id} />
    </div>
  );
}

function Telemetry({ ticketId, a }: { ticketId: string; a: PlanActivity }) {
  const qc = useQueryClient();
  const canEnter = useCan("metrics.enter");
  const { data, isLoading, isError, error } = useQuery(metricsQuery(ticketId, a.id));
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    views: "",
    clicks: "",
    sent: "",
    opens: "",
  });
  const log = useMutation({
    mutationFn: () => {
      return putMetrics(ticketId, a.id, {
        date: form.date,
        ...(form.views !== "" && { views: Number(form.views) }),
        ...(form.clicks !== "" && { clicks: Number(form.clicks) }),
        ...(form.sent !== "" && { sent: Number(form.sent) }),
        ...(form.opens !== "" && { opens: Number(form.opens) }),
      });
    },
    onSuccess: (d: ActivityMetrics) => {
      qc.setQueryData(metricsQuery(ticketId, a.id).queryKey, d);
      setForm((f) => ({ ...f, views: "", clicks: "", sent: "", opens: "" }));
    },
  });
  const t = data?.totals;
  const points = (data?.days ?? []).map((d) => d.views ?? d.sent ?? 0);
  const fmt = (n: number | undefined) =>
    n === undefined ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    log.mutate();
  };
  const tiles: [string, string][] = [
    ["Views", fmt(t?.views)],
    ["Clicks", fmt(t?.clicks)],
    ["CTR", t?.ctr == null ? "—" : `${(t.ctr * 100).toFixed(1)}%`],
  ];
  const hasResults = (data?.days.length ?? 0) > 0;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-medium">Results</h3>
      {isLoading && <Skeleton className="h-16" />}
      {isError && <p className="text-[13px] text-danger">{errText(error)}</p>}
      {data && (
        <>
          {hasResults && <Sparkline points={points} />}
          <div className="grid grid-cols-3 gap-2">
            {tiles.map(([k, v]) => (
              <div key={k} className="rounded-[8px] bg-raised p-2.5">
                <p className="text-[12px] text-ink-3">{k}</p>
                <p className="font-semibold">{v}</p>
              </div>
            ))}
            {t && (t.sent > 0 || t.opens > 0) && (
              <>
                <div className="rounded-[8px] bg-raised p-2.5">
                  <p className="text-[12px] text-ink-3">Sent</p>
                  <p className="font-semibold">{fmt(t.sent)}</p>
                </div>
                <div className="rounded-[8px] bg-raised p-2.5">
                  <p className="text-[12px] text-ink-3">Opens</p>
                  <p className="font-semibold">{fmt(t.opens)}</p>
                </div>
                <div className="rounded-[8px] bg-raised p-2.5">
                  <p className="text-[12px] text-ink-3">Open rate</p>
                  <p className="font-semibold">
                    {t.open_rate == null ? "—" : `${(t.open_rate * 100).toFixed(1)}%`}
                  </p>
                </div>
              </>
            )}
          </div>
          {!hasResults && (
            <p className="text-[12px] text-ink-3">Results appear here once the activity is live.</p>
          )}
        </>
      )}
      {canEnter && a.status === "live" && (
        <form onSubmit={submit} className="space-y-2 border-t border-border pt-3">
          <p className="text-[13px] font-medium">Log results</p>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="date"
              value={form.date}
              required
              className={FIELD_CLS}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              aria-label="Date"
            />
            {(["views", "clicks", "sent", "opens"] as const).map((k) => (
              <Input
                key={k}
                type="number"
                min={0}
                inputMode="numeric"
                placeholder={k[0]?.toUpperCase() + k.slice(1)}
                aria-label={k}
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                className={FIELD_CLS}
              />
            ))}
          </div>
          {log.isError && <p className="text-[13px] text-danger">{errText(log.error)}</p>}
          <Button type="submit" variant="outline" disabled={log.isPending}>
            {log.isPending ? "Saving…" : "Log results"}
          </Button>
        </form>
      )}
    </section>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${(i / (points.length - 1)) * 300},${58 - (p / max) * 52}`)
    .join(" ");
  return (
    <svg
      viewBox="0 0 300 64"
      className="h-14 w-full"
      role="img"
      aria-label="Daily views trend"
      preserveAspectRatio="none"
    >
      <path
        d={d}
        pathLength={1}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        className="line-draw"
        style={{ ["--len" as string]: 1 }}
      />
    </svg>
  );
}

function describe(e: AuditEvent): string {
  const v = (x: unknown) => (x === null || x === undefined || x === "" ? "empty" : String(x));
  switch (e.action) {
    case "activity_updated":
      return e.field === "utm"
        ? `set the UTM to ${v(e.new)}`
        : `changed ${(e.field ?? "a field").replace(/_/g, " ")} from ${v(e.old)} to ${v(e.new)}`;
    case "approved":
      return "approved the activity";
    case "approval_withdrawn":
      return "withdrew the approval";
    case "channel_added":
      return "added this activity manually";
    default:
      return e.action.replace(/_/g, " ");
  }
}

function History({ id }: { id: number }) {
  const { data, isLoading, isError, error } = useQuery(activityAuditQuery(id));
  return (
    <section className="border-t border-border pt-3.5 text-[13px]">
      <h3 className="mb-1 font-medium">History</h3>
      {isLoading && <Skeleton className="h-12" />}
      {isError && <p className="text-danger">{errText(error)}</p>}
      {data?.items.length === 0 && <p className="text-ink-3">No changes yet.</p>}
      <ol className="space-y-1.5">
        {data?.items.map((e) => (
          <li key={e.id} className="flex justify-between gap-3">
            <span>
              {e.actor_name} {describe(e)}
            </span>
            <span className="shrink-0 text-[12px] text-ink-3">{formatWhen(e.at)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function BulkUtmDialog({
  open,
  onOpenChange,
  rows,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rows: PlanActivity[];
  onSave: (entries: [PlanActivity, string][]) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<number, string>>({});
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  const suggest = () =>
    setValues((cur) =>
      Object.fromEntries(
        rows.map((a) => [
          a.id,
          cur[a.id]?.trim() || `he_${slug(a.channel)}_${slug(a.title)}`.slice(0, 60),
        ]),
      ),
    );
  const filled = rows.filter((a) => values[a.id]?.trim());
  const save = useMutation({
    mutationFn: () =>
      onSave(filled.map((a) => [a, values[a.id]!.trim()] as [PlanActivity, string])),
    onSuccess: () => {
      setValues({});
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add UTMs in bulk</DialogTitle>
          <DialogDescription>
            {rows.length} {rows.length === 1 ? "activity needs" : "activities need"} a UTM. Fill in
            the ones you know, or use suggestions and adjust them.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
          {rows.map((a) => (
            <label
              key={a.id}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 text-[13px]"
            >
              <span className="min-w-0 truncate">
                {a.title} <span className="text-ink-3">· {a.channel}</span>
              </span>
              <Input
                className={cn("font-mono text-[12px]", FIELD_CLS)}
                value={values[a.id] ?? ""}
                placeholder="he_channel_name"
                aria-label={`UTM for ${a.title}`}
                onChange={(e) => setValues({ ...values, [a.id]: e.target.value })}
              />
            </label>
          ))}
        </div>
        {save.isError && (
          <p role="alert" className="text-[13px] text-danger">
            {errText(save.error)}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={suggest}>
            Suggest UTMs
          </Button>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={filled.length === 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : `Save ${filled.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <label className="block space-y-1 text-[13px] text-ink-2">
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
            {field("planned_date", "Planned date", { type: "date" })}
          </div>
          {field("audience", "Target segment")}
          {field("outcome", "Outcome")}
          {field("hook", "Hook / description")}
          {add.isError && (
            <p role="alert" className="text-[13px] text-danger">
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
    ["planned_date", (a) => a.planned_date],
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
