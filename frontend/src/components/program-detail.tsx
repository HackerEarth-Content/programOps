import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Avatar,
  Chip,
  EmptyState,
  HealthPill,
  Skeleton,
  StageBar,
  TabBar,
  type TabItem,
  type Tone,
} from "@/components/kit";
import { ProgramOverview } from "@/components/program-overview";
import { ProgramDocuments } from "@/components/program-documents";
import { ProgramMarketing } from "@/components/program-marketing";
import { ProgramActivityLog, ProgramRequests, ProgramRounds } from "@/components/program-ops";
import { ProgramRegistrationsTab } from "@/components/program-registrations";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  apiFetch,
  checklistStatusQueryOptions,
  HIRING_CAMPAIGN_TYPE,
  peopleByName,
  programQueryOptions,
  STAGES,
  useCan,
  type Program,
} from "@/lib/api";
import { formatDay, known } from "@/lib/format";
import { activitySummaryQuery, HEALTH_REASONS, reportQuery, type Health } from "@/lib/ops-api";
import { programDocumentsQueryOptions } from "@/lib/program-documents";
import { parseTab, PROGRAM_TABS, type ProgramTab } from "@/lib/program-tabs";

const healthQuery = (ticketId: string) => ({
  queryKey: ["programs", ticketId, "health"],
  queryFn: () => apiFetch<{ health: Health; reasons: string[] }>(`/programs/${ticketId}/health`),
});

export function ProgramDetail({ ticketId, tab }: { ticketId: string; tab: ProgramTab }) {
  const programQuery = useQuery(programQueryOptions(ticketId));

  if (programQuery.isLoading) return <ChromeSkeleton />;

  if (programQuery.error instanceof ApiError && programQuery.error.status === 404) {
    return (
      <EmptyState
        title="This program doesn't exist or was removed."
        action={
          <Link to="/" className="t-data-sm text-primary hover:underline">
            Back to Programs Directory
          </Link>
        }
      />
    );
  }

  if (programQuery.isError || !programQuery.data) {
    return (
      <EmptyState
        title="Couldn't load this program."
        action={
          <Button variant="outline" onClick={() => programQuery.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  const program = programQuery.data;
  return (
    <div className="space-y-5">
      <Header program={program} />
      <ProgramTabs ticketId={ticketId} tab={tab} />
      <div key={tab} className="page-in">
        {tab === "overview" && <ProgramOverview ticketId={ticketId} program={program} />}
        {tab === "marketing" && <ProgramMarketing ticketId={ticketId} />}
        {tab === "registrations" && (
          <ProgramRegistrationsTab
            ticketId={ticketId}
            isHiring={program.campaign_type === HIRING_CAMPAIGN_TYPE}
            redashEnabled={!program.platform_details?.includes("Non-HE Platform")}
          />
        )}
        {tab === "rounds" && <ProgramRounds ticketId={ticketId} />}
        {tab === "requests" && <ProgramRequests ticketId={ticketId} />}
        {tab === "documents" && (
          <ProgramDocuments
            ticketId={ticketId}
            isHiring={program.campaign_type === HIRING_CAMPAIGN_TYPE}
          />
        )}
        {tab === "activity" && <ProgramActivityLog ticketId={ticketId} />}
      </div>
    </div>
  );
}

function ChromeSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <Skeleton className="h-4 w-72" />
      <Skeleton className="h-8 w-96 max-w-full" />
      <Skeleton className="h-16" />
      <Skeleton className="h-10" />
      <Skeleton className="h-64" />
    </div>
  );
}

function stageIndex(stage: Program["stage"]) {
  return STAGES.indexOf(stage);
}

/** The label a person holds on a program (Owner, AM, CSM, Content, HubSpot) as a small team chip. */
const roleLabelTone = (label: string): Tone =>
  label === "CSM" ? "csm" : label === "Content" ? "marketing" : label === "AM" ? "am" : "neutral";

/** One header for every tab: breadcrumb, title + health, one meta line, the people, the stage ladder. */
function Header({ program }: { program: Program }) {
  const ticketId = program.ticket_id;
  const { data: health } = useQuery(healthQuery(ticketId));
  const sow = useQuery(programDocumentsQueryOptions(ticketId)).data?.sow?.details;
  const stages = useQuery(checklistStatusQueryOptions).data?.find(
    (c) => c.ticket_id === ticketId,
  )?.stages;
  const canPost = useCan("update.post");
  const title = program.display_name;
  const linkedClient = program.company_name ?? program.blackops_account_name;
  const sowClient = known(sow?.customer);
  const client =
    linkedClient ?? (sowClient ? `${sowClient} (from SOW, not linked)` : "No client linked");
  const pill = health ? (
    <HealthPill
      health={health.health}
      title={health.reasons.map((r) => HEALTH_REASONS[r] ?? r).join("\n") || undefined}
    />
  ) : null;
  const people = peopleByName(program);
  return (
    <header className="space-y-3">
      <nav aria-label="Breadcrumb" className="text-[13px] text-ink-2">
        <Link to="/" className="hover:text-foreground">
          Programs
        </Link>{" "}
        <span aria-hidden>/</span> {title}
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="t-headline-lg flex flex-wrap items-center gap-2.5">
            {title}
            {pill}
          </h1>
          <p className="mt-1 text-[14px] text-ink-2">
            {[program.campaign_type, client].filter(Boolean).join(" · ")} ·{" "}
            {program.origin === "internal" ? (
              <span className="text-[12px] font-medium">Internal</span>
            ) : (
              <span className="font-mono text-[12px]">HS-{ticketId}</span>
            )}{" "}
            · Updated {formatDay(program.last_modified_at)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {people.map((p) => (
            <span key={p.name} className="flex items-center gap-2 text-[13px] text-ink-2">
              <Avatar name={p.name} className="size-6 text-[11px]" />
              {p.name}
              {p.roles.map((r) => (
                <Chip key={r} tone={roleLabelTone(r)}>
                  {r}
                </Chip>
              ))}
            </span>
          ))}
          {canPost && (
            <Button asChild variant="outline">
              <Link to="/programs/$ticketId" params={{ ticketId }} search={{ tab: "requests" }}>
                Post update
              </Link>
            </Button>
          )}
        </div>
      </div>
      <StageBar
        current={stageIndex(program.stage)}
        progress={stages}
        from={program.origin === "internal" ? 2 : 0}
      />
    </header>
  );
}

function ProgramTabs({ ticketId, tab }: { ticketId: string; tab: ProgramTab }) {
  const report = useQuery(reportQuery(ticketId)).data;
  const summary = useQuery(activitySummaryQuery(ticketId)).data;
  // Badges only where the person has something to do: approvals waiting, requests due.
  const badges: Partial<Record<ProgramTab, number>> = {
    marketing: summary?.awaiting_approval ?? 0,
    requests: report?.operations.open_requests ?? 0,
  };
  const items: TabItem[] = PROGRAM_TABS.map((t) => ({
    id: t.id,
    label: t.label,
    badge: badges[t.id] || undefined,
  }));
  return (
    <TabBar
      label="Program sections"
      items={items}
      active={tab}
      renderLink={(item, props) => (
        <Link
          to="/programs/$ticketId"
          params={{ ticketId }}
          search={{ tab: parseTab(item.id) }}
          {...props}
        />
      )}
    />
  );
}
