import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  CircleDollarSign,
  Clock3,
  Filter,
  Layers3,
  Loader2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DueToday } from "@/components/program-documents";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WeeklyBriefDialog } from "@/components/weekly-brief";
import {
  HIRING_CAMPAIGN_TYPE,
  STAGES,
  campaignTypesQueryOptions,
  checklistStatusQueryOptions,
  eventsQueryOptions,
  programsQueryOptions,
  type CampaignTypeCount,
  type EventCount,
  type Stage,
} from "@/lib/api";
import { formatCompactMoney, formatDate, formatMoney, orUnassigned, orUnset } from "@/lib/format";
import { cn } from "@/lib/utils";

const chartColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function CountUp({ value, money = false }: { value: number; money?: boolean }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min((now - start) / 750, 1);
      setShown(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{money ? formatCompactMoney(shown) : shown}</>;
}

const stageStyles: Record<Stage, string> = {
  New: "bg-stage-new text-stage-new-foreground",
  "Pre Sales": "bg-stage-presales text-stage-presales-foreground",
  Onboarding: "bg-stage-onboarding text-stage-onboarding-foreground",
  Ongoing: "bg-stage-ongoing text-stage-ongoing-foreground",
  "Post Campaign": "bg-stage-post text-stage-post-foreground",
  Closed: "bg-stage-closed text-stage-closed-foreground",
};

const VIEW_CAMPAIGN_TYPE: Record<"hackathons" | "hiring", string> = {
  hackathons: "Hackathon",
  hiring: HIRING_CAMPAIGN_TYPE,
};

type Filters = {
  campaignTypes: Set<string>;
  accountManagers: Set<string>;
  csms: Set<string>;
  owners: Set<string>;
  blockedOnly: boolean;
};

const emptyFilters = (): Filters => ({
  campaignTypes: new Set(),
  accountManagers: new Set(),
  csms: new Set(),
  owners: new Set(),
  blockedOnly: false,
});

const filterCount = (f: Filters) =>
  f.campaignTypes.size +
  f.accountManagers.size +
  f.csms.size +
  f.owners.size +
  (f.blockedOnly ? 1 : 0);

export function Dashboard() {
  const [stage, setStage] = useState<Stage | "All">("All");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const { view } = useSearch({ from: "/" });

  const programsQuery = useQuery(programsQueryOptions);
  const checklistQuery = useQuery(checklistStatusQueryOptions);
  const campaignTypesQuery = useQuery(campaignTypesQueryOptions);
  const eventsQuery = useQuery(eventsQueryOptions);

  const isLoading =
    programsQuery.isLoading ||
    checklistQuery.isLoading ||
    campaignTypesQuery.isLoading ||
    eventsQuery.isLoading;
  const isError =
    programsQuery.isError ||
    checklistQuery.isError ||
    campaignTypesQuery.isError ||
    eventsQuery.isError;

  // Fallback to empty data (never conditionally skip the hooks below --
  // React requires every hook to run on every render) -- the actual
  // loading/error UI is chosen once, in the single return at the bottom.
  const programs = programsQuery.data ?? [];
  const checklistStatuses = checklistQuery.data ?? [];
  const campaignTypes = campaignTypesQuery.data ?? [];
  const eventBreakdown = eventsQuery.data ?? [];

  // Scoping to a program type (?view=hackathons|hiring) recomputes every
  // downstream metric from the already-fetched `programs` list, the same way
  // the unscoped "All programs" case derives its own stage counts -- one
  // source of truth instead of a separate scoped-vs-unscoped aggregation path.
  const scopeCampaignType = view ? VIEW_CAMPAIGN_TYPE[view] : null;
  const scopedPrograms = useMemo(
    () =>
      scopeCampaignType ? programs.filter((p) => p.campaign_type === scopeCampaignType) : programs,
    [programs, scopeCampaignType],
  );
  const scopedTicketIds = useMemo(
    () => new Set(scopedPrograms.map((p) => p.ticket_id)),
    [scopedPrograms],
  );
  const scopedChecklists = scopeCampaignType
    ? checklistStatuses.filter((c) => scopedTicketIds.has(c.ticket_id))
    : checklistStatuses;
  // Campaign mix covers active programs only (the API already excludes Closed).
  const mixPrograms = scopedPrograms.filter((p) => p.stage !== "Closed");
  const scopedCampaignTypes: CampaignTypeCount[] = scopeCampaignType
    ? Array.from(new Set(mixPrograms.map((p) => p.campaign_type ?? "Unset"))).map(
        (campaign_type) => ({
          campaign_type,
          count: mixPrograms.filter((p) => (p.campaign_type ?? "Unset") === campaign_type).length,
        }),
      )
    : campaignTypes;
  const scopedEvents: EventCount[] = scopeCampaignType
    ? scopedPrograms.map((p) => ({
        event_name: p.event_name ?? "Unnamed",
        stage: p.stage,
        count: 1,
      }))
    : eventBreakdown;
  const viewLabel =
    view === "hackathons" ? "Hackathons" : view === "hiring" ? "Hiring Challenges" : "All programs";

  const activePrograms = scopedPrograms.filter((p) => p.stage !== "Closed");
  const pipelineValue = activePrograms.reduce((sum, p) => sum + (p.expected_deal_size ?? 0), 0);
  // A program is genuinely blocked when it still has pending checklist items
  // for its current stage -- the backend already returns an empty
  // pending_items list for New/Closed (no checklist there), so this needs no
  // separate hardcoded list of "which tickets count as blocked".
  const blocked = scopedChecklists.filter((c) => c.pending_items.length > 0);
  const visible =
    stage === "All" ? scopedPrograms : scopedPrograms.filter((p) => p.stage === stage);
  const attention = [...blocked]
    .sort((a, b) => b.pending_items.length - a.pending_items.length)
    .slice(0, 6);
  const stageData = STAGES.map((name) => ({
    stage: name,
    count: scopedPrograms.filter((p) => p.stage === name).length,
    value: scopedPrograms
      .filter((p) => p.stage === name)
      .reduce((sum, p) => sum + (p.expected_deal_size ?? 0), 0),
  }));
  const maxStage = Math.max(1, ...stageData.map((item) => item.count));
  const blockedTicketIds = useMemo(() => new Set(blocked.map((c) => c.ticket_id)), [blocked]);

  const distinctCampaignTypes = useMemo(
    () => Array.from(new Set(scopedPrograms.map((p) => p.campaign_type ?? "Uncategorized"))).sort(),
    [scopedPrograms],
  );
  const distinctAccountManagers = useMemo(
    () =>
      Array.from(
        new Set(scopedPrograms.map((p) => p.account_manager_name).filter((v): v is string => !!v)),
      ).sort(),
    [scopedPrograms],
  );
  const distinctCsms = useMemo(
    () =>
      Array.from(
        new Set(scopedPrograms.map((p) => p.csm_name).filter((v): v is string => !!v)),
      ).sort(),
    [scopedPrograms],
  );
  const distinctOwners = useMemo(
    () =>
      Array.from(
        new Set(scopedPrograms.map((p) => p.owner_name).filter((v): v is string => !!v)),
      ).sort(),
    [scopedPrograms],
  );

  const filtered = useMemo(
    () =>
      visible.filter((p) => {
        if (
          filters.campaignTypes.size &&
          !filters.campaignTypes.has(p.campaign_type ?? "Uncategorized")
        )
          return false;
        if (
          filters.accountManagers.size &&
          !(p.account_manager_name && filters.accountManagers.has(p.account_manager_name))
        )
          return false;
        if (filters.csms.size && !(p.csm_name && filters.csms.has(p.csm_name))) return false;
        if (filters.owners.size && !(p.owner_name && filters.owners.has(p.owner_name)))
          return false;
        if (filters.blockedOnly && !blockedTicketIds.has(p.ticket_id)) return false;
        return true;
      }),
    [visible, filters, blockedTicketIds],
  );
  const rollups = useMemo(() => filtered.slice(0, 8), [filtered]);
  const activeFilterCount = filterCount(filters);

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">Couldn't load the dashboard.</p>
        <Button
          variant="outline"
          onClick={() => {
            programsQuery.refetch();
            checklistQuery.refetch();
            campaignTypesQuery.refetch();
            eventsQuery.refetch();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="page-enter space-y-8">
      <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-primary">
            <span className="h-px w-6 bg-primary" />
            {view
              ? view === "hackathons"
                ? "Hackathon programs"
                : "Hiring challenge programs"
              : "Live operating view"}
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-normal sm:text-4xl">
            ProgramOps
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
            {view
              ? `Showing ${viewLabel.toLowerCase()} only, every metric below reflects this view.`
              : "A calm view of every program, from first conversation to campaign close."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <WeeklyBriefDialog />
        </div>
      </section>

      <DueToday />

      <section className="grid gap-4 md:grid-cols-3">
        <Kpi
          icon={BriefcaseBusiness}
          label="Active programs"
          value={<CountUp value={activePrograms.length} />}
          note="Across 5 live stages"
        />
        <Kpi
          icon={CircleDollarSign}
          label="Active pipeline"
          value={<CountUp value={pipelineValue} money />}
          note="Expected deal value"
        />
        <Kpi
          icon={AlertTriangle}
          label="Blocked / stalled"
          value={<CountUp value={blocked.length} />}
          note="Needs intervention"
          warning={blocked.length > 0}
        />
      </section>

      <section className="workspace-panel px-5 py-6 sm:px-7 sm:py-7">
        <div className="mb-7 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <p className="section-kicker">Pipeline flow</p>
            <h2 className="section-title">Every program, one clear path</h2>
          </div>
          <p className="max-w-md text-sm text-muted-foreground">
            Select a stage to focus the operating list. Bar height shows program volume; value shows
            commercial weight.
          </p>
        </div>
        <div className="grid grid-cols-2 items-end gap-2 md:grid-cols-6">
          {stageData.map((item, index) => {
            const height = item.count === 0 ? 14 : 36 + (item.count / maxStage) * 112;
            return (
              <Button
                key={item.stage}
                variant="ghost"
                onClick={() => setStage(stage === item.stage ? "All" : item.stage)}
                className={cn(
                  "funnel-step group h-auto min-w-0 flex-col items-stretch justify-end gap-3 p-0 text-left hover:bg-transparent",
                  stage === item.stage && "is-active",
                )}
                style={{ animationDelay: `${index * 80}ms` }}
              >
                <span className="flex items-baseline justify-between px-1">
                  <strong className="font-display text-2xl">{item.count}</strong>
                  <span className="text-xs text-muted-foreground">
                    {formatCompactMoney(item.value)}
                  </span>
                </span>
                <span
                  className={cn(
                    "relative block w-full overflow-hidden rounded-t-md border border-b-0 border-border/70 transition-all duration-300 group-hover:-translate-y-1 group-hover:brightness-125",
                    stageStyles[item.stage],
                  )}
                  style={{ height }}
                >
                  <span className="absolute inset-x-0 top-0 h-px bg-foreground/40" />
                </span>
                <span className="min-h-9 px-1 text-xs font-semibold leading-4 text-foreground sm:text-sm">
                  {item.stage}
                </span>
              </Button>
            );
          })}
        </div>
        {stage !== "All" && (
          <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
            <span className="size-2 rounded-full bg-primary" /> Showing {visible.length} program
            {visible.length === 1 ? "" : "s"} in{" "}
            <strong className="text-foreground">{stage}</strong>
            <Button variant="link" className="h-auto p-0" onClick={() => setStage("All")}>
              Clear
            </Button>
          </div>
        )}
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.55fr_0.85fr]">
        <div className="min-w-0">
          <div className="mb-4 flex items-end justify-between">
            <div>
              <p className="section-kicker text-warning">Needs attention</p>
              <h2 className="section-title">Unblock the next move</h2>
            </div>
            <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
              {blocked.length} open
            </Badge>
          </div>
          {attention.length === 0 ? (
            <div className="flex flex-col items-center gap-2 border border-dashed border-border py-14 text-center text-sm text-muted-foreground">
              <Check className="size-6 text-success" />
              Nothing is blocked right now -- every in-flight program has cleared its current
              checklist.
            </div>
          ) : (
            <div className="space-y-2">
              {attention.map((item, index) => {
                const program = scopedPrograms.find((p) => p.ticket_id === item.ticket_id);
                if (!program) return null;
                return (
                  <Link
                    key={item.ticket_id}
                    to="/programs/$ticketId"
                    params={{ ticketId: item.ticket_id }}
                    className="attention-row group grid gap-4 border border-border bg-card/70 p-4 hover:border-primary/50 hover:bg-card sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.9fr)_auto] sm:items-center"
                    style={{ animationDelay: `${index * 60}ms` }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="size-2 shrink-0 rounded-full bg-warning" />
                        <h3 className="truncate font-semibold">{item.subject}</h3>
                      </div>
                      <p className="mt-1 truncate pl-4 text-xs text-muted-foreground">
                        {orUnassigned(program.account_manager_name)} · CSM{" "}
                        {orUnassigned(program.csm_name)}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
                        Waiting on
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {item.pending_items.slice(0, 2).map((pending) => (
                          <span
                            key={pending}
                            className="rounded-sm bg-warning/10 px-2 py-1 text-xs font-medium text-warning"
                          >
                            {pending}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-4 sm:justify-end">
                      <span
                        className={cn(
                          "rounded-sm px-2 py-1 text-[10px] font-semibold",
                          stageStyles[item.stage],
                        )}
                      >
                        {item.stage}
                      </span>
                      <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <aside className="workspace-panel p-5">
          <div className="mb-5">
            <p className="section-kicker">Campaign mix</p>
            <h2 className="font-display text-xl font-semibold">Portfolio shape</h2>
          </div>
          {scopedCampaignTypes.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No campaign types recorded yet.
            </p>
          ) : (
            <div className="relative h-48">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={scopedCampaignTypes}
                    dataKey="count"
                    nameKey="campaign_type"
                    innerRadius={55}
                    outerRadius={78}
                    paddingAngle={4}
                    stroke="none"
                    animationDuration={900}
                  >
                    {scopedCampaignTypes.map((item, index) => (
                      <Cell
                        key={item.campaign_type}
                        fill={chartColors[index % chartColors.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-display text-3xl font-semibold">{scopedPrograms.length}</span>
                <span className="text-[10px] uppercase text-muted-foreground">Programs</span>
              </div>
            </div>
          )}
          <div className="space-y-2">
            {scopedCampaignTypes.map((item, index) => (
              <div key={item.campaign_type} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span
                    className="size-2 rounded-full"
                    style={{ background: chartColors[index % chartColors.length] }}
                  />
                  {item.campaign_type}
                </span>
                <strong>{item.count}</strong>
              </div>
            ))}
          </div>
          <div className="my-5 h-px bg-border" />
          <p className="mb-3 text-xs font-semibold uppercase text-muted-foreground">Named events</p>
          {scopedEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No named events yet.</p>
          ) : (
            <div className="space-y-2.5">
              {scopedEvents.slice(0, 5).map((event, index) => (
                <div
                  key={`${event.event_name}-${index}`}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="truncate text-sm">{event.event_name}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded-sm px-2 py-0.5 text-[10px] font-semibold",
                      stageStyles[event.stage],
                    )}
                  >
                    {event.stage}
                  </span>
                </div>
              ))}
            </div>
          )}
        </aside>
      </section>

      <section>
        <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <p className="section-kicker">Operating rollup</p>
            <h2 className="section-title">Accounts, owners & value</h2>
          </div>
          <div className="flex items-center gap-3">
            {activeFilterCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {filtered.length} of {visible.length} match your filters
              </span>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="relative">
                  <Filter /> Filters
                  {activeFilterCount > 0 && (
                    <Badge className="ml-1 h-5 min-w-5 justify-center rounded-full px-1 text-[10px]">
                      {activeFilterCount}
                    </Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80 max-h-[75vh] overflow-y-auto" align="end">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-sm font-semibold">Filters</p>
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setFilters(emptyFilters())}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" /> Clear all
                    </button>
                  )}
                </div>

                <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={filters.blockedOnly}
                    onCheckedChange={(checked) =>
                      setFilters((f) => ({ ...f, blockedOnly: checked === true }))
                    }
                  />
                  Blocked / stalled only
                </label>

                <FilterGroup
                  label="Campaign type"
                  options={distinctCampaignTypes}
                  selected={filters.campaignTypes}
                  onToggle={(value) =>
                    setFilters((f) => ({
                      ...f,
                      campaignTypes: toggleSetValue(f.campaignTypes, value),
                    }))
                  }
                />
                <FilterGroup
                  label="Account manager"
                  options={distinctAccountManagers}
                  selected={filters.accountManagers}
                  onToggle={(value) =>
                    setFilters((f) => ({
                      ...f,
                      accountManagers: toggleSetValue(f.accountManagers, value),
                    }))
                  }
                />
                <FilterGroup
                  label="CSM"
                  options={distinctCsms}
                  selected={filters.csms}
                  onToggle={(value) =>
                    setFilters((f) => ({ ...f, csms: toggleSetValue(f.csms, value) }))
                  }
                />
                <FilterGroup
                  label="Owner"
                  options={distinctOwners}
                  selected={filters.owners}
                  onToggle={(value) =>
                    setFilters((f) => ({ ...f, owners: toggleSetValue(f.owners, value) }))
                  }
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <div className="overflow-hidden border border-border bg-card/40">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Program</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Account manager / CSM</TableHead>
                <TableHead>Last activity</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rollups.map((program) => (
                <TableRow key={program.ticket_id} className="group">
                  <TableCell>
                    <Link
                      to="/programs/$ticketId"
                      params={{ ticketId: program.ticket_id }}
                      className="block min-w-48"
                    >
                      <span className="font-medium group-hover:text-primary">
                        {program.subject}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {program.ticket_id} · {program.campaign_type ?? "Uncategorized"}
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "rounded-sm px-2 py-1 text-[10px] font-semibold",
                        stageStyles[program.stage],
                      )}
                    >
                      {program.stage}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="block text-sm">
                      {orUnassigned(program.account_manager_name)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      CSM · {orUnassigned(program.csm_name)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(program.last_modified_at)}
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold">
                    {formatMoney(program.expected_deal_size)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {rollups.length === 0 && (
            <div className="flex flex-col items-center py-16 text-center">
              <Layers3 className="mb-3 size-8 text-muted-foreground" />
              <h3 className="font-semibold">
                {activeFilterCount > 0
                  ? "No programs match your filters"
                  : "No programs in this stage"}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeFilterCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setFilters(emptyFilters())}
                    className="underline hover:text-foreground"
                  >
                    Clear filters
                  </button>
                ) : (
                  "Choose another pipeline stage to continue."
                )}
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  note,
  warning = false,
}: {
  icon: typeof BriefcaseBusiness;
  label: string;
  value: React.ReactNode;
  note: string;
  warning?: boolean;
}) {
  return (
    <div className="kpi-card group relative overflow-hidden border border-border bg-card/65 p-5 transition hover:-translate-y-0.5 hover:border-primary/40">
      <div className="flex items-start justify-between">
        <span
          className={cn(
            "flex size-9 items-center justify-center rounded-md",
            warning ? "bg-warning/10 text-warning" : "bg-primary/10 text-primary",
          )}
        >
          <Icon className="size-4" />
        </span>
        {warning && <Clock3 className="size-4 text-warning" />}
      </div>
      <div className="mt-6 font-display text-4xl font-semibold tracking-normal">{value}</div>
      <p className="mt-1 text-sm font-medium">{label}</p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
      <span
        className={cn(
          "absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 transition-transform duration-500 group-hover:scale-x-100",
          warning ? "bg-warning" : "bg-primary",
        )}
      />
    </div>
  );
}

function toggleSetValue(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function FilterGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="mb-4">
      <p className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">{label}</p>
      <div className="space-y-1.5">
        {options.map((option) => (
          <label key={option} className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={selected.has(option)} onCheckedChange={() => onToggle(option)} />
            <span className="truncate">{option}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
