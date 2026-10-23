import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Download, LayoutGrid, Rows3, Search, TriangleAlert } from "lucide-react";
import {
  Avatar,
  Bar,
  Card,
  Chip,
  Dot,
  EmptyState,
  HealthPill,
  MonoLabel,
  Num,
  PageHeader,
  Segmented,
  Skeleton,
  TabBar,
  toneBg,
  toneText,
  type Tone,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HIRING_CAMPAIGN_TYPE, programsQueryOptions, STAGES, type Program } from "@/lib/api";
import { csmQueueQuery, HEALTH_REASONS, type Health } from "@/lib/ops-api";
import { portfolioFullQuery, type Portfolio, type PortfolioProgram } from "@/lib/portfolio-api";
import type { ProgramTab } from "@/lib/program-tabs";
import { usePersistentState } from "@/lib/utils";
import { NewInternalProgram } from "@/components/new-internal-program";
import { WeeklyBriefButton } from "@/components/weekly-brief";
import { systemStatusQuery } from "@/lib/system-api";

type Row = { program: Program; card: PortfolioProgram | undefined };
type View = "cards" | "matrix";
type Sort = "urgency" | "registrations" | "name";
type Kind = "all" | "hackathon" | "hiring" | "internal";

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
const HEALTH_RANK: Record<Health, number> = { critical: 0, warning: 1, good: 2 };
const VIEW_KEY = "programops.directory.view";
const idx = (n: number) => ({ "--i": n }) as CSSProperties;

const nameOf = (r: Row) => r.card?.name ?? r.program.display_name;
const clientOf = (r: Row) => r.card?.client ?? r.program.company_name;
const stageOf = (r: Row) => r.program.stage;
const kindOf = (r: Row): "hackathon" | "hiring" | "other" =>
  r.program.campaign_type === "Hackathon"
    ? "hackathon"
    : r.program.campaign_type === HIRING_CAMPAIGN_TYPE
      ? "hiring"
      : "other";
const inTab = (r: Row, k: Kind) =>
  k === "all" || (k === "internal" ? r.program.origin === "internal" : kindOf(r) === k);
const isLive = (r: Row) => stageOf(r) === "Ongoing"; // ponytail: live = Ongoing stage; Redash "Is Live" is the precise upgrade
const isOpen = (r: Row) => stageOf(r) !== "Closed";
const regsOf = (r: Row) => r.card?.registrations ?? r.program.registrations ?? 0;
const rank = (r: Row) => (r.card ? HEALTH_RANK[r.card.health] : 3);
const pct = (r: Row) => (r.card?.target ? (regsOf(r) / r.card.target) * 100 : 0);
const reasonOf = (c: PortfolioProgram) =>
  c.reasons[0] ? (HEALTH_REASONS[c.reasons[0]] ?? c.reasons[0]) : null;

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "matrix" ? "matrix" : "cards";
  } catch {
    return "cards";
  }
}

function exportCsv(rows: Row[]) {
  const q = (v: string | number | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = [
    "Name",
    "Ticket",
    "Client",
    "Type",
    "Stage",
    "CSM",
    "Registrations",
    "Target",
    "Health",
  ];
  const lines = rows.map((r) =>
    [
      nameOf(r),
      r.program.ticket_id,
      clientOf(r),
      r.program.campaign_type,
      stageOf(r),
      r.program.csm_name,
      regsOf(r),
      r.card?.target,
      r.card?.health ?? "closed",
    ]
      .map(q)
      .join(","),
  );
  const url = URL.createObjectURL(
    new Blob([[head.map(q).join(","), ...lines].join("\n")], { type: "text/csv" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `portfolio-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function ProgramLink({
  id,
  tab,
  children,
  className,
}: {
  id: string;
  tab: ProgramTab;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link to="/programs/$ticketId" params={{ ticketId: id }} search={{ tab }} className={className}>
      {children}
    </Link>
  );
}

function HealthChip({ card }: { card: PortfolioProgram | undefined }) {
  if (!card) return <Chip>Closed</Chip>;
  return <HealthPill health={card.health} />;
}

function Kpis({ data, rows, onKind }: { data: Portfolio; rows: Row[]; onKind: (k: Kind) => void }) {
  const mine = useQuery(csmQueueQuery("mine")).data?.items.length;
  const live = rows.filter(isLive);
  const liveBy = (k: "hackathon" | "hiring") => live.filter((r) => kindOf(r) === k).length;
  const { health, action_items: ai } = data;
  const total = data.active_programs || 1;
  const stages = STAGES.filter((s) => data.stage_distribution[s]);
  return (
    <div className="reveal grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <Card interactive className="rise p-[18px]" style={idx(0)}>
        <MonoLabel>Active portfolio</MonoLabel>
        <div className="mt-2 t-data-lg">
          <Num value={data.active_programs} /> programs
        </div>
        <div className="mt-3 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-secondary">
          {(["good", "warning", "critical"] as const).map(
            (h) =>
              health[h] > 0 && (
                <div
                  key={h}
                  className={`bar-grow h-full ${toneBg(HEALTH_TONE[h])}`}
                  style={{ width: `${(health[h] / total) * 100}%` }}
                />
              ),
          )}
        </div>
        <div className="mt-2 flex justify-between t-data-sm text-muted-foreground">
          <span>
            {health.good} good · {health.warning} at risk
          </span>
          <span className={health.critical ? toneText("critical") : ""}>
            {health.critical} critical
          </span>
        </div>
      </Card>
      <Card interactive className="rise p-[18px]" style={idx(1)}>
        <MonoLabel>Live programs</MonoLabel>
        <div className="mt-2 t-data-lg">
          <Num value={live.length} /> live
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {(
            [
              ["hackathon", "Hackathons"],
              ["hiring", "Hiring challenges"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => onKind(k)}
              className="rounded-[8px] bg-raised px-3 py-2 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="block t-data-lg">{liveBy(k)}</span>
              <span className="block text-[13px] text-ink-2">{label}</span>
            </button>
          ))}
        </div>
      </Card>
      <Card interactive className="rise p-[18px]" style={idx(2)}>
        <MonoLabel>Programs on target</MonoLabel>
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="t-data-lg">
            <Num value={data.programs_on_target} />
          </span>
          <span className="t-data-sm text-muted-foreground">
            of {data.programs_with_target} with a target
          </span>
        </div>
        <Bar
          pct={
            data.programs_with_target
              ? (data.programs_on_target / data.programs_with_target) * 100
              : 0
          }
          tone="good"
          className="mt-3"
        />
        <div className="mt-2 t-data-sm text-muted-foreground">
          {data.programs_with_target === 0
            ? "No targets set"
            : `${data.registrations_total.toLocaleString("en-US")} registrations across ${data.active_programs} active programs`}
        </div>
      </Card>
      <Card interactive className="rise p-[18px] xl:col-span-2" style={idx(3)}>
        <div className="flex justify-between">
          <MonoLabel>Pipeline stage distribution</MonoLabel>
          <span className="t-data-sm text-muted-foreground">{data.active_programs} total</span>
        </div>
        <div className="mt-4 flex gap-1">
          {stages.map((s, i) => (
            <div
              key={s}
              title={`${s}: ${data.stage_distribution[s]}`}
              className="flex min-w-20 flex-col gap-1.5"
              style={{ flexGrow: data.stage_distribution[s] ?? 0 }}
            >
              <div
                className="bar-grow flex h-11 items-center justify-center rounded-[6px] bg-accent-bg text-[16px] font-semibold text-primary"
                style={idx(i)}
              >
                {data.stage_distribution[s]}
              </div>
              <span className="truncate text-center text-[13px] text-secondary-foreground">
                {s}
              </span>
            </div>
          ))}
        </div>
      </Card>
      <Card interactive className="rise p-[18px]" style={idx(4)}>
        <div className="flex justify-between">
          <MonoLabel>Needs attention</MonoLabel>
          {ai.control_breaches > 0 && <Chip tone="critical">Triage required</Chip>}
        </div>
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className={`t-data-lg ${data.open_items ? "" : toneText("good")}`}>
            <Num value={data.open_items} />
          </span>
          <span className="t-data-sm text-muted-foreground">open in the CSM queue</span>
        </div>
        <div className="mt-3 t-data-sm text-muted-foreground">
          {mine === undefined ? "All programs" : `${mine} on your programs`} · across{" "}
          {data.programs.filter((p) => p.open_items > 0).length} of {data.active_programs} programs
          {ai.control_breaches ? ` · ${ai.control_breaches} control breaches` : ""}
        </div>
        <Link
          to="/queue/csm"
          className="mt-2 inline-flex items-center gap-1 t-data-sm text-primary hover:underline"
        >
          Open CSM queue <ArrowRight className="size-3" />
        </Link>
      </Card>
    </div>
  );
}

function ProgramCard({ row, index }: { row: Row; index: number }) {
  const { program: p, card } = row;
  const critical = card?.health === "critical";
  const regs = regsOf(row);
  const reason = card && card.health !== "good" ? reasonOf(card) : null;
  const awaiting = card?.awaiting_approval ?? 0;
  const tabs: { tab: ProgramTab; label: string; n?: number }[] = [
    { tab: "overview", label: "Overview" },
    { tab: "marketing", label: "Marketing", n: awaiting },
    { tab: "registrations", label: "Registrations" },
    { tab: "rounds", label: "Rounds" },
  ];
  return (
    <Card
      interactive
      className="rise flex flex-col overflow-hidden"
      style={idx(Math.min(index, 12))}
    >
      <div className="flex items-center justify-between gap-2 px-[18px] py-2">
        <span className="font-mono text-[12px] text-ink-3">{p.ticket_id}</span>
        <span className="truncate text-[12px] text-ink-3">{clientOf(row) ?? "No client"}</span>
      </div>
      <div className="flex flex-1 flex-col gap-3 px-[18px] pb-3 pt-3">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-[16px] font-semibold leading-[22px] tracking-[-0.01em]">
            {nameOf(row)}
          </h3>
          <HealthChip card={card} />
        </div>
        <div className="flex items-center gap-2 rounded-md bg-secondary px-2.5 py-1.5 t-data-sm">
          <Dot tone={card ? "info" : "neutral"} />
          {stageOf(row)}
          {p.campaign_type && (
            <span className="ml-auto truncate text-muted-foreground">{p.campaign_type}</span>
          )}
        </div>
        {reason && (
          <p
            className={`flex items-start gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 text-[13px] ${critical ? toneText("critical") : toneText("warning")}`}
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            {reason}
          </p>
        )}
        <div>
          <div className="flex justify-between t-data-sm">
            <span className="text-muted-foreground">Registrations</span>
            <span>
              {regs.toLocaleString("en-US")}
              {card?.target ? ` / ${card.target.toLocaleString("en-US")}` : ""}
            </span>
          </div>
          <Bar
            pct={pct(row)}
            tone={critical ? "critical" : "info"}
            className="mt-1.5"
            index={index}
          />
        </div>
        {card && (
          <div className="t-data-sm">
            <MonoLabel>Marketing ramp</MonoLabel>
            <div className="mt-0.5">
              {card.marketing_live} / {card.marketing_total} channels live
              {awaiting > 0 && (
                <span className="text-muted-foreground"> · {awaiting} awaiting approval</span>
              )}
            </div>
          </div>
        )}
        <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-[13px] text-secondary-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <Avatar name={p.csm_name} />
            <span className="truncate">{p.csm_name ?? "No CSM"}</span>
          </span>
          <span className="truncate text-muted-foreground">
            AM: {p.account_manager_name ?? "Unassigned"}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-[18px] py-2.5">
        <nav className="flex flex-wrap gap-x-3 text-[13px] text-secondary-foreground">
          {tabs.map((t) => (
            <ProgramLink
              key={t.tab}
              id={p.ticket_id}
              tab={t.tab}
              className="hover:text-foreground hover:underline"
            >
              {t.label}
              {t.n ? <span className="ml-1 text-[12px] text-muted-foreground">{t.n}</span> : null}
            </ProgramLink>
          ))}
        </nav>
        <Button asChild size="sm" variant="outline">
          <ProgramLink id={p.ticket_id} tab="overview">
            Open <ArrowRight />
          </ProgramLink>
        </Button>
      </div>
    </Card>
  );
}

function Matrix({ rows }: { rows: Row[] }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse">
        <thead>
          <tr className="border-b border-border text-left">
            {[
              "Program",
              "Client",
              "Stage",
              "CSM",
              "Health",
              "Marketing",
              "Registrations",
              "Target",
            ].map((h, i) => (
              <th key={h} className={`t-th px-3 py-2 ${i >= 6 ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.program.ticket_id}
              className="row-hover h-[34px] border-b border-border last:border-0"
            >
              <td className="px-3">
                <ProgramLink
                  id={r.program.ticket_id}
                  tab="overview"
                  className="font-medium hover:underline"
                >
                  {nameOf(r)}
                </ProgramLink>{" "}
                <span className="t-data-sm text-muted-foreground">{r.program.ticket_id}</span>
              </td>
              <td className="px-3 text-secondary-foreground">{clientOf(r) ?? "-"}</td>
              <td className="px-3 t-data-sm">{stageOf(r)}</td>
              <td className="px-3 text-secondary-foreground">{r.program.csm_name ?? "-"}</td>
              <td className="px-3">
                <HealthChip card={r.card} />
              </td>
              <td className="px-3 t-data-sm">
                {r.card ? `${r.card.marketing_live}/${r.card.marketing_total}` : "-"}
              </td>
              <td className="px-3 text-right t-data-sm">{regsOf(r).toLocaleString("en-US")}</td>
              <td className="px-3 text-right t-data-sm">
                {r.card?.target?.toLocaleString("en-US") ?? "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function ProgramsDirectory() {
  const programs = useQuery(programsQueryOptions);
  const portfolio = useQuery(portfolioFullQuery);
  const [view, setViewState] = useState<View>(readView);
  const [q, setQ] = useState("");
  const [health, setHealth] = usePersistentState("programops.directory.health", "all");
  const [csm, setCsm] = usePersistentState("programops.directory.csm", "all");
  const [stage, setStage] = usePersistentState("programops.directory.stage", "all");
  const [kindValue, setKind] = usePersistentState("programops.directory.kind", "all");
  const kind = (
    ["hackathon", "hiring", "internal"].includes(kindValue) ? kindValue : "all"
  ) as Kind;
  const [sortValue, setSort] = usePersistentState("programops.directory.sort", "urgency");
  const sort = (
    ["urgency", "registrations", "name"].includes(sortValue) ? sortValue : "urgency"
  ) as Sort;

  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage unavailable: view just isn't remembered */
    }
  };

  const rows = useMemo<Row[]>(() => {
    const cards = new Map((portfolio.data?.programs ?? []).map((c) => [c.ticket_id, c]));
    return (programs.data ?? []).map((program) => ({
      program,
      card: cards.get(program.ticket_id),
    }));
  }, [programs.data, portfolio.data]);
  // The type tab scopes everything below it; Closed programs only show under the Closed stage pill.
  const inKind = useMemo(() => rows.filter((r) => inTab(r, kind)), [rows, kind]);
  const kindCount = (k: Kind) => rows.filter((r) => isOpen(r) && inTab(r, k)).length;
  const csms = useMemo(
    () =>
      [...new Set(inKind.map((r) => r.program.csm_name).filter((c): c is string => !!c))].sort(),
    [inKind],
  );
  const stageCounts = useMemo(
    () => Object.fromEntries(STAGES.map((s) => [s, inKind.filter((r) => stageOf(r) === s).length])),
    [inKind],
  );
  const healthFilter = ["good", "warning", "critical"].includes(health) ? health : "all";
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return inKind
      .filter(
        (r) =>
          (stage === "all" ? isOpen(r) : stageOf(r) === stage) &&
          (csm === "all" || r.program.csm_name === csm) &&
          (healthFilter === "all" || r.card?.health === healthFilter),
      )
      .filter(
        (r) =>
          !needle ||
          [nameOf(r), clientOf(r), r.program.csm_name, r.program.ticket_id].some((v) =>
            v?.toLowerCase().includes(needle),
          ),
      )
      .sort(
        (a, b) =>
          (sort === "registrations"
            ? regsOf(b) - regsOf(a)
            : sort === "urgency"
              ? rank(a) - rank(b)
              : 0) || nameOf(a).localeCompare(nameOf(b)),
      );
  }, [inKind, q, stage, csm, healthFilter, sort]);

  const loading = programs.isPending || portfolio.isPending;
  const error = programs.error ?? portfolio.error;

  return (
    <div className="page-in flex flex-col gap-4">
      <PageHeader
        label="Portfolio"
        title="Programs Directory"
        subtitle="Every active hackathon and hiring challenge, and what needs you on each."
        actions={
          <>
            <NewInternalProgram />
            <WeeklyBriefButton />
            <Button variant="outline" disabled={!rows.length} onClick={() => exportCsv(shown)}>
              <Download /> Export portfolio CSV
            </Button>
          </>
        }
      />
      {error ? (
        <EmptyState
          title="Could not load the portfolio"
          hint={error.message}
          action={
            <Button
              variant="outline"
              onClick={() => {
                void programs.refetch();
                void portfolio.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : loading ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[120px]" />
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-[280px]" />
            ))}
          </div>
        </>
      ) : (
        <>
          {portfolio.data && <Kpis data={portfolio.data} rows={rows} onKind={setKind} />}
          <TabBar
            label="Program type"
            active={kind}
            items={(
              [
                ["all", "All programs"],
                ["hackathon", "Hackathons"],
                ["hiring", "Hiring challenges"],
                ["internal", "Internal"],
              ] as const
            ).map(([id, label]) => ({ id, label: `${label} · ${kindCount(id)}` }))}
            renderLink={(t, props) => (
              <button type="button" onClick={() => setKind(t.id)} {...props} />
            )}
          />
          <Card className="flex flex-col gap-3 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[220px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search programs"
                  className="pl-8"
                  placeholder="Search by program, ticket, client or CSM"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <Select value={healthFilter} onValueChange={setHealth}>
                <SelectTrigger aria-label="Health" className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All health</SelectItem>
                  <SelectItem value="good">Good</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
              <Select value={csm} onValueChange={setCsm}>
                <SelectTrigger aria-label="CSM" className="w-[170px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All CSMs</SelectItem>
                  {csms.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
                <SelectTrigger aria-label="Sort" className="w-[170px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="urgency">Sort: Urgency</SelectItem>
                  <SelectItem value="registrations">Sort: Registrations</SelectItem>
                  <SelectItem value="name">Sort: Name</SelectItem>
                </SelectContent>
              </Select>
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  {
                    id: "cards",
                    label: (
                      <>
                        <LayoutGrid className="size-3.5" />
                        Cards
                      </>
                    ),
                  },
                  {
                    id: "matrix",
                    label: (
                      <>
                        <Rows3 className="size-3.5" />
                        Matrix
                      </>
                    ),
                  },
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <MonoLabel className="mr-1">Stages</MonoLabel>
              {[
                { id: "all", label: "All", n: inKind.filter(isOpen).length },
                ...STAGES.map((s) => ({
                  id: s as string,
                  label: s as string,
                  n: stageCounts[s] ?? 0,
                })),
              ].map((s) => (
                <button
                  key={s.id}
                  onClick={() => setStage(s.id)}
                  aria-pressed={stage === s.id}
                  className={`h-7 rounded-full border px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${stage === s.id ? "border-primary bg-accent-fill text-on-accent" : "border-border text-secondary-foreground hover:bg-secondary"}`}
                >
                  {s.label} <span className="text-[12px] ">{s.n}</span>
                </button>
              ))}
            </div>
          </Card>
          {shown.length === 0 ? (
            <EmptyState title="No programs match" hint="Adjust the search or filters." />
          ) : view === "matrix" ? (
            <Matrix rows={shown} />
          ) : (
            <div className="reveal grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((r, i) => (
                <ProgramCard key={r.program.ticket_id} row={r} index={i} />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-4 py-2.5 t-data-sm text-muted-foreground">
            <span>
              Showing {shown.length} of {inKind.length} programs
            </span>
          </div>
        </>
      )}
    </div>
  );
}
