import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  ActionItem,
  Chip,
  HealthPill,
  KpiCell,
  KpiStrip,
  OkRow,
  Skeleton,
  SlotRow,
  type Tone,
} from "@/components/kit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  apiFetch,
  checklistStatusQueryOptions,
  historyQueryOptions,
  peopleByName,
  registrationsQueryOptions,
  sendJson,
  STAGES,
  useCan,
  type Program,
} from "@/lib/api";
import {
  formatDate,
  formatDay,
  formatPct,
  formatRange,
  formatWhen,
  known,
  orUnassigned,
} from "@/lib/format";
import { describeHistory } from "@/lib/history";
import { linkHubspotClient } from "@/lib/system-api";
import { assignmentsQuery, type Assignment } from "@/lib/marketing-api";
import { needsQuery, reportQuery, roundsQuery, updatesQuery, type Round } from "@/lib/ops-api";
import { programDocumentsQueryOptions } from "@/lib/program-documents";
import { parseTab } from "@/lib/program-tabs";
import {
  moveHubspotStage,
  setHubspotChecklistItem,
  stageKey,
  systemStatusQuery,
} from "@/lib/system-api";
import { cn } from "@/lib/utils";

const nf = (n: number) => n.toLocaleString("en-US");
const Dash = () => <span className="text-ink-3">–</span>;

export function ProgramOverview({ ticketId, program }: { ticketId: string; program: Program }) {
  // The "link the client" dialog is opened from both Program setup and Program brief.
  const [linking, setLinking] = useState(false);
  const canLink = useCan("hubspot.write");
  const docs = useQuery(programDocumentsQueryOptions(ticketId)).data;
  const sowClient = known(docs?.sow?.details?.customer);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <NeedsToday ticketId={ticketId} />
        <Kpis ticketId={ticketId} />
        <RoundPlan ticketId={ticketId} />
        <StageChecklist ticketId={ticketId} program={program} />
      </div>
      <aside className="flex min-w-0 flex-col gap-4">
        <LatestUpdate ticketId={ticketId} />
        <ProgramSetup
          ticketId={ticketId}
          program={program}
          sowClient={sowClient}
          canLink={canLink}
          onLink={() => setLinking(true)}
        />
        <Brief
          ticketId={ticketId}
          program={program}
          sowClient={sowClient}
          canLink={canLink}
          onLink={() => setLinking(true)}
        />
      </aside>
      <LinkClientDialog
        open={linking}
        onOpenChange={setLinking}
        sowClient={sowClient}
        current={program.company_name ?? program.blackops_account_name}
        ticketId={program.ticket_id}
      />
    </div>
  );
}

function Section({
  title,
  meta,
  children,
  className,
  flush,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Rows run edge to edge under a divided header (lists, tables). */
  flush?: boolean;
}) {
  return (
    <section className={cn("surface", className)}>
      <div
        className={cn(
          "flex items-center justify-between gap-3 px-4 pt-3.5 pb-3",
          flush && "border-b border-border",
        )}
      >
        <h2 className="min-w-0 text-[14px] font-semibold leading-5">{title}</h2>
        {meta && <span className="shrink-0 text-right text-[13px] text-ink-2">{meta}</span>}
      </div>
      <div className={flush ? undefined : "px-4 pb-4"}>{children}</div>
    </section>
  );
}

/** A text link styled as a quiet accent action (e.g. "All 10"). */
function MoreButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-[13px] text-primary hover:underline">
      {children}
    </button>
  );
}

// ---- Needs you today ---------------------------------------------------------------------------

function NeedsToday({ ticketId }: { ticketId: string }) {
  const { data, isLoading, isError, refetch } = useQuery(needsQuery(ticketId));
  const all = data ?? [];
  const items = all.filter((i) => i.group !== "check");
  const checks = all.filter((i) => i.group === "check");
  const row = (i: (typeof all)[number]) => (
    <ActionItem
      key={i.id}
      tone={i.severity}
      title={i.title}
      detail={i.detail}
      action={
        i.action ? (
          <Button asChild size="sm" variant="outline" className="shrink-0">
            <Link to="/programs/$ticketId" params={{ ticketId }} search={{ tab: parseTab(i.tab) }}>
              {i.action}
            </Link>
          </Button>
        ) : undefined
      }
    />
  );
  return (
    <Section
      flush
      title="Needs you today"
      meta={items.length > 0 ? `${items.length} items · most urgent first` : undefined}
    >
      {isLoading ? (
        <Skeleton className="m-4 h-20" />
      ) : isError ? (
        <div className="p-4">
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Couldn't load this list. Retry
          </Button>
        </div>
      ) : (
        <>
          {items.length === 0 ? (
            <p className="px-4 py-3 text-[14px] text-ink-2">Nothing needs you today. All clear.</p>
          ) : (
            items.map(row)
          )}
          {checks.length > 0 && (
            <>
              <p className="border-b border-border px-4 pt-3 pb-2 text-[13px] text-ink-2">
                Data checks · the numbers disagree, nobody is waiting on these
              </p>
              {checks.map(row)}
            </>
          )}
        </>
      )}
    </Section>
  );
}

// ---- Key numbers -------------------------------------------------------------------------------

function Kpis({ ticketId }: { ticketId: string }) {
  const { data: r, isError, refetch } = useQuery(reportQuery(ticketId));
  if (isError) {
    return (
      <div className="surface flex items-center justify-between px-4 py-3">
        <span className="text-[14px] text-ink-2">Couldn't load the program report.</span>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!r) return <Skeleton className="h-[112px]" />;
  const { registrations: reg, marketing: m } = r;
  const screening = r.funnel.find((s) => s.as_of !== null);
  const attempted = screening?.attempted ?? null;
  const invited = screening?.invited ?? null;
  const screeningPct = attempted != null && invited ? (100 * attempted) / invited : null;
  const target = reg.target;
  const noneApproved = m.total > 0 && m.approved === 0;
  const met = reg.pct_of_target != null && reg.pct_of_target >= 100;
  return (
    <KpiStrip label="Program numbers">
      <KpiCell
        label="Registrations"
        value={nf(reg.raw_total)}
        pct={reg.pct_of_target}
        bar={met ? "ok" : "accent"}
        sub={target ? `${formatPct(reg.pct_of_target)} of ${nf(target)} target` : "No target set"}
      />
      <KpiCell
        label="Meets requirement"
        value={reg.relevant_total == null ? <Dash /> : nf(reg.relevant_total)}
        pct={reg.relevant_total == null ? undefined : reg.relevant_pct}
        sub={
          reg.relevant_total == null
            ? "Set who counts as relevant in Registrations"
            : `${formatPct(reg.relevant_pct)} of registrations${
                reg.relevant_possibly ? ` · +${nf(reg.relevant_possibly)} possibly` : ""
              }`
        }
      />
      <KpiCell
        label="Screening"
        value={screening ? attempted != null ? nf(attempted) : <Dash /> : <Dash />}
        unit={screening && attempted != null && invited != null ? `/ ${nf(invited)}` : undefined}
        pct={screeningPct}
        sub={
          screening
            ? `${nf(screening.cleared ?? 0)} cleared · ${nf(screening.shortlisted ?? 0)} shortlisted`
            : "No counts entered yet"
        }
      />
      <KpiCell
        label="Marketing live"
        value={nf(m.live)}
        unit={`/ ${nf(m.total)}`}
        pct={m.total ? (100 * m.live) / m.total : 0}
        bar={noneApproved ? "warn" : "accent"}
        sub={
          noneApproved ? (
            <span className="text-warn">None approved yet</span>
          ) : (
            `${nf(m.approved)} approved`
          )
        }
      />
    </KpiStrip>
  );
}

// ---- Round plan --------------------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

const ROUND_CHIP: Record<Round["status"], { label: string; tone: Tone }> = {
  planned: { label: "Planned", tone: "neutral" },
  live: { label: "Live", tone: "info" },
  evaluating: { label: "Evaluating", tone: "neutral" },
  done: { label: "Done", tone: "good" },
};

type RoundRow = { key: string; name: string; round?: Round };

const COUNT_COLS = [
  ["invited", "Invited"],
  ["attempted", "Attempted"],
  ["cleared", "Cleared"],
  ["shortlisted", "Shortlisted"],
] as const;

function RoundPlan({ ticketId }: { ticketId: string }) {
  const rounds = useQuery(roundsQuery(ticketId));
  const docs = useQuery(programDocumentsQueryOptions(ticketId));
  const report = useQuery(reportQuery(ticketId)).data;
  const sow = docs.data?.sow?.details ?? null;
  const planned = rounds.data ?? [];
  const rows: RoundRow[] =
    planned.length > 0
      ? planned.map((r) => ({ key: `round-${r.id}`, name: r.name, round: r }))
      : (sow?.rounds ?? []).map((r, i) => ({ key: `sow-${i}`, name: r.name }));
  const meta = [
    sow ? "From SOW" : null,
    report?.registrations.target ? `target ${nf(report.registrations.target)} registrations` : null,
    sow?.registration_window_weeks_min && sow.registration_window_weeks_max
      ? sow.registration_window_weeks_min === sow.registration_window_weeks_max
        ? `${sow.registration_window_weeks_min} week window`
        : `${sow.registration_window_weeks_min}–${sow.registration_window_weeks_max} week window`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Section
      flush
      title="Rounds"
      meta={
        <span className="flex items-center gap-3">
          {meta && <span className="hidden sm:inline">{meta}</span>}
          <Button asChild size="sm" variant="ghost">
            <Link to="/programs/$ticketId" params={{ ticketId }} search={{ tab: "rounds" }}>
              Open rounds
            </Link>
          </Button>
        </span>
      }
    >
      {rounds.isLoading ? (
        <Skeleton className="m-4 h-20" />
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-[14px] text-ink-2">
          No rounds yet. Add them in the Rounds tab, or upload the SOW in Documents.
        </p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-border text-left t-th">
                <th className="px-4 py-2 font-medium">Round</th>
                <th className="px-2 py-2 font-medium">Status</th>
                {COUNT_COLS.map(([k, label]) => (
                  <th key={k} className="px-2 py-2 text-right font-medium last:pr-4">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const r = t.round;
                const c = r?.latest_counts ?? null;
                const ended =
                  !!r &&
                  (r.status === "evaluating" ||
                    r.status === "done" ||
                    (!!r.ends_on && r.ends_on < today()));
                const dates =
                  r && (r.starts_on || r.ends_on) ? formatRange(r.starts_on, r.ends_on) : null;
                const chip = r ? ROUND_CHIP[r.status] : ROUND_CHIP.planned;
                return (
                  <tr key={t.key} className="border-b border-border last:border-b-0">
                    <td className="min-w-0 px-4 py-2.5">
                      <p className="font-medium">{t.name}</p>
                      <p
                        className={cn("text-[13px]", r && !c && ended ? "text-warn" : "text-ink-2")}
                      >
                        {r && !c && ended
                          ? "Counts missing: this round has ended"
                          : (dates ?? "Not scheduled")}
                      </p>
                    </td>
                    <td className="px-2 py-2.5">
                      <Chip tone={chip.tone}>{chip.label}</Chip>
                    </td>
                    {COUNT_COLS.map(([k]) => (
                      <td key={k} className="px-2 py-2.5 text-right tabular-nums last:pr-4">
                        {c && c[k] != null ? nf(c[k]) : <Dash />}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ---- Stage checklist (and the confirmed HubSpot writes) ------------------------------------------------

type PendingWrite = { change: string; run: () => Promise<unknown> };

/** Every change to the live HubSpot ticket goes through this: say what will change, ask, then run it. */
function HubspotConfirm({
  pending,
  internal,
  onClose,
  onDone,
}: {
  pending: PendingWrite | null;
  internal: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };
  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {internal ? "Change this program?" : "Change the HubSpot ticket?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {internal
              ? "This will change the program in ProgramOps"
              : "This will change the live ticket in HubSpot"}
            : <strong>{pending?.change}</strong>. It is recorded in the audit log under your name.
            Are you sure you want to make this move?
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-[13px] text-danger">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault(); // stay open until it finishes, so a refusal can be shown here
              setBusy(true);
              setError(null);
              try {
                await pending?.run();
                onDone();
              } catch (err) {
                setError(err instanceof Error ? err.message : "The change failed.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {internal ? "Yes, change it" : "Yes, change HubSpot"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const SHOWN_ITEMS = 4;

function StageChecklist({ ticketId, program }: { ticketId: string; program: Program }) {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery(checklistStatusQueryOptions);
  const status = useQuery(systemStatusQuery);
  const internal = program.origin === "internal";
  // An internal hackathon has no ticket: its changes are saved in ProgramOps, so the HubSpot switch doesn't apply.
  const canWrite =
    useCan("hubspot.write") && (internal || status.data?.hubspot_writeback_enabled === true);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [target, setTarget] = useState("");
  const [showAll, setShowAll] = useState(false);
  const c = data?.find((i) => i.ticket_id === ticketId);
  const current = stageKey(program.stage);
  // What HubSpot itself has ticked: the ticket's properties are the only source.
  const ticked = c ? c.completed_items : [];
  const rows = c
    ? [
        ...c.completed_items.map((label) => ({ label, done: true })),
        ...c.pending_items.map((label) => ({ label, done: false })),
      ]
    : [];
  const visible = showAll ? rows : rows.slice(0, SHOWN_ITEMS);
  const toggle = (item: string, done: boolean) =>
    setPending({
      change: `${done ? "tick" : "untick"} "${item}" on the ${program.stage} checklist`,
      run: () =>
        setHubspotChecklistItem(ticketId, { stage_key: current, item, done, expected: ticked }),
    });
  const refresh = () => {
    setPending(null);
    setTarget("");
    void qc.invalidateQueries({ queryKey: ["programs"] });
  };
  return (
    <Section
      flush
      title={`${program.stage} stage checklist`}
      meta={
        c && rows.length > 0
          ? `${c.completed_items.length} of ${rows.length} done · ${Math.round((100 * c.completed_items.length) / rows.length)}%`
          : undefined
      }
    >
      {isLoading ? (
        <Skeleton className="m-4 h-28" />
      ) : isError ? (
        <div className="p-4">
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Couldn't load the checklist. Retry
          </Button>
        </div>
      ) : !c || rows.length === 0 ? (
        <p className="px-4 py-3 text-[14px] text-ink-2">This stage has no checklist.</p>
      ) : (
        <ul className="px-4">
          {visible.map((row) => (
            <li key={row.label} className="border-b border-border last:border-b-0">
              <label
                className={cn(
                  "flex items-center gap-3 py-2.5",
                  canWrite ? "cursor-pointer" : "cursor-default",
                  row.done && "text-ink-3",
                )}
              >
                <input
                  type="checkbox"
                  checked={row.done}
                  disabled={!canWrite}
                  onChange={() => toggle(row.label, !row.done)}
                  className="size-4 accent-[var(--accent-fill)]"
                />
                <span className="min-w-0 flex-1">{row.label}</span>
                {!row.done && row.label === c.pending_items[0] && <Chip tone="info">Next</Chip>}
              </label>
            </li>
          ))}
        </ul>
      )}
      {(rows.length > SHOWN_ITEMS || canWrite) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5 text-[13px] text-ink-2">
          {rows.length > SHOWN_ITEMS && (
            <MoreButton onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show ${rows.length - SHOWN_ITEMS} more`}
            </MoreButton>
          )}
          <div className="grow" />
          {canWrite && (
            <>
              <span>Move stage</span>
              <select
                aria-label="Move the HubSpot ticket to stage"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="h-8 rounded-[6px] border border-border bg-surface px-2 text-[13px] text-foreground"
              >
                <option value="">Choose a stage…</option>
                {STAGES.filter(
                  (s) => s !== program.stage && !(internal && (s === "New" || s === "Pre Sales")),
                ).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={!target}
                onClick={() =>
                  setPending({
                    change: `move the ticket from ${program.stage} to ${target}`,
                    run: () =>
                      moveHubspotStage(ticketId, {
                        stage_key: stageKey(target),
                        expected_stage_key: current,
                      }),
                  })
                }
              >
                Move
              </Button>
            </>
          )}
        </div>
      )}
      <HubspotConfirm
        pending={pending}
        internal={internal}
        onClose={() => setPending(null)}
        onDone={refresh}
      />
    </Section>
  );
}

// ---- Aside -------------------------------------------------------------------------------------

function LatestUpdate({ ticketId }: { ticketId: string }) {
  const { data, isLoading } = useQuery(updatesQuery(ticketId));
  const updates = (data?.items ?? [])
    .filter((n) => n.kind === "update")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = updates[0];
  return (
    <Section
      title="Latest update"
      meta={latest?.health ? <HealthPill health={latest.health} /> : undefined}
    >
      {isLoading ? (
        <Skeleton className="h-24" />
      ) : !latest ? (
        <p className="text-[13px] text-ink-2">
          No update posted yet. Use Post update at the top of the page.
        </p>
      ) : (
        <>
          <p className="whitespace-pre-wrap">{latest.body}</p>
          {latest.blockers && (
            <p className="mt-2 text-[13px] text-danger">Blocked: {latest.blockers}</p>
          )}
          <p className="mt-2.5 text-[13px] text-ink-2">
            {orUnassigned(latest.author_name)} · {formatWhen(latest.created_at)}
            {updates.length > 1 && (
              <>
                {" · "}
                <Link
                  to="/programs/$ticketId"
                  params={{ ticketId }}
                  search={{ tab: "requests" }}
                  className="text-primary hover:underline"
                >
                  {updates.length - 1} earlier {updates.length === 2 ? "update" : "updates"}
                </Link>
              </>
            )}
          </p>
        </>
      )}
    </Section>
  );
}

function Brief({
  ticketId,
  program,
  sowClient,
  canLink,
  onLink,
}: {
  ticketId: string;
  program: Program;
  sowClient: string | null;
  canLink: boolean;
  onLink: () => void;
}) {
  const docs = useQuery(programDocumentsQueryOptions(ticketId)).data;
  const regs = useQuery(registrationsQueryOptions(ticketId)).data;
  const sow = docs?.sow?.details ?? null;
  const linked = program.company_name ?? program.blackops_account_name;
  const est = regs?.estimate;
  const people = peopleByName(program);
  const [assigning, setAssigning] = useState(false);
  const canAssign = useCan("users.manage");
  const assigned = useQuery(assignmentsQuery(ticketId)).data ?? [];
  const rows: { k: string; v: ReactNode }[] = [
    {
      k: "Client",
      v: linked ? (
        linked
      ) : canLink ? (
        <span className="text-ink-2">
          Not linked ·{" "}
          <button type="button" onClick={onLink} className="text-primary hover:underline">
            {sowClient ? `Link ${sowClient}` : "Link client"}
          </button>
        </span>
      ) : (
        "Not linked"
      ),
    },
    {
      k: "Campaign",
      v: [program.campaign_type, program.platform_details].filter(Boolean).join(" · ") || "—",
    },
    ...(known(sow?.order_date)
      ? [{ k: "SOW ordered", v: formatDate(sow?.order_date ?? null) }]
      : []),
    ...(est?.start
      ? [
          {
            k: "Registration window",
            v: `${formatDay(est.start)}${est.end ? ` – ${formatDay(est.end)}` : ""}`,
          },
        ]
      : []),
    {
      k: "People",
      v: (
        <>
          {people.length === 0 && assigned.length === 0 && "Unassigned"}
          {people.map((p) => (
            <span key={p.name} className="block">
              {p.name} <span className="text-ink-3">· {p.roles.join(", ")} · HubSpot</span>
            </span>
          ))}
          {assigned.map((a) => (
            <span key={`${a.user_id}-${a.role}`} className="block">
              {a.name}{" "}
              <span className="text-ink-3">· {ROLE_NAME[a.role] ?? a.role} · assigned</span>
            </span>
          ))}
          {canAssign && (
            <button
              type="button"
              onClick={() => setAssigning(true)}
              className="mt-1 text-primary hover:underline"
            >
              Assign people
            </button>
          )}
        </>
      ),
    },
    { k: "Created", v: formatDate(program.created_at) },
  ];
  return (
    <Section title="Program brief">
      <dl>
        {rows.map((r) => (
          <div
            key={r.k}
            className="flex justify-between gap-4 border-t border-border py-2.5 text-[14px] first:border-t-0 first:pt-0"
          >
            <dt className="shrink-0 text-[13px] text-ink-2">{r.k}</dt>
            <dd className="min-w-0 text-right">{r.v}</dd>
          </div>
        ))}
      </dl>
      {assigning && (
        <AssignDialog ticketId={ticketId} current={assigned} onClose={() => setAssigning(false)} />
      )}
    </Section>
  );
}

function LinkClientDialog({
  open,
  onOpenChange,
  sowClient,
  current,
  ticketId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sowClient: string | null;
  /** The client shown now (null when none): HubSpot refuses the change if someone linked another meanwhile. */
  current: string | null;
  ticketId: string;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const link = useMutation({
    mutationFn: () => linkHubspotClient(ticketId, { name, expected: current }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["programs"] });
      onOpenChange(false);
    },
  });
  const { reset } = link;
  useEffect(() => {
    if (open) {
      setName(current ?? sowClient ?? "");
      reset();
    }
  }, [open, current, sowClient, reset]);
  const trimmed = name.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) link.mutate();
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{current ? "Change the client" : "Link the client"}</DialogTitle>
            <DialogDescription>
              Sets the Company Name on HubSpot ticket {ticketId}, so HubSpot and ProgramOps show the
              same client.{sowClient ? ` The SOW names ${sowClient}.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="link-client-name" className="text-[13px] font-medium">
              Client name
            </label>
            <Input
              id="link-client-name"
              value={name}
              maxLength={120}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
            <div className="flex items-center justify-between gap-2 text-[12px] text-ink-2">
              <span>This updates the live HubSpot ticket.</span>
              {sowClient && trimmed !== sowClient && (
                <button
                  type="button"
                  onClick={() => setName(sowClient)}
                  className="text-primary hover:underline"
                >
                  Use "{sowClient}" from the SOW
                </button>
              )}
            </div>
            {link.isError && (
              <p role="alert" className="text-[13px] text-danger">
                {link.error instanceof Error ? link.error.message : "Couldn't link the client."}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed || trimmed === current || link.isPending}>
              {link.isPending ? "Linking…" : current ? "Change client" : "Link client"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The nine things a program needs to run, worked out from data the overview already loads. */
function ProgramSetup({
  ticketId,
  program,
  sowClient,
  canLink,
  onLink,
}: {
  ticketId: string;
  program: Program;
  sowClient: string | null;
  canLink: boolean;
  onLink: () => void;
}) {
  const docsQ = useQuery(programDocumentsQueryOptions(ticketId));
  const regsQ = useQuery(registrationsQueryOptions(ticketId));
  const roundsQ = useQuery(roundsQuery(ticketId));
  const updatesQ = useQuery(updatesQuery(ticketId));
  const report = useQuery(reportQuery(ticketId)).data;
  const loading = docsQ.isLoading || regsQ.isLoading || roundsQ.isLoading || updatesQ.isLoading;
  const docs = docsQ.data;
  const est = regsQ.data?.estimate;
  const sow = docs?.sow?.details ?? null;
  const tab = (t: "registrations" | "rounds" | "requests") => (
    <Button asChild size="sm" variant="outline" className="shrink-0">
      <Link to="/programs/$ticketId" params={{ ticketId }} search={{ tab: t }}>
        {t === "registrations"
          ? "Connect Slack"
          : t === "rounds"
            ? "Set stage dates"
            : "Post update"}
      </Link>
    </Button>
  );
  const linked = program.company_name ?? program.blackops_account_name;
  const target = report?.registrations.target ?? est?.target ?? sow?.registration_target ?? null;
  const slack = regsQ.data?.slack;
  const datesSet =
    (roundsQ.data ?? []).some((r) => r.starts_on || r.ends_on) ||
    (sow?.timeline ?? []).some((m) => m.start || m.end);
  const hasUpdate = (updatesQ.data?.items ?? []).some((n) => n.kind === "update");
  const items: {
    key: string;
    done: boolean;
    ok: ReactNode;
    slot: ReactNode;
    hint?: ReactNode;
    action?: ReactNode;
  }[] = [
    {
      key: "sow",
      done: !!docs?.sow,
      ok: (
        <OkRow
          label="Statement of Work uploaded"
          value={docs?.sow?.file.uploaded_at ? formatDay(docs.sow.file.uploaded_at) : undefined}
        />
      ),
      slot: "Statement of Work",
      hint: "Not uploaded yet.",
      action: (
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link to="/programs/$ticketId" params={{ ticketId }} search={{ tab: "documents" }}>
            Upload
          </Link>
        </Button>
      ),
    },
    {
      key: "poa",
      done: !!docs?.poa,
      ok: (
        <OkRow
          label="Plan of action uploaded"
          value={docs?.poa?.file.uploaded_at ? formatDay(docs.poa.file.uploaded_at) : undefined}
        />
      ),
      slot: "Plan of action",
      hint: "Not uploaded yet.",
      action: (
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link to="/programs/$ticketId" params={{ ticketId }} search={{ tab: "documents" }}>
            Upload
          </Link>
        </Button>
      ),
    },
    {
      key: "target",
      done: target != null,
      ok: <OkRow label="Registration target" value={target != null ? nf(target) : undefined} />,
      slot: "Registration target",
      hint: "No target set on the SOW.",
    },
    {
      key: "window",
      done: !!est?.start,
      ok: (
        <OkRow
          label="Registration window"
          value={
            est?.start
              ? `${formatDay(est.start)}${est.end ? ` – ${formatDay(est.end)}` : ""}`
              : undefined
          }
        />
      ),
      slot: "Registration window",
      hint: "No start date yet.",
    },
    {
      key: "owner",
      done: !!program.owner_name,
      ok: <OkRow label="Owner assigned" value={program.owner_name ?? undefined} />,
      slot: "Owner",
      hint: "Nobody owns this program.",
    },
    {
      key: "client",
      done: !!linked,
      ok: <OkRow label="Client linked" value={linked ?? undefined} />,
      slot: "Client",
      hint: sowClient
        ? `${sowClient} is on the SOW but not linked in HubSpot.`
        : "No client is set on this ticket.",
      action: canLink ? (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onLink}>
          Link client
        </Button>
      ) : undefined,
    },
    {
      key: "slack",
      done: !!slack?.channel_id,
      ok: (
        <OkRow
          label="Slack channel connected"
          value={slack?.channel_name ? `#${slack.channel_name}` : undefined}
        />
      ),
      slot: "Slack channel",
      hint: "Updates and reminders stay in ProgramOps only.",
      action: tab("registrations"),
    },
    {
      key: "dates",
      done: datesSet,
      ok: <OkRow label="Stage dates set" />,
      slot: "Stage dates",
      hint: "No round or SOW stage has dates.",
      action: tab("rounds"),
    },
    {
      key: "update",
      done: hasUpdate,
      ok: <OkRow label="Daily update posted" />,
      slot: "First daily update",
      hint: "None posted yet.",
      action: tab("requests"),
    },
  ];
  const done = items.filter((i) => i.done);
  const missing = items.filter((i) => !i.done);
  return (
    <Section
      title="Program setup"
      meta={loading ? undefined : `${done.length} of ${items.length} complete`}
    >
      {loading ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div
            className="mb-2 h-1 overflow-hidden rounded-full bg-border"
            role="progressbar"
            aria-label="Program setup progress"
            aria-valuenow={Math.round((100 * done.length) / items.length)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-1 rounded-full bg-accent-fill"
              style={{ width: `${(100 * done.length) / items.length}%` }}
            />
          </div>
          {done.map((i) => (
            <div key={i.key}>{i.ok}</div>
          ))}
          {missing.length > 0 && (
            <div className={cn("flex flex-col gap-2", done.length > 0 && "mt-2")}>
              {missing.map((i) => (
                <SlotRow key={i.key} title={i.slot} hint={i.hint} action={i.action} />
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

const ROLE_NAME: Record<string, string> = {
  csm: "CSM",
  marketing: "Marketing",
  account_manager: "Account manager",
};

type PortalUser = { id: string; name: string | null; email: string; is_active: boolean };

/** Super admin: who works this program. The HubSpot CSM still matches on email; these are added on top. */
function AssignDialog({
  ticketId,
  current,
  onClose,
}: {
  ticketId: string;
  current: Assignment[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const users = useQuery({
    queryKey: ["admin", "users", "picker"],
    queryFn: () => apiFetch<PortalUser[]>("/admin/users"),
  }).data;
  const [draft, setDraft] = useState(current.map((a) => ({ user_id: a.user_id, role: a.role })));
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("csm");
  const label = (id: string) => {
    const u = users?.find((x) => x.id === id);
    return u ? (u.name ?? u.email) : (current.find((a) => a.user_id === id)?.name ?? id);
  };
  const add = () => {
    if (userId && !draft.some((d) => d.user_id === userId && d.role === role))
      setDraft([...draft, { user_id: userId, role }]);
    setUserId("");
  };
  const save = useMutation({
    mutationFn: () => sendJson<Assignment[]>("PUT", `/programs/${ticketId}/assignments`, draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["programs", ticketId, "assignments"] });
      void queryClient.invalidateQueries({ queryKey: ["queues"] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign people</DialogTitle>
          <DialogDescription>
            Assigned people see this program in their queue, on top of the CSM named in HubSpot.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-[13px]">
          {draft.length === 0 && <li className="text-ink-2">Nobody assigned here yet.</li>}
          {draft.map((d) => (
            <li key={`${d.user_id}-${d.role}`} className="flex items-center justify-between gap-2">
              <span>
                {label(d.user_id)} <span className="text-ink-3">· {ROLE_NAME[d.role]}</span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${label(d.user_id)}`}
                onClick={() => setDraft(draft.filter((x) => x !== d))}
                className="text-ink-2 hover:text-foreground"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger aria-label="Person" className="min-w-[180px] flex-1">
              <SelectValue placeholder="Pick a person" />
            </SelectTrigger>
            <SelectContent>
              {(users ?? [])
                .filter((u) => u.is_active)
                .map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name ?? u.email}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger aria-label="Role" className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(ROLE_NAME).map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" disabled={!userId} onClick={add}>
            Add
          </Button>
        </div>
        {save.isError && <p className="text-[13px] text-danger">Couldn't save. Try again.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HubspotHistory({ ticketId }: { ticketId: string }) {
  const { data, isLoading } = useQuery(historyQueryOptions(ticketId));
  const history = data ?? [];
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? history : history.slice(0, 3);
  return (
    <Section
      flush
      title="HubSpot history"
      meta={
        history.length > 3 ? (
          <MoreButton onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show latest 3" : `All ${history.length} changes`}
          </MoreButton>
        ) : undefined
      }
    >
      {isLoading ? (
        <Skeleton className="m-4 h-20" />
      ) : history.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-ink-2">
          No changes recorded for this program yet.
        </p>
      ) : (
        <ol className={cn(showAll && "max-h-96 overflow-y-auto")}>
          {shown.map((h, i) => {
            const line = describeHistory(h);
            return (
              <li
                key={`${h.property_name}|${h.changed_at}|${i}`}
                className="flex items-start justify-between gap-3 border-b border-border px-4 py-2.5 text-[14px] last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="font-medium">{line.text}</p>
                  {(line.added.length > 0 || line.removed.length > 0) && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {line.added.map((a) => (
                        <Chip key={`+${a}`} tone="good">
                          <Check className="size-3" />
                          {a}
                        </Chip>
                      ))}
                      {line.removed.map((a) => (
                        <Chip key={`-${a}`}>Unticked {a}</Chip>
                      ))}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-[13px] text-ink-2">{formatWhen(h.changed_at)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}
