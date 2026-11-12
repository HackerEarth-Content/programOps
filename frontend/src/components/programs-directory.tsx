import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Search } from "lucide-react";
import {
  Avatar,
  Bar,
  Card,
  Chip,
  EmptyState,
  HealthPill,
  KpiCell,
  KpiStrip,
  Legend,
  PageHeader,
  SegBar,
  Segmented,
  Skeleton,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isHiringType, programsQueryOptions, STAGES, type Program } from "@/lib/api";
import { csmQueueQuery, HEALTH_REASONS, type Health } from "@/lib/ops-api";
import { portfolioFullQuery, type Portfolio, type PortfolioProgram } from "@/lib/portfolio-api";
import type { ProgramTab } from "@/lib/program-tabs";
import { usePersistentState } from "@/lib/utils";
import { NewInternalProgram } from "@/components/new-internal-program";
import { WeeklyBriefButton } from "@/components/weekly-brief";
import { systemStatusQuery } from "@/lib/system-api";

type Row = { program: Program; card: PortfolioProgram | undefined };
type View = "cards" | "matrix"; // "matrix" is the Table view (key kept so saved choices still apply)
type Sort = "urgency" | "registrations" | "name";
type Kind = "all" | "hackathon" | "hiring" | "internal";

const HEALTH_RANK: Record<Health, number> = { critical: 0, warning: 1, good: 2 };
const VIEW_KEY = "programops.directory.view";

const nameOf = (r: Row) => r.card?.name ?? r.program.display_name;
const clientOf = (r: Row) => r.card?.client ?? r.program.company_name;
const stageOf = (r: Row) => r.program.stage;
const kindOf = (r: Row): "hackathon" | "hiring" | "other" =>
  r.program.campaign_type === "Hackathon"
    ? "hackathon"
    : isHiringType(r.program.campaign_type)
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
    return localStorage.getItem(VIEW_KEY) === "cards" ? "cards" : "matrix"; // table is the default
  } catch {
    return "matrix";
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

const dash = <span className="text-ink-3">&mdash;</span>;
const fmt = (n: number) => n.toLocaleString("en-US");
const nextAction = (r: Row) => (r.card && r.card.health !== "good" ? reasonOf(r.card) : null);
const ownerOf = (r: Row) => r.program.csm_name ?? r.program.owner_name;

/** Six-step stage ladder: done and current steps filled, the rest empty. */
function Ladder({ stage }: { stage: string }) {
  const at = STAGES.indexOf(stage as (typeof STAGES)[number]);
  return (
    <div>
      <div
        role="img"
        aria-label={`Stage ${at + 1} of ${STAGES.length}`}
        className="flex max-w-[120px] gap-0.5"
      >
        {STAGES.map((s, i) => (
          <i
            key={s}
            className={`h-1 flex-1 rounded-full ${i < at ? "bg-ink-3" : i === at ? "bg-primary" : "bg-border"}`}
          />
        ))}
      </div>
      <div className="mt-1 text-[13px] text-ink-2">{stage}</div>
    </div>
  );
}

function regsLine(r: Row) {
  const target = r.card?.target;
  return target ? (
    <>
      {fmt(regsOf(r))} <span className="font-normal text-ink-2">/ {fmt(target)}</span>
    </>
  ) : (
    fmt(regsOf(r))
  );
}
const targetNote = (r: Row) =>
  r.card?.target ? `${Math.round(pct(r))}% of target` : "No target set";

function Kpis({ data, rows }: { data: Portfolio; rows: Row[] }) {
  const live = rows.filter(isLive);
  const liveBy = (k: "hackathon" | "hiring") => live.filter((r) => kindOf(r) === k).length;
  const closed = rows.filter((r) => !isOpen(r)).length;
  return (
    <KpiStrip label="Portfolio summary">
      <KpiCell
        label="Active programs"
        value={fmt(data.active_programs)}
        sub={closed ? `${closed} closed` : undefined}
      />
      <KpiCell
        label="Live now"
        value={fmt(live.length)}
        sub={`${liveBy("hackathon")} hackathon${liveBy("hackathon") === 1 ? "" : "s"} · ${liveBy("hiring")} hiring challenge${liveBy("hiring") === 1 ? "" : "s"}`}
      />
      <KpiCell
        label="Registrations"
        value={fmt(data.registrations_total)}
        sub={
          data.programs_with_target === 0
            ? "No targets set"
            : `${data.programs_on_target} of ${data.programs_with_target} programs with a target ${data.programs_on_target === 1 ? "is" : "are"} on pace`
        }
      />
      <KpiCell
        label="Needs attention"
        value={fmt(data.open_items)}
        sub={
          <Link to="/queue/csm" className="text-primary hover:underline">
            Open CSM queue
          </Link>
        }
      />
    </KpiStrip>
  );
}

function Widgets({ data, rows }: { data: Portfolio; rows: Row[] }) {
  const stages = STAGES.filter((s) => s !== "Closed" && data.stage_distribution[s]);
  const empty = STAGES.filter((s) => s !== "Closed" && !data.stage_distribution[s]);
  const closed = rows.filter((r) => !isOpen(r)).length;
  const open = rows.filter(isOpen);
  const noTarget = open.filter((r) => r.card && !r.card.target);
  const noClient = open.filter((r) => !clientOf(r));
  const gaps = [
    { label: "No registration target", rows: noTarget, n: noTarget.length, warn: true },
    { label: "Client not linked", rows: noClient, n: noClient.length, warn: false },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card>
        <div className="flex items-baseline gap-2 border-b border-border px-4 py-3">
          <h2 className="flex-1 text-[14px] font-semibold">Pipeline by stage</h2>
          <span className="text-[13px] text-ink-2">{data.active_programs} active programs</span>
        </div>
        <div className="px-4 py-3.5">
          <SegBar
            label={stages.map((s) => `${data.stage_distribution[s]} in ${s}`).join(", ")}
            parts={stages.map((s) => ({
              label: data.stage_distribution[s],
              value: data.stage_distribution[s] ?? 0,
            }))}
          />
          <div className="mt-2 flex text-[13px] text-ink-2" aria-hidden>
            {stages.map((s) => (
              <span
                key={s}
                className="min-w-0 truncate"
                style={{ flex: `${data.stage_distribution[s]} 1 0` }}
              >
                {s}
              </span>
            ))}
          </div>
          <div className="mt-2.5">
            <Legend
              items={[
                ...empty.map((s) => ({ label: `${s} 0`, muted: true })),
                ...(closed ? [{ label: `Closed ${closed}`, muted: true }] : []),
              ]}
            />
          </div>
        </div>
      </Card>
      <Card>
        <div className="flex items-baseline gap-2 border-b border-border px-4 py-3">
          <h2 className="flex-1 text-[14px] font-semibold">Setup gaps</h2>
          <span className="text-[13px] text-ink-2">Fields every program needs</span>
        </div>
        {gaps.every((g) => g.n === 0) ? (
          <p className="px-4 py-3 text-[13px] text-ink-2">
            Every active program has a target and a client.
          </p>
        ) : (
          gaps.map((g) => (
            <div
              key={g.label}
              className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-2.5 text-[14px] last:border-0"
            >
              <i
                aria-hidden
                className={`size-1.5 rounded-full ${g.n === 0 ? "bg-ok" : g.warn ? "bg-warn" : "bg-ink-3"}`}
              />
              <span>{g.label}</span>
              {g.n === 0 ? (
                <span className="font-medium">0 programs</span>
              ) : (
                // hover (or focus) lists which programs, each one a link
                <HoverCard openDelay={100} closeDelay={80}>
                  <HoverCardTrigger asChild>
                    <button
                      type="button"
                      className="font-medium underline decoration-dotted underline-offset-4"
                    >
                      {g.n} program{g.n === 1 ? "" : "s"}
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent align="end" className="w-72 p-2">
                    <p className="px-2 pb-1 pt-0.5 text-[12px] text-ink-2">{g.label}</p>
                    <ul>
                      {g.rows.map((r) => (
                        <li key={r.program.ticket_id}>
                          <Link
                            to="/programs/$ticketId"
                            params={{ ticketId: r.program.ticket_id }}
                            search={{ tab: "overview" }}
                            className="flex items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 text-[13px] hover:bg-raised"
                          >
                            <span className="min-w-0 truncate font-medium">{nameOf(r)}</span>
                            <span className="shrink-0 text-ink-2">{stageOf(r)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </HoverCardContent>
                </HoverCard>
              )}
            </div>
          ))
        )}
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
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-[18px] py-2">
        <span className="font-mono text-[12px] text-ink-3">{p.ticket_id}</span>
        <span className="truncate text-[12px] text-ink-3">{clientOf(row) ?? "No client"}</span>
      </div>
      <div className="flex flex-1 flex-col gap-3 px-[18px] pb-3 pt-3">
        <div className="flex items-start justify-between gap-3">
          {/* Every card keeps two title lines, so a long name never pushes the rows below out of line. */}
          <h3
            className="line-clamp-2 min-h-[44px] min-w-0 break-words text-[16px] font-semibold leading-[22px] tracking-[-0.01em]"
            title={nameOf(row)}
          >
            {nameOf(row)}
          </h3>
          <span className="shrink-0">
            <HealthChip card={card} />
          </span>
        </div>
        <div className="flex items-center gap-2 text-[13px]">
          <i aria-hidden className={`size-1.5 rounded-full ${card ? "bg-primary" : "bg-ink-3"}`} />
          <span className="shrink-0">{stageOf(row)}</span>
          {p.campaign_type && (
            <span className="ml-auto truncate text-muted-foreground">{p.campaign_type}</span>
          )}
        </div>
        {/* One reserved line whether or not there is a reason, so the rows below sit at the same height. */}
        <p
          className={`flex min-h-5 items-start gap-1.5 text-[13px] leading-5 ${critical ? "text-danger" : "text-warn"}`}
          title={reason ?? undefined}
        >
          {reason && (
            <>
              <i aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-current" />
              <span className="line-clamp-1">{reason}</span>
            </>
          )}
        </p>
        <div>
          <div className="flex justify-between text-[13px]">
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
        <div className="text-[13px]">
          <span className="text-ink-2">Marketing</span>
          <div className="mt-0.5 truncate">
            {card ? (
              <>
                {card.marketing_live} / {card.marketing_total} channels live
                {awaiting > 0 && (
                  <span className="text-muted-foreground"> · {awaiting} awaiting approval</span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">–</span>
            )}
          </div>
        </div>
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
              className="inline-flex min-h-6 items-center px-0.5 hover:text-foreground hover:underline"
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

function Table({ rows }: { rows: Row[] }) {
  return (
    <>
      <Card className="relative hidden overflow-x-auto md:block">
        <table className="w-full min-w-[860px] border-collapse">
          <thead>
            <tr className="border-b border-border text-left text-[13px] font-medium text-ink-2">
              <th className="w-[30%] px-4 py-2.5 font-medium">Program</th>
              <th className="w-[170px] px-3 py-2.5 font-medium">Stage</th>
              <th className="px-3 py-2.5 text-right font-medium">Registrations</th>
              <th className="px-3 py-2.5 font-medium">Marketing</th>
              <th className="px-3 py-2.5 font-medium">Next action</th>
              <th className="px-3 py-2.5 font-medium">Owner</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const action = nextAction(r);
              const owner = ownerOf(r);
              return (
                <tr
                  key={r.program.ticket_id}
                  className="row-hover border-b border-border align-top last:border-0"
                >
                  <td className="px-4 py-3">
                    <ProgramLink
                      id={r.program.ticket_id}
                      tab="overview"
                      className="text-[14px] font-medium hover:text-primary hover:underline"
                    >
                      {nameOf(r)}
                    </ProgramLink>
                    <div className="mt-0.5 text-[13px] text-ink-2">
                      <span className="font-mono text-[12px]">{r.program.ticket_id}</span> ·{" "}
                      {clientOf(r) ?? "No client"}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Ladder stage={stageOf(r)} />
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    <div className="text-[14px] font-medium">{regsLine(r)}</div>
                    <div className="mt-0.5 text-[13px] text-ink-2">{targetNote(r)}</div>
                  </td>
                  <td className="px-3 py-3 tabular-nums">
                    {r.card ? (
                      <>
                        <div className="text-[14px] font-medium">
                          {r.card.marketing_live} / {r.card.marketing_total} live
                        </div>
                        <div className="mt-0.5 text-[13px] text-ink-2">
                          {r.card.awaiting_approval > 0
                            ? `${r.card.awaiting_approval} awaiting approval`
                            : r.card.marketing_total === 0
                              ? "No plan yet"
                              : "Nothing awaiting"}
                        </div>
                      </>
                    ) : (
                      dash
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {action ? (
                      <Chip tone={r.card?.health === "critical" ? "critical" : "warning"}>
                        {action}
                      </Chip>
                    ) : (
                      dash
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {owner ? (
                      <span className="flex items-center gap-2 text-[13px]">
                        <Avatar name={owner} />
                        <span className="min-w-0 truncate">{owner}</span>
                        {r.program.csm_name && <Chip tone="csm">CSM</Chip>}
                      </span>
                    ) : (
                      dash
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <ul className="md:hidden">
        {rows.map((r) => {
          const action = nextAction(r);
          return (
            <li key={r.program.ticket_id} className="border-b border-border last:border-0">
              <ProgramLink
                id={r.program.ticket_id}
                tab="overview"
                className="flex min-h-11 items-center gap-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{nameOf(r)}</span>
                  <span className="block truncate text-[13px] text-ink-2">
                    {stageOf(r)} · {fmt(regsOf(r))}
                    {r.card?.target ? ` / ${fmt(r.card.target)}` : " · no target"}
                  </span>
                </span>
                {action ? (
                  <Chip
                    tone={r.card?.health === "critical" ? "critical" : "warning"}
                    className="max-w-[40%] truncate"
                  >
                    {action}
                  </Chip>
                ) : (
                  dash
                )}
              </ProgramLink>
            </li>
          );
        })}
      </ul>
    </>
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
  // The type tab scopes everything below it; Closed programs only show under the Closed stage.
  const inKind = useMemo(() => rows.filter((r) => inTab(r, kind)), [rows, kind]);
  const kindCount = (k: Kind) => rows.filter((r) => isOpen(r) && inTab(r, k)).length;
  const csms = useMemo(
    () =>
      [...new Set(inKind.map((r) => r.program.csm_name).filter((c): c is string => !!c))].sort(),
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
  const data = portfolio.data;
  const closedCount = inKind.filter((r) => !isOpen(r)).length;
  const finding = data
    ? data.open_items > 0
      ? `${data.open_items} action${data.open_items === 1 ? " is" : "s are"} waiting on ${data.programs.filter((p) => p.open_items > 0).length} of ${data.active_programs} programs.`
      : `Nothing is waiting in the CSM queue across ${data.active_programs} active programs.`
    : "Every active hackathon and hiring challenge, and what needs you on each.";
  const sel = "w-auto min-w-[120px]";

  return (
    <div className="page-in flex flex-col gap-4">
      <PageHeader
        title="Programs"
        subtitle={finding}
        actions={
          <>
            <WeeklyBriefButton />
            <Button variant="outline" disabled={!rows.length} onClick={() => exportCsv(shown)}>
              Export CSV
            </Button>
            <NewInternalProgram />
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
          <Skeleton className="h-[92px]" />
          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-[140px]" />
            ))}
          </div>
          <Skeleton className="h-[300px]" />
        </>
      ) : (
        <>
          {data && <Kpis data={data} rows={rows} />}
          {data && <Widgets data={data} rows={rows} />}
          <div className="flex flex-wrap items-center gap-2">
            <div className="max-w-full relative overflow-x-auto">
              <Segmented
                value={kind}
                onChange={setKind}
                options={(
                  [
                    ["all", "All"],
                    ["hackathon", "Hackathons"],
                    ["hiring", "Hiring challenges"],
                    ["internal", "Internal"],
                  ] as const
                ).map(([id, label]) => ({ id, label, count: kindCount(id) }))}
              />
            </div>
            <div className="relative min-w-[200px] flex-1 sm:max-w-[260px]">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3"
              />
              <Input
                aria-label="Search programs"
                className="pl-8"
                placeholder="Search program, ticket, client"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Select value={stage} onValueChange={setStage}>
              <SelectTrigger aria-label="Stage" className={sel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Stage: All</SelectItem>
                {STAGES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={healthFilter} onValueChange={setHealth}>
              <SelectTrigger aria-label="Health" className={sel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Health: All</SelectItem>
                <SelectItem value="good">Good</SelectItem>
                <SelectItem value="warning">At risk</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
            <Select value={csm} onValueChange={setCsm}>
              <SelectTrigger aria-label="CSM" className={sel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">CSM: All</SelectItem>
                {csms.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="hidden flex-1 md:block" />
            <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
              <SelectTrigger aria-label="Sort" className={sel}>
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
                { id: "matrix", label: "Table" },
                { id: "cards", label: "Cards" },
              ]}
            />
          </div>
          {shown.length === 0 ? (
            <EmptyState title="No programs match" hint="Adjust the search or filters." />
          ) : view === "matrix" ? (
            <Table rows={shown} />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((r, i) => (
                <ProgramCard key={r.program.ticket_id} row={r} index={i} />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-2 text-[13px] text-ink-2">
            <span>
              Showing {shown.length} of {inKind.length} programs
            </span>
            {closedCount > 0 && stage !== "Closed" && (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => setStage("Closed")}
                  className="text-primary hover:underline"
                >
                  Show {closedCount} closed
                </button>
              </>
            )}
            {stage !== "all" && (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => setStage("all")}
                  className="text-primary hover:underline"
                >
                  Back to active
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
