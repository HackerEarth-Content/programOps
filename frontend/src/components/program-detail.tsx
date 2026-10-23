import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import {
  Chip,
  EmptyState,
  HealthPill,
  Skeleton,
  StageBar,
  TabBar,
  type TabItem,
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
import {
  activitySummaryQuery,
  HEALTH_REASONS,
  needsQuery,
  reportQuery,
  type Health,
} from "@/lib/ops-api";
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
      <Header program={program} full={tab === "overview"} />
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

function Header({ program, full }: { program: Program; full: boolean }) {
  const router = useRouter();
  const ticketId = program.ticket_id;
  const { data: health } = useQuery(healthQuery(ticketId));
  const needs = useQuery(needsQuery(ticketId)).data;
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

  if (!full) {
    return (
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="text-[13px] text-ink-2 hover:text-foreground">
          Programs /
        </Link>
        <h1 className="t-headline-md">{title}</h1>
        {pill}
        <Chip>
          {program.stage} · stage {stageIndex(program.stage) + 1} of {STAGES.length}
        </Chip>
      </header>
    );
  }

  const top = needs?.[0];
  const people = peopleByName(program);
  return (
    <header className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          // Back to wherever the user came from (a queue, the directory); the directory if the tab was opened directly.
          onClick={() =>
            window.history.length > 1 ? router.history.back() : void router.navigate({ to: "/" })
          }
        >
          <ArrowLeft /> Back
        </Button>
        <nav aria-label="Breadcrumb" className="text-[13px] text-ink-3">
          <Link to="/" className="text-ink-2 hover:text-foreground">
            Programs
          </Link>{" "}
          <span aria-hidden>/</span> {title}
        </nav>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="t-headline-lg">{title}</h1>
            {pill}
          </div>
          <p className="text-[14px] text-ink-2">
            {[program.campaign_type, client].filter(Boolean).join(" · ")} ·{" "}
            {program.origin === "internal" ? (
              <span className="text-[12px] font-medium">Internal</span>
            ) : (
              <span className="font-mono text-[12px]">HS-{ticketId}</span>
            )}{" "}
            · Updated {formatDay(program.last_modified_at)}
          </p>
          <p className="text-[14px]">
            {top ? `${top.title}.` : needs ? "Nothing needs you today." : "\u00a0"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {people.map((p) => (
            <span key={p.name} className="flex items-center gap-2 text-[13px] text-ink-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-accent-bg text-[11px] font-semibold text-primary">
                {p.name
                  .split(/\s+/)
                  .map((w) => w[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase()}
              </span>
              {p.name} · {p.roles.join(", ")}
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
