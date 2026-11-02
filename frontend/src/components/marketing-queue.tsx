import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Bar, Card, CardBody, CardHeader, Chip, EmptyState, Skeleton } from "@/components/kit";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCan } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { marketingQueueQuery, patchActivity, type MarketingKind } from "@/lib/ops-api";
import {
  addChannel,
  channelMetricsQuery,
  goLiveAt,
  nudgeActivity,
  portfolioFullQuery,
  putMetrics,
  type MarketingItem,
} from "@/lib/queues-api";
import { cn, usePersistentState } from "@/lib/utils";

/** Work lists shown above "To prepare", in the order they matter. "Results to record" leads. */
const SECTIONS: { kind: MarketingKind; title: string; caption: string; urgent?: boolean }[] = [
  {
    kind: "results_to_record",
    title: "Results to record",
    caption: "Yesterday's views and clicks",
  },
  {
    kind: "go_live_due",
    title: "Go-live due today or overdue",
    caption: "Approved and past its planned date",
    urgent: true,
  },
  { kind: "ready_to_go_live", title: "Ready to go live", caption: "CSM approved, UTM in place" },
  {
    kind: "missing_utm_or_proof",
    title: "Missing UTM or creative proof",
    caption: "A UTM is required to go live",
  },
  {
    kind: "awaiting_approval",
    title: "Waiting for CSM approval",
    caption: "Read-only for marketing: nudge the CSM",
  },
];

const PREVIEW_ROWS = 5;
const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const FieldLabel = ({ children }: { children: ReactNode }) => (
  <span className="text-[13px] text-ink-2">{children}</span>
);

const ErrorText = ({ error }: { error: Error | null }) =>
  error ? (
    <p role="alert" className="mt-1.5 text-[13px] text-status-critical">
      {error.message}
    </p>
  ) : null;

export function MarketingQueue() {
  const [programValue, setProgramValue] = usePersistentState("programops.marketing.program", "");
  const program: string | null = programValue || null;
  const setProgram = (p: string | null) => setProgramValue(p ?? "");
  const [adding, setAdding] = useState(false);
  const canAddChannel = useCan("activity.add_channel");
  const q = useQuery(marketingQueueQuery);
  const items = useMemo(() => (q.data?.items ?? []) as MarketingItem[], [q.data]);
  const byProgram = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const i of items)
      m.set(i.ticket_id, { name: i.program_name, n: (m.get(i.ticket_id)?.n ?? 0) + 1 });
    return [...m.entries()];
  }, [items]);
  const shown = items.filter((i) => !program || i.ticket_id === program);
  const of = (k: MarketingKind) => shown.filter((i) => i.kind === k);
  const toPrepare = of("to_prepare");

  // Every number in the finding line is counted from the rows listed below it.
  const results = of("results_to_record");
  const due = of("go_live_due");
  const needUtm = shown.filter(
    (i) => (i.kind === "to_prepare" || i.kind === "missing_utm_or_proof") && /UTM/.test(i.detail),
  );
  const programsK = new Set([...results, ...due, ...needUtm].map((i) => i.ticket_id)).size;
  const finding = [
    due.length > 0 && <b key="d">{plural(due.length, "go-live")} due</b>,
    results.length > 0 && <b key="r">{plural(results.length, "result")} to record</b>,
    needUtm.length > 0 && (
      <span key="u">
        <b>{plural(needUtm.length, "activity", "activities")}</b> still need a UTM
      </span>
    ),
  ].filter(Boolean) as ReactNode[];

  return (
    <div className="page-in space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="t-headline-lg">Marketing queue</h1>
          {!q.isLoading && !q.isError && (
            <p className="mt-1 max-w-3xl text-[14px] text-ink-2 [&_b]:font-medium [&_b]:text-foreground">
              {finding.length === 0 ? (
                "Nothing is waiting on marketing right now."
              ) : (
                <>
                  {finding.map((f, i) => (
                    <span key={i}>
                      {i > 0 && (i === finding.length - 1 ? " and " : ", ")}
                      {f}
                    </span>
                  ))}
                  , across {plural(programsK, "program")}.
                </>
              )}
            </p>
          )}
        </div>
        {canAddChannel && <Button onClick={() => setAdding(true)}>Add unplanned channel</Button>}
      </div>

      {q.isLoading ? (
        <MarketingSkeleton />
      ) : q.isError ? (
        <EmptyState
          icon={<AlertTriangle />}
          title="Couldn't load the queue"
          hint={q.error.message}
          action={
            <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          {byProgram.length > 1 && (
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="Filter by program"
            >
              <span className="text-[13px] text-ink-2">Program</span>
              {[
                [null, "All programs", items.length] as const,
                ...byProgram.map(([id, p]) => [id, p.name, p.n] as const),
              ].map(([id, name, n]) => (
                <button
                  key={id ?? "all"}
                  type="button"
                  aria-pressed={program === id}
                  onClick={() => setProgram(id)}
                  className="rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Chip tone={program === id ? "info" : "neutral"} className="h-7 px-3">
                    {name} ({n})
                  </Chip>
                </button>
              ))}
            </div>
          )}

          <div className="grid items-start gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              {shown.length === 0 ? (
                <EmptyState
                  icon={<CheckCircle2 />}
                  title="Nothing needs attention"
                  hint="No activity is waiting on a UTM, a go-live, an approval or results."
                />
              ) : (
                <>
                  {SECTIONS.map((s) => {
                    const rows = of(s.kind);
                    if (rows.length === 0) return null;
                    return (
                      <Card key={s.kind} className="overflow-hidden">
                        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-3">
                          <h2 className="text-[14px] font-semibold">{s.title}</h2>
                          <Chip tone={s.urgent ? "critical" : "neutral"}>{rows.length}</Chip>
                          <span className="ml-auto text-[13px] text-ink-2">{s.caption}</span>
                        </header>
                        <ul className="divide-y divide-border">
                          {rows.map((item) => (
                            <li key={item.id}>
                              <Row item={item} />
                            </li>
                          ))}
                        </ul>
                      </Card>
                    );
                  })}
                  {toPrepare.length > 0 && <PrepareCard rows={toPrepare} />}
                </>
              )}
            </div>
            <aside className="min-w-0 space-y-4">
              <TelemetryCard tickets={program ? [program] : byProgram.map(([id]) => id)} />
              <GuardrailsCard />
            </aside>
          </div>
        </>
      )}
      <AddChannelDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function MarketingSkeleton() {
  return (
    <div className="grid gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="h-[150px]" />
        ))}
      </div>
      <div className="space-y-4">
        <Skeleton className="h-[160px]" />
        <Skeleton className="h-[200px]" />
      </div>
    </div>
  );
}

// ---- To prepare: grouped by program ---------------------------------------------------------

function PrepareCard({ rows }: { rows: MarketingItem[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; rows: MarketingItem[] }>();
    for (const r of rows) {
      const g = m.get(r.ticket_id) ?? { name: r.program_name, rows: [] };
      g.rows.push(r);
      m.set(r.ticket_id, g);
    }
    return [...m.entries()];
  }, [rows]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState<Record<string, boolean>>({});
  const canEdit = useCan("activity.edit");
  return (
    <Card className="overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-3">
        <h2 className="text-[14px] font-semibold">To prepare</h2>
        <span className="ml-auto text-[13px] text-ink-2">
          {plural(rows.length, "activity", "activities")} · {plural(groups.length, "program")} · not
          started, add a UTM and a go-live date
        </span>
      </header>
      {groups.map(([id, g], gi) => {
        const isOpen = open[id] ?? gi === 0;
        const visible = all[id] ? g.rows : g.rows.slice(0, PREVIEW_ROWS);
        return (
          <div key={id} className="border-b border-border last:border-b-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-background px-4 py-2.5">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen({ ...open, [id]: !isOpen })}
                className="flex min-w-0 items-center gap-2 rounded-[4px] text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {isOpen ? (
                  <ChevronDown className="size-3.5 shrink-0 text-ink-2" aria-hidden />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-ink-2" aria-hidden />
                )}
                <b className="truncate font-semibold">{g.name}</b>
                <span className="shrink-0 text-ink-2">{g.rows.length} to prepare</span>
              </button>
              {canEdit && (
                <Button asChild size="sm" variant="outline" className="ml-auto">
                  {/* ponytail: the bulk UTM dialog isn't exported from program-marketing, so link to that tab. */}
                  <Link
                    to="/programs/$ticketId"
                    params={{ ticketId: id }}
                    search={{ tab: "marketing" }}
                  >
                    Fill in bulk
                  </Link>
                </Button>
              )}
            </div>
            {isOpen && (
              <>
                <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1.4fr)_140px_72px] gap-3 border-t border-border px-4 py-2 text-[13px] text-ink-2 md:grid">
                  <span>Activity</span>
                  <span>UTM campaign</span>
                  <span>Go-live date</span>
                  <span />
                </div>
                <ul className="divide-y divide-border border-t border-border">
                  {visible.map((item) => (
                    <li key={item.id}>
                      <PrepareRow item={item} />
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-2.5 text-[13px] text-ink-2">
                  {g.rows.length > PREVIEW_ROWS && (
                    <button
                      type="button"
                      onClick={() => setAll({ ...all, [id]: !all[id] })}
                      className="rounded-[4px] text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {all[id] ? "Show fewer" : `Show ${g.rows.length - PREVIEW_ROWS} more`}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function PrepareRow({ item }: { item: MarketingItem }) {
  const canEdit = useCan("activity.edit");
  const done = useDone(item);
  const needsUtm = /UTM/.test(item.detail);
  const needsDate = /go-live date/.test(item.detail);
  const [utm, setUtm] = useState("");
  const [date, setDate] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...(utm.trim() ? { utm: utm.trim() } : {}),
        ...(date ? { planned_date: date } : {}),
      };
      // ponytail: the endpoint takes planned_date (the plan editor sends it); ops-api's patch type just omits it.
      return patchActivity(
        item.ticket_id,
        item.activity_id,
        body as Parameters<typeof patchActivity>[2],
      );
    },
    onSuccess: done,
  });
  const edited = !!utm.trim() || !!date;
  const dash = <span className="text-ink-3">—</span>;
  return (
    <form
      className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.4fr)_140px_72px] md:items-center md:gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (edited && !save.isPending) save.mutate();
      }}
    >
      <div className="min-w-0">
        <p className="truncate text-[14px] font-medium">{item.title}</p>
        <p className="text-[13px] text-ink-2">
          <span className="font-mono">#{item.activity_id}</span>
          {item.client && <> · {item.client}</>}
        </p>
      </div>
      {canEdit ? (
        <>
          {needsUtm ? (
            <Input
              aria-label={`UTM campaign for ${item.title}`}
              value={utm}
              onChange={(e) => setUtm(e.target.value)}
              placeholder="UTM campaign"
              className="min-w-0 font-mono placeholder:text-placeholder"
            />
          ) : (
            dash
          )}
          {needsDate ? (
            <Input
              type="date"
              aria-label={`Go-live date for ${item.title}`}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          ) : (
            dash
          )}
          <div>
            {edited && (
              <Button type="submit" size="sm" disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}Save
              </Button>
            )}
          </div>
          {save.error && (
            <div className="md:col-span-4">
              <ErrorText error={save.error} />
            </div>
          )}
        </>
      ) : (
        <p className="text-[13px] text-ink-2 md:col-span-3">{item.detail}</p>
      )}
    </form>
  );
}

// ---- rows -------------------------------------------------------------------------------

function RowShell({
  item,
  children,
  action,
  extra,
}: {
  item: MarketingItem;
  children?: ReactNode;
  action?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold">
            <Link
              to="/programs/$ticketId"
              params={{ ticketId: item.ticket_id }}
              search={{ tab: "marketing" }}
              className="hover:underline"
            >
              {item.program_name}
            </Link>
            <span className="text-ink-3"> · </span>
            {item.title}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {item.client && <span>{item.client} · </span>}
            {item.detail}
          </p>
          {children}
        </div>
        {action}
      </div>
      {extra}
    </div>
  );
}

function useDone(item: MarketingItem) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["queues", "marketing"] });
    void qc.invalidateQueries({ queryKey: ["programs", item.ticket_id, "metrics"] });
  };
}

function Row({ item }: { item: MarketingItem }) {
  switch (item.kind) {
    case "ready_to_go_live":
    case "go_live_due":
      return <GoLiveRow item={item} />;
    case "missing_utm_or_proof":
    case "to_prepare":
      return <MissingRow item={item} />;
    case "awaiting_approval":
      return <WaitingRow item={item} />;
    case "results_to_record":
      return <ResultsRow item={item} />;
  }
}

function GoLiveRow({ item }: { item: MarketingItem }) {
  const canEdit = useCan("activity.edit");
  const done = useDone(item);
  const [when, setWhen] = useState("");
  const live = useMutation({
    mutationFn: () =>
      goLiveAt(item.ticket_id, item.activity_id, when ? new Date(when).toISOString() : null),
    onSuccess: done,
  });
  const urgent = item.kind === "go_live_due";
  return (
    <RowShell
      item={item}
      action={
        canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="datetime-local"
              aria-label="Go-live time (blank means now)"
              title="Go-live time (blank means now)"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className="w-[190px] font-mono"
            />
            <Button
              variant={urgent ? "danger" : "secondary"}
              disabled={live.isPending}
              onClick={() => live.mutate()}
            >
              {live.isPending && <Loader2 className="animate-spin" />}
              {urgent ? "Confirm go-live now" : "Set live with date"}
            </Button>
          </div>
        )
      }
      extra={<ErrorText error={live.error} />}
    />
  );
}

function MissingRow({ item }: { item: MarketingItem }) {
  const canEdit = useCan("activity.edit");
  const done = useDone(item);
  const needsUtm = /UTM/.test(item.detail);
  const needsProof = /creative proof/.test(item.detail);
  const [utm, setUtm] = useState("");
  const [proof, setProof] = useState("");
  const save = useMutation({
    mutationFn: (body: { utm?: string; creative_proof_url?: string }) =>
      patchActivity(item.ticket_id, item.activity_id, body),
    onSuccess: done,
  });
  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    key: "utm" | "creative_proof_url",
    placeholder: string,
    button: string,
  ) => (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ [key]: value.trim() });
      }}
    >
      <Input
        aria-label={label}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 font-mono"
      />
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        disabled={!value.trim() || save.isPending}
      >
        {save.isPending && save.variables && key in save.variables && (
          <Loader2 className="animate-spin" />
        )}
        {button}
      </Button>
    </form>
  );
  return (
    <RowShell
      item={item}
      extra={
        canEdit && (
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
            {needsUtm && field("UTM", utm, setUtm, "utm", "campaign_name", "Add UTM")}
            {needsProof &&
              field(
                "Creative proof URL",
                proof,
                setProof,
                "creative_proof_url",
                "https://...",
                "Attach proof",
              )}
            <div className="sm:col-span-2 empty:hidden">
              <ErrorText error={save.error} />
            </div>
          </div>
        )
      }
    />
  );
}

function WaitingRow({ item }: { item: MarketingItem }) {
  const canEdit = useCan("activity.edit");
  const nudge = useMutation({ mutationFn: () => nudgeActivity(item.ticket_id, item.activity_id) });
  // ponytail: the queue doesn't return the CSM or the last nudge time, so the button says "CSM" and
  // shows only the nudge sent from this screen.
  return (
    <RowShell
      item={item}
      action={
        canEdit && (
          <Button
            variant="secondary"
            disabled={nudge.isPending || nudge.isSuccess}
            onClick={() => nudge.mutate()}
          >
            {nudge.isPending && <Loader2 className="animate-spin" />}
            {nudge.isSuccess ? "Nudged" : "Nudge CSM"}
          </Button>
        )
      }
      extra={
        <>
          {nudge.data && (
            <p className="mt-1.5 text-[13px] text-ink-2">
              {nudge.data.queued
                ? `Nudged ${nudge.data.recipients.join(", ")} just now`
                : "No Slack channel linked: nudge recorded but not sent"}
            </p>
          )}
          <ErrorText error={nudge.error} />
        </>
      }
    />
  );
}

function ResultsRow({ item }: { item: MarketingItem }) {
  const canEnter = useCan("metrics.enter");
  const done = useDone(item);
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => {
      const body: Parameters<typeof putMetrics>[2] = { date: yesterday() };
      for (const f of ["views", "clicks", "sent", "opens"] as const)
        if (v[f]) body[f] = Number(v[f]);
      return putMetrics(item.ticket_id, item.activity_id, body);
    },
    onSuccess: () => {
      setOpen(false);
      done();
    },
  });
  return (
    <RowShell
      item={item}
      action={
        canEnter && (
          <Button variant="secondary" onClick={() => setOpen(!open)}>
            Enter results
          </Button>
        )
      }
      extra={
        <>
          {open && (
            <form
              className="drawer-in mt-3 flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              {(["views", "clicks", "sent", "opens"] as const).map((f) => (
                <label key={f} className="space-y-1">
                  <FieldLabel>
                    {f}
                    {f === "sent" || f === "opens" ? " (email)" : ""}
                  </FieldLabel>
                  <Input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={v[f] ?? ""}
                    onChange={(e) => setV({ ...v, [f]: e.target.value })}
                    className="w-[110px] font-mono"
                  />
                </label>
              ))}
              <Button
                type="submit"
                size="sm"
                disabled={!["views", "clicks", "sent", "opens"].some((f) => v[f]) || save.isPending}
              >
                {save.isPending && <Loader2 className="animate-spin" />}Save for{" "}
                {formatDate(yesterday())}
              </Button>
            </form>
          )}
          {save.data?.totals.ctr != null && (
            <p className="mt-1.5 text-[13px] text-ink-2">
              Avg CTR to date: {save.data.totals.ctr.toFixed(1)}%
            </p>
          )}
          <ErrorText error={save.error} />
        </>
      }
    />
  );
}

// ---- right rail -------------------------------------------------------------------------

function GuardrailsCard() {
  return (
    <Card>
      <CardHeader title="How go-live works" />
      <CardBody className="space-y-3 text-[13px]">
        {[
          ["Approval first", "Nothing goes live without CSM approval."],
          [
            "UTM required",
            "An activity needs a UTM before it can go live and keeps it while live.",
          ],
          [
            "Results daily",
            "Live activities need yesterday's views and clicks, so the CTR stays accurate.",
          ],
        ].map(([t, d]) => (
          <div key={t}>
            <p className="font-medium">{t}</p>
            <p className="text-ink-2">{d}</p>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

function TelemetryCard({ tickets }: { tickets: string[] }) {
  const res = useQueries({ queries: tickets.slice(0, 12).map((t) => channelMetricsQuery(t)) });
  const channels = useMemo(() => {
    const m = new Map<string, { views: number; clicks: number; sent: number }>();
    for (const r of res)
      for (const c of r.data ?? []) {
        const cur = m.get(c.channel) ?? { views: 0, clicks: 0, sent: 0 };
        m.set(c.channel, {
          views: cur.views + c.totals.views,
          clicks: cur.clicks + c.totals.clicks,
          sent: cur.sent + c.totals.sent,
        });
      }
    return [...m.entries()]
      .map(([channel, t]) => ({
        channel,
        ...t,
        ctr: t.views || t.sent ? (t.clicks / (t.views || t.sent)) * 100 : null,
      }))
      .filter((c) => c.ctr !== null)
      .sort((a, b) => (b.ctr ?? 0) - (a.ctr ?? 0));
  }, [res]);
  const peak = Math.max(1, ...channels.map((c) => c.ctr ?? 0));
  const fmt = (n: number) => n.toLocaleString("en-US");
  return (
    <Card>
      <CardHeader title="Live telemetry" meta="CTR by channel" />
      <CardBody className="space-y-3">
        {res.some((r) => r.isLoading) && channels.length === 0 ? (
          <Skeleton className="h-24" />
        ) : channels.length === 0 ? (
          <p className="text-[13px] text-ink-2">No views or clicks logged yet.</p>
        ) : (
          channels.map((c, n) => (
            <div key={c.channel}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[14px] font-medium capitalize">{c.channel}</span>
                <span className="text-[14px] font-medium tabular-nums">
                  {c.ctr?.toFixed(1)}% CTR
                </span>
              </div>
              <Bar pct={((c.ctr ?? 0) / peak) * 100} tone="info" index={n} className="mt-1" />
              <div className="mt-1 flex justify-between text-[13px] tabular-nums text-ink-2">
                <span>{c.views ? `${fmt(c.views)} views` : `${fmt(c.sent)} sent`}</span>
                <span>{fmt(c.clicks)} clicks</span>
              </div>
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}

function AddChannelDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const programs = useQuery(portfolioFullQuery);
  const [ticket, setTicket] = useState("");
  const [channel, setChannel] = useState("");
  const [title, setTitle] = useState("");
  const add = useMutation({
    mutationFn: () => addChannel(ticket, { channel: channel.trim(), title: title.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["queues"] });
      void qc.invalidateQueries({ queryKey: ["programs", ticket, "activities"] });
      setChannel("");
      setTitle("");
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>Add unplanned channel</DialogTitle>
            <DialogDescription>
              Adds an activity to the program's marketing plan. It still needs a CSM approval before
              it goes live.
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1">
            <FieldLabel>Program</FieldLabel>
            <Select value={ticket} onValueChange={setTicket}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a program" />
              </SelectTrigger>
              <SelectContent>
                {(programs.data?.programs ?? []).map((p) => (
                  <SelectItem key={p.ticket_id} value={p.ticket_id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="block space-y-1">
            <FieldLabel>Channel</FieldLabel>
            <Input
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="email, social, community..."
              required
            />
          </label>
          <label className="block space-y-1">
            <FieldLabel>Title</FieldLabel>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <ErrorText error={add.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!ticket || !channel.trim() || !title.trim() || add.isPending}
            >
              {add.isPending && <Loader2 className="animate-spin" />}Add channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
