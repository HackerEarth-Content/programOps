import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  ListChecks,
  Loader2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Avatar,
  Bar,
  Card,
  CardBody,
  CardHeader,
  Chip,
  EmptyState,
  Kpi,
  MonoLabel,
  Num,
  Segmented,
  Skeleton,
  toneText,
  useHotkey,
  type Tone,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCan } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import {
  addCounts,
  approveActivity,
  csmQueueQuery,
  KIND_LABELS,
  postUpdate,
  type CsmKind,
  type Health,
  type Severity,
} from "@/lib/ops-api";
import {
  outboxQuery,
  portfolioFullQuery,
  type CsmItem,
  type PortfolioProgram,
} from "@/lib/queues-api";
import { tabFor, type ProgramTab } from "@/lib/program-tabs";
import { systemStatusQuery } from "@/lib/system-api";
import { cn, usePersistentState } from "@/lib/utils";

const SEV_TONE: Record<Severity, Tone> = {
  critical: "critical",
  amber: "warning",
  info: "neutral",
};
const SEV_LABEL: Record<Severity, string> = { critical: "Critical", amber: "Amber", info: "Info" };
const HEALTH_TONE: Record<Health, Tone> = {
  good: "good",
  warning: "warning",
  critical: "critical",
};
const HEALTH_LABEL: Record<Health, string> = {
  good: "Good",
  warning: "At risk",
  critical: "Critical",
};
const KIND_TONE: Record<CsmKind, Tone> = {
  control_breach: "critical",
  approval_waiting: "warning",
  request_due: "info",
  counts_missing: "indigo",
  update_due: "neutral",
  slack_unlinked: "neutral",
  dependency_overdue: "serious",
  comm_overdue: "serious",
  change_awaiting_approval: "indigo",
};
const KIND_ORDER = Object.keys(KIND_TONE) as CsmKind[];
const LINK_LABEL: Partial<Record<CsmKind, string>> = {
  control_breach: "Resolve breach",
  request_due: "Open request checklist",
  slack_unlinked: "Link channel",
  dependency_overdue: "Open dependencies",
  comm_overdue: "Open communications",
  change_awaiting_approval: "Review change",
};

/** "3h 12m", "2d 4h" since a timestamp. */
function waited(since: string | null): string | null {
  if (!since) return null;
  const mins = Math.max(
    0,
    Math.round(
      (Date.now() - new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(since) ? since : `${since}Z`).getTime()) /
        60000,
    ),
  );
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}

const ProgramLink = ({
  ticketId,
  tab,
  children,
  ...rest
}: {
  ticketId: string;
  tab: ProgramTab;
  children: ReactNode;
  variant?: "secondary" | "destructive" | "outline";
  size?: "sm";
}) => (
  <Button asChild {...rest}>
    <Link to="/programs/$ticketId" params={{ ticketId }} search={{ tab }}>
      {children}
    </Link>
  </Button>
);

const ErrorText = ({ error }: { error: Error | null }) =>
  error ? (
    <p role="alert" className="mt-2 text-[13px] text-status-critical">
      {error.message}
    </p>
  ) : null;

export function CsmQueue() {
  const [scopeValue, setScope] = usePersistentState("programops.csm.scope", "mine");
  const scope: "mine" | "all" = scopeValue === "all" ? "all" : "mine";
  const [kindValue, setKindValue] = usePersistentState("programops.csm.kind", "");
  const kind = (KIND_ORDER as readonly string[]).includes(kindValue)
    ? (kindValue as CsmKind)
    : null;
  const setKind = (k: CsmKind | null) => setKindValue(k ?? "");
  const [selected, setSelected] = useState(0);
  const mine = useQuery(csmQueueQuery("mine"));
  const all = useQuery(csmQueueQuery("all"));
  const current = scope === "mine" ? mine : all;
  const portfolio = useQuery(portfolioFullQuery);
  const stages = useMemo(
    () => new Map((portfolio.data?.programs ?? []).map((p) => [p.ticket_id, p])),
    [portfolio.data],
  );

  // info-level setup items (e.g. "Slack not linked") don't count as work for today
  const actionable = (list: { severity: string }[] | undefined) =>
    (list ?? []).filter((i) => i.severity !== "info").length;
  const items = useMemo(() => (current.data?.items ?? []) as CsmItem[], [current.data]);
  const shown = useMemo(() => items.filter((i) => !kind || i.kind === kind), [items, kind]);
  const critical = items.filter((i) => i.severity === "critical").length;
  const total = actionable(current.data?.items);
  const counts = current.data?.counts ?? {};

  const move = useCallback(
    (d: number) => setSelected((s) => Math.max(0, Math.min(shown.length - 1, s + d))),
    [shown.length],
  );
  useHotkey(
    "j",
    useCallback(() => move(1), [move]),
  );
  useHotkey(
    "k",
    useCallback(() => move(-1), [move]),
  );

  return (
    <div className="page-in space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="t-headline-lg flex flex-wrap items-center gap-2.5">
            Needs you today
            {current.data && (
              <Chip tone="good">
                <Num value={total} />
              </Chip>
            )}
            {critical > 0 && (
              <Chip tone="critical">
                <span className="size-1.5 rounded-full bg-status-critical" />
                {critical} critical
              </Chip>
            )}
          </h1>
          <p className="mt-1 max-w-2xl text-[14px] text-secondary-foreground">
            Priority queue of actions across programs that need a CSM: approvals, missing counts,
            due updates and control breaches.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            value={scope}
            onChange={(s) => {
              setScope(s);
              setKind(null);
              setSelected(0);
            }}
            options={[
              {
                id: "mine",
                label: "My programs",
                ...(mine.data ? { count: actionable(mine.data.items) } : {}),
              },
              {
                id: "all",
                label: "All programs",
                ...(all.data ? { count: actionable(all.data.items) } : {}),
              },
            ]}
          />
          <MonoLabel>Sort: Urgency</MonoLabel>
          {kind && (
            <Button size="sm" variant="ghost" onClick={() => setKind(null)}>
              <X className="size-3.5" />
              Clear filter
            </Button>
          )}
        </div>
      </div>

      {current.isLoading ? (
        <QueueSkeleton />
      ) : current.isError ? (
        <EmptyState
          icon={<AlertTriangle />}
          title="Couldn't load the queue"
          hint={current.error.message}
          action={
            <Button size="sm" variant="outline" onClick={() => void current.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          <div className="reveal grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {KIND_ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k, n) => {
              const worst = items
                .filter((i) => i.kind === k)
                .sort(
                  (a, b) =>
                    ["critical", "amber", "info"].indexOf(a.severity) -
                    ["critical", "amber", "info"].indexOf(b.severity),
                )[0];
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setKind(kind === k ? null : k);
                    setSelected(0);
                  }}
                  aria-pressed={kind === k}
                  className={cn(
                    "rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    kind === k && "ring-2 ring-primary",
                  )}
                >
                  <Kpi
                    label={KIND_LABELS[k]}
                    value={<Num value={counts[k] ?? 0} />}
                    index={n}
                    {...(worst
                      ? {
                          chip: (
                            <Chip tone={SEV_TONE[worst.severity]}>{SEV_LABEL[worst.severity]}</Chip>
                          ),
                        }
                      : {})}
                    className="h-full"
                  />
                </button>
              );
            })}
          </div>

          <div className="grid items-start gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px]">
            <section aria-label="Queue items">
              {shown.length === 0 ? (
                <EmptyState
                  icon={<CheckCircle2 />}
                  title="Nothing needs attention"
                  hint={
                    scope === "mine"
                      ? "None of your programs has an open item. Switch to All programs to look wider."
                      : "No program has an open item right now."
                  }
                />
              ) : (
                <>
                  <BulkApprove items={shown} />
                  <ul className="reveal">
                    {shown.map((item, n) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        program={stages.get(item.ticket_id)}
                        index={n}
                        selected={n === selected}
                        onSelect={() => setSelected(n)}
                      />
                    ))}
                  </ul>
                </>
              )}
              {shown.length > 0 && (
                <p className="mt-1 t-data-sm text-muted-foreground">J / K to move between items</p>
              )}
            </section>
            <aside className="space-y-5">
              <PortfolioCard
                programs={portfolio.data?.programs ?? []}
                loading={portfolio.isLoading}
                items={(mine.data?.items ?? []) as CsmItem[]}
                scopeItems={items}
                scope={scope}
              />
              <OutboxCard tickets={[...new Set(items.map((i) => i.ticket_id))].slice(0, 5)} />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-[84px]" />
        ))}
      </div>
      <div className="grid gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[130px]" />
          ))}
        </div>
        <div className="space-y-5">
          <Skeleton className="h-[220px]" />
          <Skeleton className="h-[200px]" />
        </div>
      </div>
    </div>
  );
}

// ---- one queue item ---------------------------------------------------------------------

function ItemRow({
  item,
  program,
  index,
  selected,
  onSelect,
}: {
  item: CsmItem;
  program: PortfolioProgram | undefined;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const qc = useQueryClient();
  const [gone, setGone] = useState(false);
  const [panel, setPanel] = useState<"counts" | "update" | null>(null);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  // Collapse the row, then refetch so the server's view replaces ours.
  const done = () => {
    setGone(true);
    window.setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ["queues"] });
      void qc.invalidateQueries({ queryKey: ["portfolio"] });
    }, 380);
  };
  const canApprove = useCan("activity.approve");
  const canCounts = useCan("counts.enter");
  const canUpdate = useCan("update.post");
  const approve = useMutation({
    mutationFn: () => approveActivity(item.ticket_id, item.ref_id ?? 0),
    onSuccess: done,
  });

  const tone = SEV_TONE[item.severity];
  const wait = waited(item.since);
  const tab = tabFor(item.kind);
  const refLabel =
    item.ref_type && item.ref_id ? `${item.ref_type} #${item.ref_id}` : `ticket ${item.ticket_id}`;

  return (
    <li
      ref={ref}
      style={{
        ["--i" as string]: index,
        gridTemplateRows: gone ? "0fr" : "1fr",
        opacity: gone ? 0 : undefined,
      }}
      className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
      onClick={onSelect}
    >
      <div className="min-h-0 overflow-hidden">
        <Card
          interactive
          className={cn("mb-3 overflow-hidden", selected && "ring-2 ring-primary/40")}
          data-selected={selected}
        >
          <div className="px-[18px] pt-4 pb-3">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <Chip tone={KIND_TONE[item.kind]}>{KIND_LABELS[item.kind]}</Chip>
              <Link
                to="/programs/$ticketId"
                params={{ ticketId: item.ticket_id }}
                className="text-[16px] font-semibold leading-[22px] tracking-[-0.01em] hover:underline"
              >
                {item.program_name}
              </Link>
              {item.client && <Chip>{item.client}</Chip>}
              {program && <span className="t-data-sm text-muted-foreground">{program.stage}</span>}
              {wait && (
                <span className={cn("ml-auto flex items-center gap-1 t-data-sm", toneText(tone))}>
                  <Clock className="size-3.5" />
                  {wait} waiting
                </span>
              )}
            </div>
            <p className="mt-2.5 text-[14px] text-foreground">
              <span className="font-medium">{item.title}.</span>{" "}
              <span className="text-secondary-foreground">{item.detail}</span>
            </p>
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-secondary/50 px-[18px] py-2.5">
            <div className="flex min-w-0 items-center gap-2 t-data-sm text-muted-foreground">
              <Avatar name={item.client ?? item.program_name} />
              <span className="truncate">{refLabel}</span>
              {item.since && (
                <span className="hidden sm:inline">· since {formatDateTime(item.since)}</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {item.kind === "approval_waiting" && (
                <>
                  <ProgramLink ticketId={item.ticket_id} tab={tab} size="sm" variant="secondary">
                    View in plan
                  </ProgramLink>
                  {canApprove && (
                    <Button
                      size="sm"
                      variant="success"
                      disabled={approve.isPending}
                      onClick={() => approve.mutate()}
                    >
                      {approve.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                      Review &amp; Approve
                    </Button>
                  )}
                </>
              )}
              {item.kind === "counts_missing" && (
                <>
                  <ProgramLink ticketId={item.ticket_id} tab="rounds" size="sm" variant="secondary">
                    Open rounds
                  </ProgramLink>
                  {canCounts && item.ref_id !== null && (
                    <Button
                      size="sm"
                      variant="success"
                      onClick={() => setPanel(panel === "counts" ? null : "counts")}
                    >
                      <ListChecks />
                      Enter round counts
                    </Button>
                  )}
                </>
              )}
              {item.kind === "update_due" &&
                (canUpdate ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setPanel(panel === "update" ? null : "update")}
                  >
                    Post update (Compose)
                  </Button>
                ) : (
                  <ProgramLink
                    ticketId={item.ticket_id}
                    tab="requests"
                    size="sm"
                    variant="secondary"
                  >
                    Open updates
                  </ProgramLink>
                ))}
              {item.kind === "control_breach" && (
                <ProgramLink ticketId={item.ticket_id} tab={tab} size="sm" variant="destructive">
                  Resolve breach
                </ProgramLink>
              )}
              {LINK_LABEL[item.kind] && item.kind !== "control_breach" && (
                <ProgramLink ticketId={item.ticket_id} tab={tab} size="sm" variant="secondary">
                  {LINK_LABEL[item.kind]}
                  <ChevronRight />
                </ProgramLink>
              )}
            </div>
          </footer>
          {panel === "counts" && item.ref_id !== null && (
            <CountsForm
              item={item}
              roundId={item.ref_id}
              onClose={() => setPanel(null)}
              onDone={done}
            />
          )}
          {panel === "update" && (
            <UpdateForm item={item} onClose={() => setPanel(null)} onDone={done} />
          )}
          <ErrorText error={approve.error} />
        </Card>
      </div>
    </li>
  );
}

const COUNT_FIELDS = ["invited", "attempted", "cleared", "shortlisted"] as const;

function CountsForm({
  item,
  roundId,
  onClose,
  onDone,
}: {
  item: CsmItem;
  roundId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [vals, setVals] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => {
      const body: Parameters<typeof addCounts>[2] = { as_of: asOf };
      for (const f of COUNT_FIELDS) if (vals[f]) body[f] = Number(vals[f]);
      return addCounts(item.ticket_id, roundId, body);
    },
    onSuccess: onDone,
  });
  const filled = COUNT_FIELDS.some((f) => vals[f]);
  return (
    <form
      className="drawer-in border-t border-border px-[18px] py-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="text-[14px] font-semibold">Round counts · {item.title}</h3>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className="space-y-1">
          <MonoLabel>As of</MonoLabel>
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
        </label>
        {COUNT_FIELDS.map((f) => (
          <label key={f} className="space-y-1">
            <MonoLabel>{f}</MonoLabel>
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              className="font-mono"
              value={vals[f] ?? ""}
              onChange={(e) => setVals({ ...vals, [f]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <ErrorText error={save.error} />
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!filled || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}Save counts
        </Button>
      </div>
    </form>
  );
}

const HEALTH_OPTIONS: { id: Health; label: string }[] = [
  { id: "good", label: "Good · On track" },
  { id: "warning", label: "At risk · Needs attention" },
  { id: "critical", label: "Critical · Blocker" },
];

function UpdateForm({
  item,
  onClose,
  onDone,
}: {
  item: CsmItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const [health, setHealth] = useState<Health>("good");
  const [summary, setSummary] = useState("");
  const [blockers, setBlockers] = useState("");
  const save = useMutation({
    mutationFn: () =>
      postUpdate(item.ticket_id, {
        health,
        summary: summary.trim(),
        blockers: blockers.trim() || null,
      }),
    onSuccess: onDone,
  });
  return (
    <form
      className="drawer-in border-t border-border px-[18px] py-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-semibold">Compose update · {item.program_name}</h3>
        <Button type="button" size="icon" variant="ghost" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      <fieldset className="mt-3">
        <legend className="mb-1.5">
          <MonoLabel>Program health</MonoLabel>
        </legend>
        <div className="flex flex-wrap gap-2">
          {HEALTH_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={health === o.id}
              onClick={() => setHealth(o.id)}
              className={cn(
                "rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <Chip
                tone={HEALTH_TONE[o.id]}
                className={cn("h-7 px-3", health === o.id && "ring-1 ring-current")}
              >
                {o.label}
              </Chip>
            </button>
          ))}
        </div>
      </fieldset>
      <label className="mt-3 block space-y-1">
        <MonoLabel>Update summary</MonoLabel>
        <Textarea
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          required
          placeholder="What happened since the last update?"
        />
      </label>
      <label className="mt-3 block space-y-1">
        <MonoLabel>Known blockers / dependencies (optional)</MonoLabel>
        <Input value={blockers} onChange={(e) => setBlockers(e.target.value)} />
      </label>
      <ErrorText error={save.error} />
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!summary.trim() || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}Publish update
        </Button>
      </div>
    </form>
  );
}

// ---- right rail -------------------------------------------------------------------------

function PortfolioCard({
  programs,
  loading,
  items,
  scopeItems,
  scope,
}: {
  programs: PortfolioProgram[];
  loading: boolean;
  items: CsmItem[];
  scopeItems: CsmItem[];
  scope: "mine" | "all";
}) {
  // ponytail: there is no "my programs" endpoint; mine = programs that have an open item in my queue.
  const ids = new Set((scope === "mine" ? items : scopeItems).map((i) => i.ticket_id));
  const list = programs.filter((p) => ids.has(p.ticket_id));
  return (
    <Card>
      <CardHeader
        title={scope === "mine" ? "My Portfolio" : "Programs with open items"}
        meta={`${list.length} programs`}
      />
      <CardBody className="space-y-2.5">
        {loading ? (
          <Skeleton className="h-24" />
        ) : list.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No programs with open items.</p>
        ) : (
          list.map((p, n) => {
            const pct = p.target ? (p.registrations / p.target) * 100 : 0;
            return (
              <Link
                key={p.ticket_id}
                to="/programs/$ticketId"
                params={{ ticketId: p.ticket_id }}
                className="surface-inset lift block rounded-lg px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[14px] font-semibold">{p.name}</span>
                  <Chip tone={HEALTH_TONE[p.health]}>{HEALTH_LABEL[p.health]}</Chip>
                </div>
                <div className="mt-0.5 flex items-center justify-between t-data-sm text-muted-foreground">
                  <span className="truncate">
                    {[p.client, p.stage].filter(Boolean).join(" · ")}
                  </span>
                  <span>
                    {p.registrations.toLocaleString("en-US")}
                    {p.target ? ` / ${p.target.toLocaleString("en-US")}` : ""} reg
                  </span>
                </div>
                {p.target ? (
                  <Bar pct={pct} index={n} tone={HEALTH_TONE[p.health]} className="mt-2" />
                ) : null}
              </Link>
            );
          })
        )}
      </CardBody>
    </Card>
  );
}

function OutboxCard({ tickets }: { tickets: string[] }) {
  const status = useQuery(systemStatusQuery);
  const rows = useQueries({ queries: tickets.map((t) => outboxQuery(t)) });
  const merged = rows
    .flatMap((r, n) => (r.data ?? []).map((row) => ({ row, ticket: tickets[n] ?? "" })))
    .sort((a, b) => (a.row.created_at < b.row.created_at ? 1 : -1))
    .slice(0, 5);
  const tone: Record<string, Tone> = {
    sent: "good",
    queued: "info",
    failed: "critical",
    skipped: "neutral",
  };
  return (
    <Card>
      <CardHeader
        title="Slack outbox"
        meta={
          status.data
            ? `${status.data.outbox_queued} queued · ${status.data.outbox_failed} failed`
            : undefined
        }
      />
      <CardBody className="space-y-2">
        {merged.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {rows.some((r) => r.isLoading)
              ? "Loading..."
              : "No recent messages for these programs."}
          </p>
        ) : (
          merged.map(({ row, ticket }) => (
            <div key={`${ticket}-${row.id}`} className="surface-inset rounded-lg px-3 py-2">
              <div className="flex items-center justify-between gap-2 t-data-sm text-muted-foreground">
                <span>{row.kind}</span>
                <span>{timeAgo(row.created_at)}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[13px] text-secondary-foreground">{row.body}</p>
              <div className="mt-1.5">
                <Chip tone={tone[row.status] ?? "neutral"}>{row.status}</Chip>
              </div>
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Approve several waiting activities at once. Approval is the client sign-off, so it is never one click on
 * everything: the list is shown, each row can be unticked, and the count is on the button.
 */
function BulkApprove({ items }: { items: CsmItem[] }) {
  const canApprove = useCan("activity.approve");
  const qc = useQueryClient();
  const waiting = items.filter((i) => i.kind === "approval_waiting" && i.ref_id);
  const [open, setOpen] = useState(false);
  const [skip, setSkip] = useState<Record<string, boolean>>({});
  const chosen = waiting.filter((i) => !skip[i.id]);
  const approve = useMutation({
    mutationFn: async () => {
      for (const i of chosen) await approveActivity(i.ticket_id, i.ref_id ?? 0);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["queues"] });
      void qc.invalidateQueries({ queryKey: ["portfolio"] });
      void qc.invalidateQueries({ queryKey: ["programs"] });
    },
    onSuccess: () => setOpen(false),
  });
  if (!canApprove || waiting.length < 2) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-warn-bg px-4 py-3">
      <p className="text-[14px]">
        <span className="font-medium">
          {waiting.length} activities are waiting for your approval.
        </span>{" "}
        <span className="text-ink-2">Review them together instead of one by one.</span>
      </p>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Review and approve
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              Approve {chosen.length} of {waiting.length} activities?
            </DialogTitle>
            <DialogDescription>
              Approving is the client sign-off, recorded under your name. Untick anything you
              haven't checked.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto">
            {waiting.map((i) => (
              <li key={i.id}>
                <label className="flex cursor-pointer items-start gap-3 py-2.5 text-[14px]">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-ok"
                    checked={!skip[i.id]}
                    onChange={(e) => setSkip({ ...skip, [i.id]: !e.target.checked })}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{i.title}</span>
                    <span className="block text-[13px] text-ink-2">{i.program_name}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {approve.isError && (
            <p role="alert" className="text-[13px] text-danger">
              {approve.error instanceof Error
                ? approve.error.message
                : "Couldn't approve them all."}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={chosen.length === 0 || approve.isPending}
              onClick={() => approve.mutate()}
            >
              {approve.isPending ? "Approving…" : `Approve ${chosen.length}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
