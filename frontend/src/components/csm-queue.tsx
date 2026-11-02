import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bar,
  Card,
  CardBody,
  CardHeader,
  Chip,
  EmptyState,
  HealthPill,
  Segmented,
  Skeleton,
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

const HEALTH_TONE: Record<Health, Tone> = {
  good: "good",
  warning: "warning",
  critical: "critical",
};
const KIND_ORDER: CsmKind[] = [
  "control_breach",
  "approval_waiting",
  "request_due",
  "counts_missing",
  "update_due",
  "slack_unlinked",
  "dependency_overdue",
  "comm_overdue",
  "change_awaiting_approval",
];
const LINK_LABEL: Partial<Record<CsmKind, string>> = {
  control_breach: "Resolve breach",
  request_due: "Open request checklist",
  slack_unlinked: "Link channel",
  dependency_overdue: "Open dependencies",
  comm_overdue: "Open communications",
  change_awaiting_approval: "Review change",
};
// status colour only where something needs attention; setup items stay grey
const DOT: Record<Severity, string> = {
  critical: "bg-danger",
  amber: "bg-warn",
  info: "bg-ink-3",
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
    <p role="alert" className="px-4 pb-3 text-[13px] text-danger">
      {error.message}
    </p>
  ) : null;

const FieldLabel = ({ children }: { children: ReactNode }) => (
  <span className="text-[13px] font-medium text-ink-2">{children}</span>
);

type Group = { ticketId: string; name: string; client: string | null; items: CsmItem[] };

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

  const items = useMemo(() => (current.data?.items ?? []) as CsmItem[], [current.data]);
  const shown = useMemo(() => items.filter((i) => !kind || i.kind === kind), [items, kind]);
  // one card per program, in order of first appearance (the queue is already sorted by urgency)
  const groups = useMemo(() => {
    const by = new Map<string, Group>();
    for (const i of shown) {
      const g = by.get(i.ticket_id);
      if (g) g.items.push(i);
      else
        by.set(i.ticket_id, {
          ticketId: i.ticket_id,
          name: i.program_name,
          client: i.client,
          items: [i],
        });
    }
    return [...by.values()];
  }, [shown]);
  const order = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.id)), [groups]);
  const kindCounts = useMemo(() => {
    const c: Partial<Record<CsmKind, number>> = {};
    for (const i of items) c[i.kind] = (c[i.kind] ?? 0) + 1;
    return c;
  }, [items]);
  const overdueUpdates = kindCounts.update_due ?? 0;
  const unlinked = kindCounts.slack_unlinked ?? 0;
  const critical = items.filter((i) => i.severity === "critical").length;
  const programCount = new Set(items.map((i) => i.ticket_id)).size;

  const move = useCallback(
    (d: number) => setSelected((s) => Math.max(0, Math.min(order.length - 1, s + d))),
    [order.length],
  );
  useHotkey(
    "j",
    useCallback(() => move(1), [move]),
  );
  useHotkey(
    "k",
    useCallback(() => move(-1), [move]),
  );

  const findings = [
    critical > 0 && `${plural(critical, "item is", "items are")} critical`,
    overdueUpdates > 0 && `${plural(overdueUpdates, "update is", "updates are")} due`,
    unlinked > 0 &&
      `${plural(unlinked, "program has", "programs have")} no Slack channel, so reminders and summaries can't be posted`,
  ].filter(Boolean) as string[];

  return (
    <div className="page-in space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="t-headline-lg">Needs you today</h1>
          {current.data && (
            <p className="mt-1 max-w-3xl text-[14px] text-ink-2">
              {items.length === 0 ? (
                "Nothing is open right now."
              ) : (
                <>
                  <b className="font-medium text-foreground">{plural(items.length, "action")}</b>{" "}
                  across {plural(programCount, "program")}.
                  {findings.length > 0 &&
                    ` ${findings.join("; ").replace(/^./, (c) => c.toUpperCase())}.`}
                </>
              )}
            </p>
          )}
        </div>
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
              ...(mine.data ? { count: mine.data.items.length } : {}),
            },
            {
              id: "all",
              label: "All programs",
              ...(all.data ? { count: all.data.items.length } : {}),
            },
          ]}
        />
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
          <div role="group" aria-label="Filter actions" className="flex flex-wrap gap-1.5">
            {[
              { id: null, label: "All", n: items.length },
              ...KIND_ORDER.filter((k) => (kindCounts[k] ?? 0) > 0).map((k) => ({
                id: k,
                label: KIND_LABELS[k],
                n: kindCounts[k] ?? 0,
              })),
            ].map((f) => (
              <button
                key={f.id ?? "all"}
                type="button"
                aria-pressed={kind === f.id}
                onClick={() => {
                  setKind(f.id);
                  setSelected(0);
                }}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-[6px] border px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  kind === f.id
                    ? "border-transparent bg-accent-bg text-primary"
                    : "border-border bg-raised text-ink-2 hover:text-foreground",
                )}
              >
                {f.label}
                <span className="tabular-nums">{f.n}</span>
              </button>
            ))}
          </div>

          <div className="grid items-start gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px]">
            <section aria-label="Queue items" className="space-y-3">
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
                  {groups.map((g) => (
                    <ProgramGroup
                      key={g.ticketId}
                      group={g}
                      program={stages.get(g.ticketId)}
                      selectedId={order[selected]}
                      onSelect={(id) => setSelected(order.indexOf(id))}
                    />
                  ))}
                  <p className="text-[13px] text-ink-2">Press J / K to move between items</p>
                </>
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
    <div className="grid gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-[130px]" />
        ))}
      </div>
      <div className="space-y-5">
        <Skeleton className="h-[220px]" />
        <Skeleton className="h-[120px]" />
      </div>
    </div>
  );
}

// ---- one program card with its open actions ------------------------------------------------

function ProgramGroup({
  group,
  program,
  selectedId,
  onSelect,
}: {
  group: Group;
  program: PortfolioProgram | undefined;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <Card>
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold leading-5">
            <Link
              to="/programs/$ticketId"
              params={{ ticketId: group.ticketId }}
              className="hover:underline"
            >
              {group.name}
            </Link>
          </h2>
          <p className="truncate text-[13px] text-ink-2">
            <span className="font-mono text-[12px]">{group.ticketId}</span>
            {[group.client, program?.stage].filter(Boolean).map((x) => ` · ${x}`)}
          </p>
        </div>
        <Chip tone={group.items.some((i) => i.severity !== "info") ? "warning" : "neutral"}>
          {plural(group.items.length, "action")}
        </Chip>
      </header>
      <ul>
        {group.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            onSelect={() => onSelect(item.id)}
          />
        ))}
      </ul>
    </Card>
  );
}

// ---- one queue item (a row inside its program's card) -----------------------------------------

function ItemRow({
  item,
  selected,
  onSelect,
}: {
  item: CsmItem;
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

  const wait = waited(item.since);
  const tab = tabFor(item.kind);

  return (
    <li
      ref={ref}
      style={{ gridTemplateRows: gone ? "0fr" : "1fr", opacity: gone ? 0 : undefined }}
      className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
      onClick={onSelect}
    >
      <div
        className={cn(
          "min-h-0 overflow-hidden border-b border-border last:border-b-0",
          selected && "bg-accent-bg/40",
        )}
        data-selected={selected}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[item.severity])} />
          <p className="min-w-0 flex-1 basis-[14rem] text-[14px]">
            <span className="font-medium">{item.title}.</span>{" "}
            <span className="text-ink-2">{item.detail}</span>
            {wait && (
              <span
                className="ml-1.5 text-[13px] text-ink-2"
                title={item.since ? `since ${formatDateTime(item.since)}` : undefined}
              >
                {wait} waiting
              </span>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {item.kind === "approval_waiting" && (
              <>
                <ProgramLink ticketId={item.ticket_id} tab={tab} size="sm" variant="secondary">
                  View in plan
                </ProgramLink>
                {canApprove && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={approve.isPending}
                    onClick={() => approve.mutate()}
                  >
                    {approve.isPending && <Loader2 className="animate-spin" />}
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
                    variant="secondary"
                    onClick={() => setPanel(panel === "counts" ? null : "counts")}
                  >
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
                  Post update
                </Button>
              ) : (
                <ProgramLink ticketId={item.ticket_id} tab="requests" size="sm" variant="secondary">
                  Open updates
                </ProgramLink>
              ))}
            {LINK_LABEL[item.kind] && (
              <ProgramLink
                ticketId={item.ticket_id}
                tab={tab}
                size="sm"
                variant={item.kind === "control_breach" ? "destructive" : "secondary"}
              >
                {LINK_LABEL[item.kind]}
              </ProgramLink>
            )}
          </div>
        </div>
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
      className="drawer-in border-t border-border px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="text-[14px] font-semibold">Round counts · {item.title}</h3>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className="space-y-1">
          <FieldLabel>As of</FieldLabel>
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
        </label>
        {COUNT_FIELDS.map((f) => (
          <label key={f} className="space-y-1">
            <FieldLabel>{f[0]!.toUpperCase() + f.slice(1)}</FieldLabel>
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
      className="drawer-in border-t border-border px-4 py-4"
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
          <FieldLabel>Program health</FieldLabel>
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
        <FieldLabel>Update summary</FieldLabel>
        <Textarea
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          required
          placeholder="What happened since the last update?"
        />
      </label>
      <label className="mt-3 block space-y-1">
        <FieldLabel>Known blockers / dependencies (optional)</FieldLabel>
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
        divided
        title={scope === "mine" ? "My portfolio" : "Programs with open items"}
        meta={plural(list.length, "program")}
      />
      {loading ? (
        <CardBody className="pt-3">
          <Skeleton className="h-24" />
        </CardBody>
      ) : list.length === 0 ? (
        <CardBody className="pt-3">
          <p className="text-[13px] text-ink-2">No programs with open items.</p>
        </CardBody>
      ) : (
        <ul>
          {list.map((p, n) => (
            <li key={p.ticket_id} className="border-b border-border last:border-b-0">
              <Link
                to="/programs/$ticketId"
                params={{ ticketId: p.ticket_id }}
                className="block px-4 py-2.5 hover:bg-raised"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium">{p.name}</div>
                    <div className="truncate text-[13px] text-ink-2">
                      {[p.client, p.stage].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-[13px] tabular-nums text-ink-2">
                    {p.registrations.toLocaleString("en-US")}
                    {p.target ? ` / ${p.target.toLocaleString("en-US")}` : " reg"}
                  </span>
                </div>
                {p.health !== "good" && <HealthPill health={p.health} className="mt-1" />}
                {p.target ? (
                  <Bar
                    pct={(p.registrations / p.target) * 100}
                    index={n}
                    tone={p.health === "good" ? "info" : HEALTH_TONE[p.health]}
                    label="Registrations against target"
                    className="mt-2"
                  />
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
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
        divided={merged.length > 0}
        title="Slack outbox"
        meta={
          status.data
            ? `${status.data.outbox_queued} queued · ${status.data.outbox_failed} failed`
            : undefined
        }
      />
      {merged.length === 0 ? (
        <CardBody>
          <p className="text-[13px] text-ink-2">
            {rows.some((r) => r.isLoading)
              ? "Loading..."
              : "No recent messages for these programs."}
          </p>
        </CardBody>
      ) : (
        <ul>
          {merged.map(({ row, ticket }) => (
            <li
              key={`${ticket}-${row.id}`}
              className="border-b border-border px-4 py-2.5 last:border-b-0"
            >
              <div className="flex items-center justify-between gap-2 text-[13px] text-ink-2">
                <span>{row.kind}</span>
                <span>{timeAgo(row.created_at)}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[13px]">{row.body}</p>
              <div className="mt-1.5">
                <Chip tone={tone[row.status] ?? "neutral"}>{row.status}</Chip>
              </div>
            </li>
          ))}
        </ul>
      )}
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
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-border bg-raised px-4 py-3">
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
