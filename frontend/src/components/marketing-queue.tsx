import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Bell,
  CalendarCheck,
  CheckCircle2,
  Link2,
  Loader2,
  Plus,
  Zap,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  Bar,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Dot,
  EmptyState,
  Kpi,
  MonoLabel,
  Num,
  Skeleton,
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

const SECTIONS: {
  kind: MarketingKind;
  title: string;
  caption: string;
  tone: Tone;
  urgent?: boolean;
}[] = [
  {
    kind: "ready_to_go_live",
    title: "Approved · Ready to go live",
    caption: "CSM approved, UTM in place",
    tone: "good",
  },
  {
    kind: "go_live_due",
    title: "Go-live due today or overdue",
    caption: "Approved and past its planned date",
    tone: "critical",
    urgent: true,
  },
  {
    kind: "missing_utm_or_proof",
    title: "Missing UTM or creative proof",
    caption: "A UTM is required to go live",
    tone: "serious",
  },
  {
    kind: "awaiting_approval",
    title: "Waiting for CSM approval",
    caption: "Read-only for marketing: nudge the CSM",
    tone: "info",
  },
  {
    kind: "results_to_record",
    title: "Results to record",
    caption: "Yesterday's views and clicks",
    tone: "indigo",
  },
];

const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

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
  const count = (k: MarketingKind) => shown.filter((i) => i.kind === k).length;
  const programsIn = (k: MarketingKind) =>
    new Set(shown.filter((i) => i.kind === k).map((i) => i.ticket_id)).size;

  return (
    <div className="page-in space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="t-headline-lg">Marketing Queue</h1>
          <p className="mt-1 max-w-2xl text-[14px] text-secondary-foreground">
            Channel execution across active programs. Go live only when approved, keep tracking
            intact, record daily results.
          </p>
        </div>
        {canAddChannel && (
          <Button onClick={() => setAdding(true)}>
            <Plus />
            Add unplanned channel
          </Button>
        )}
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
          <div className="reveal grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {(
              [
                ["Approved · Ready", "ready_to_go_live", "good"],
                ["Due today / overdue", "go_live_due", "critical"],
                ["Missing UTM / creative", "missing_utm_or_proof", "serious"],
                ["Waiting CSM approval", "awaiting_approval", "info"],
                ["Results to record", "results_to_record", "indigo"],
              ] as [string, MarketingKind, Tone][]
            ).map(([label, k, tone], n) => (
              <Kpi
                key={k}
                label={label}
                index={n}
                tone={count(k) > 0 ? tone : "neutral"}
                value={<Num value={count(k)} />}
                sub={`${programsIn(k)} program${programsIn(k) === 1 ? "" : "s"}`}
              />
            ))}
          </div>

          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Filter by program"
          >
            <MonoLabel>Quick filter</MonoLabel>
            {[
              [null, "All programs", items.length] as const,
              ...byProgram.map(([id, p]) => [id, p.name, p.n] as const),
            ].map(([id, name, n]) => (
              <button
                key={id ?? "all"}
                type="button"
                aria-pressed={program === id}
                onClick={() => setProgram(id)}
                className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Chip tone={program === id ? "info" : "neutral"} className="h-7 px-3">
                  {name} ({n})
                </Chip>
              </button>
            ))}
          </div>

          <div className="grid items-start gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="space-y-4">
              {shown.length === 0 ? (
                <EmptyState
                  icon={<CheckCircle2 />}
                  title="Nothing needs attention"
                  hint="No activity is waiting on a UTM, a go-live, an approval or results."
                />
              ) : (
                SECTIONS.map((s) => {
                  const rows = shown.filter((i) => i.kind === s.kind);
                  if (rows.length === 0) return null;
                  return (
                    <Card key={s.kind} className="overflow-hidden">
                      <header
                        className={cn(
                          "flex flex-wrap items-center justify-between gap-2 border-b border-border px-[18px] py-3",
                          s.urgent && "bg-status-critical/10",
                        )}
                      >
                        <h2 className="flex items-center gap-2 text-[16px] font-semibold tracking-[-0.01em]">
                          <Dot tone={s.tone} />
                          {s.title}
                          <Chip tone={s.tone}>
                            {rows.length} {rows.length === 1 ? "item" : "items"}
                          </Chip>
                        </h2>
                        <span className="t-data-sm text-muted-foreground">{s.caption}</span>
                      </header>
                      <ul className="reveal divide-y divide-border">
                        {rows.map((item, n) => (
                          <li key={item.id} className="row-hover" style={{ ["--i" as string]: n }}>
                            <Row item={item} />
                          </li>
                        ))}
                      </ul>
                    </Card>
                  );
                })
              )}
            </div>
            <aside className="space-y-5">
              <GuardrailsCard />
              <TelemetryCard tickets={program ? [program] : byProgram.map(([id]) => id)} />
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
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-[84px]" />
        ))}
      </div>
      <div className="grid gap-5 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-[150px]" />
          ))}
        </div>
        <div className="space-y-5">
          <Skeleton className="h-[200px]" />
          <Skeleton className="h-[200px]" />
        </div>
      </div>
    </div>
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
    <div className="px-[18px] py-3.5">
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
            <span className="text-muted-foreground"> · </span>
            {item.title}
          </p>
          <p className="mt-0.5 text-[13px] text-secondary-foreground">
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
              variant={urgent ? "danger" : "success"}
              disabled={live.isPending}
              onClick={() => live.mutate()}
            >
              {live.isPending ? (
                <Loader2 className="animate-spin" />
              ) : urgent ? (
                <Zap />
              ) : (
                <CalendarCheck />
              )}
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
        {save.isPending && save.variables && key in save.variables ? (
          <Loader2 className="animate-spin" />
        ) : (
          <Link2 />
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
            {needsUtm && field("UTM", utm, setUtm, "utm", "he_mark/program_channel", "Add UTM")}
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
            {nudge.isPending ? <Loader2 className="animate-spin" /> : <Bell />}
            {nudge.isSuccess ? "Nudged" : "Nudge CSM"}
          </Button>
        )
      }
      extra={
        <>
          {nudge.data && (
            <p className="mt-1.5 t-data-sm text-muted-foreground">
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
                  <MonoLabel>
                    {f}
                    {f === "sent" || f === "opens" ? " (email)" : ""}
                  </MonoLabel>
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
            <p className="mt-1.5 t-data-sm text-muted-foreground">
              Avg CTR to date: {(save.data.totals.ctr * 100).toFixed(1)}%
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
      <CardHeader title="Execution guardrails" meta="Governance" />
      <CardBody className="space-y-2.5">
        {[
          [
            "No unapproved live",
            "No activity goes live without a CSM approval. A live activity without one is flagged as a control breach.",
          ],
          [
            "UTM required",
            "An activity needs a UTM before it can go live, and keeps it while live.",
          ],
          [
            "Log results daily",
            "Live activities need yesterday's views and clicks recorded so the CTR stays accurate.",
          ],
        ].map(([t, d]) => (
          <div key={t} className="surface-inset rounded-lg px-3 py-2.5">
            <p className="text-[14px] font-semibold">{t}</p>
            <p className="mt-0.5 text-[13px] text-secondary-foreground">{d}</p>
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
          <p className="text-[13px] text-muted-foreground">No views or clicks logged yet.</p>
        ) : (
          channels.map((c, n) => (
            <div key={c.channel}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[14px] font-medium capitalize">{c.channel}</span>
                <span className="t-data-sm text-status-good">{c.ctr?.toFixed(1)}% CTR</span>
              </div>
              <Bar pct={((c.ctr ?? 0) / peak) * 100} tone="info" index={n} className="mt-1" />
              <div className="mt-1 flex justify-between t-data-sm text-muted-foreground">
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
            <MonoLabel>Program</MonoLabel>
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
            <MonoLabel>Channel</MonoLabel>
            <Input
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="email, social, community..."
              required
            />
          </label>
          <label className="block space-y-1">
            <MonoLabel>Title</MonoLabel>
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
