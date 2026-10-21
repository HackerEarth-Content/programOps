import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  ActionItem,
  Chip,
  HealthPill,
  KpiTile,
  Skeleton,
  StatusDot,
  type StatusTone,
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
import { Textarea } from "@/components/ui/textarea";
import {
  apiFetch,
  checklistStatusQueryOptions,
  createNote,
  historyQueryOptions,
  notesQueryOptions,
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

export function ProgramOverview({ ticketId, program }: { ticketId: string; program: Program }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <NeedsToday ticketId={ticketId} />
        <Kpis ticketId={ticketId} />
        <RoundPlan ticketId={ticketId} />
        <StageChecklist ticketId={ticketId} program={program} />
      </div>
      <aside className="flex min-w-0 flex-col gap-5">
        <LatestUpdate ticketId={ticketId} />
        <Brief ticketId={ticketId} program={program} />
        <Notes ticketId={ticketId} />
        <HubspotHistory ticketId={ticketId} />
      </aside>
    </div>
  );
}

function Section({
  title,
  meta,
  children,
  className,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("surface p-5", className)}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[16px] font-semibold">{title}</h2>
        {meta && <span className="text-[13px] text-ink-2">{meta}</span>}
      </div>
      {children}
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
  const items = data ?? [];
  return (
    <Section
      title="Needs you today"
      meta={items.length > 0 ? `${items.length} items · most urgent first` : undefined}
    >
      {isLoading ? (
        <Skeleton className="h-28" />
      ) : isError ? (
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          Couldn't load this list. Retry
        </Button>
      ) : items.length === 0 ? (
        <p className="text-[14px] text-ink-2">Nothing needs you today. All clear.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((i) => (
            <ActionItem
              key={i.id}
              tone={i.severity}
              title={i.title}
              detail={i.detail}
              action={
                i.action ? (
                  <Button asChild size="sm" variant="outline" className="shrink-0">
                    <Link
                      to="/programs/$ticketId"
                      params={{ ticketId }}
                      search={{ tab: parseTab(i.tab) }}
                    >
                      {i.action}
                    </Link>
                  </Button>
                ) : undefined
              }
            />
          ))}
        </div>
      )}
    </Section>
  );
}

// ---- Key numbers -------------------------------------------------------------------------------

function Kpis({ ticketId }: { ticketId: string }) {
  const { data: r, isError, refetch } = useQuery(reportQuery(ticketId));
  if (isError) {
    return (
      <div className="surface flex items-center justify-between px-5 py-3">
        <span className="text-[14px] text-ink-2">Couldn't load the program report.</span>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!r) {
    return (
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-[112px]" />
        ))}
      </div>
    );
  }
  const { registrations: reg, operations: ops, marketing: m } = r;
  const screening = r.funnel.find((s) => s.as_of !== null);
  const attempted = screening?.attempted ?? null;
  const invited = screening?.invited ?? null;
  const screeningPct = attempted != null && invited ? (100 * attempted) / invited : null;
  const target = reg.target;
  const noneApproved = m.total > 0 && m.approved === 0;
  const met = reg.pct_of_target != null && reg.pct_of_target >= 100;
  return (
    <section
      aria-label="Key numbers"
      className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3"
    >
      <KpiTile
        label="Registrations"
        value={reg.raw_total.toLocaleString("en-US")}
        pct={reg.pct_of_target}
        bar={met ? "ok" : "accent"}
        note={
          target
            ? `${formatPct(reg.pct_of_target)} of ${target.toLocaleString("en-US")} target`
            : "No target set"
        }
        noteTone={met ? "ok" : "neutral"}
      />
      <KpiTile
        label="Relevant"
        value={reg.relevant_total.toLocaleString("en-US")}
        pct={reg.relevant_pct}
        note={`${formatPct(reg.relevant_pct)} of registrations · CSM-entered`}
      />
      <KpiTile
        label="Screening"
        value={
          screening
            ? invited != null
              ? `${attempted ?? 0} / ${invited}`
              : (attempted ?? "—")
            : "—"
        }
        pct={screeningPct}
        note={
          screening
            ? `Attempted · ${screening.cleared ?? 0} cleared · ${screening.shortlisted ?? 0} shortlisted`
            : "No counts entered yet"
        }
      />
      <KpiTile
        label="Marketing live"
        value={`${m.live} / ${m.total}`}
        pct={m.total ? (100 * m.live) / m.total : 0}
        bar={noneApproved ? "warn" : "accent"}
        note={noneApproved ? "None approved yet" : `${m.approved} approved`}
        noteTone={noneApproved ? "warn" : "neutral"}
      />
      <KpiTile
        label="Delivery"
        value={`${ops.phases_done} / ${ops.phases_total}`}
        pct={ops.phases_total ? (100 * ops.phases_done) / ops.phases_total : 0}
        bar={ops.projected_slip_days ? "warn" : "ok"}
        note={
          ops.projected_slip_days ? `${ops.projected_slip_days}d projected slip` : "Phases done"
        }
        noteTone={ops.projected_slip_days ? "warn" : "neutral"}
      />
    </section>
  );
}

// ---- Round plan --------------------------------------------------------------------------------

function roundStatus(r: Round): { text: string; tone: StatusTone } {
  if (r.status === "done") return { text: "Done", tone: "ok" };
  const dates = r.starts_on || r.ends_on ? formatRange(r.starts_on, r.ends_on) : null;
  if (!dates) return { text: "Not scheduled", tone: "neutral" };
  const gate = r.readiness;
  if (r.status === "live") return { text: `${dates} · live`, tone: "ok" };
  if (r.status === "evaluating") return { text: `${dates} · evaluating`, tone: "neutral" };
  if (!gate) return { text: dates, tone: "neutral" };
  if (gate.status === "ready" || gate.status === "done")
    return { text: `${dates} · ready`, tone: "ok" };
  const daysToStart = r.starts_on
    ? Math.round((new Date(`${r.starts_on}T00:00:00+05:30`).getTime() - Date.now()) / 864e5)
    : null;
  return daysToStart !== null && daysToStart <= 3
    ? { text: `${dates} · not ready`, tone: "danger" }
    : { text: `${dates} · readiness ${gate.done}/${gate.total}`, tone: "neutral" };
}

type Tile = { key: string; n: number; name: string; status: string; tone: StatusTone };

function RoundPlan({ ticketId }: { ticketId: string }) {
  const rounds = useQuery(roundsQuery(ticketId));
  const docs = useQuery(programDocumentsQueryOptions(ticketId));
  const report = useQuery(reportQuery(ticketId)).data;
  const sow = docs.data?.sow?.details ?? null;
  const planned = rounds.data ?? [];
  const tiles: Tile[] =
    planned.length > 0
      ? planned.map((r, i) => {
          const s = roundStatus(r);
          return { key: `round-${r.id}`, n: i + 1, name: r.name, status: s.text, tone: s.tone };
        })
      : (sow?.rounds ?? []).map((r, i) => ({
          key: `sow-${i}`,
          n: i + 1,
          name: r.name,
          status: "Not scheduled",
          tone: "neutral",
        }));
  const meta = [
    sow ? "From SOW" : null,
    report?.registrations.target
      ? `target ${report.registrations.target.toLocaleString("en-US")} registrations`
      : null,
    sow?.registration_window_weeks_min && sow.registration_window_weeks_max
      ? sow.registration_window_weeks_min === sow.registration_window_weeks_max
        ? `${sow.registration_window_weeks_min} week window`
        : `${sow.registration_window_weeks_min}–${sow.registration_window_weeks_max} week window`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Section title="Round plan" meta={meta || undefined}>
      {rounds.isLoading ? (
        <Skeleton className="h-20" />
      ) : tiles.length === 0 ? (
        <p className="text-[14px] text-ink-2">
          No rounds yet. Add them in the Rounds tab, or upload the SOW in Documents.
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5">
          {tiles.map((t) => (
            <div key={t.key} className="flex flex-col gap-1.5 rounded-[10px] bg-raised p-3.5">
              <p className="text-[12px] text-ink-3">Stage {t.n}</p>
              <p className="font-medium">{t.name}</p>
              <StatusDot tone={t.tone} label={t.status} hollow={t.tone === "neutral"} />
            </div>
          ))}
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
  onClose,
  onDone,
}: {
  pending: PendingWrite | null;
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
          <AlertDialogTitle>Change the HubSpot ticket?</AlertDialogTitle>
          <AlertDialogDescription>
            This will change the live ticket in HubSpot: <strong>{pending?.change}</strong>. It is
            recorded in the audit log under your name. Are you sure you want to make this move?
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
            Yes, change HubSpot
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
  const canWrite = useCan("hubspot.write") && status.data?.hubspot_writeback_enabled === true;
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [target, setTarget] = useState("");
  const [showAll, setShowAll] = useState(false);
  const c = data?.find((i) => i.ticket_id === ticketId);
  const current = stageKey(program.stage);
  // What HubSpot itself has ticked: the completed list minus items we only infer from the SOW.
  const ticked = c ? c.completed_items.filter((i) => !c.derived_items.includes(i)) : [];
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
      title={`${program.stage} stage checklist`}
      meta={c && rows.length > 0 ? `${c.completed_items.length} of ${rows.length} done` : undefined}
    >
      {isLoading ? (
        <Skeleton className="h-28" />
      ) : isError ? (
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          Couldn't load the checklist. Retry
        </Button>
      ) : !c || rows.length === 0 ? (
        <p className="text-[14px] text-ink-2">This stage has no checklist.</p>
      ) : (
        <>
          <div
            className="mb-3 h-1.5 overflow-hidden rounded-full bg-raised"
            role="progressbar"
            aria-label="Checklist progress"
            aria-valuenow={Math.round((100 * c.completed_items.length) / rows.length)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-1.5 rounded-full bg-ok"
              style={{ width: `${(100 * c.completed_items.length) / rows.length}%` }}
            />
          </div>
          <ul>
            {visible.map((row) => {
              const fromSow = c.derived_items.includes(row.label);
              const editable = canWrite && !fromSow;
              return (
                <li key={row.label} className="border-t border-border">
                  <label
                    className={cn(
                      "flex items-center gap-3 py-2.5",
                      editable ? "cursor-pointer" : "cursor-default",
                      row.done && "text-ink-3",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={row.done}
                      disabled={!editable}
                      onChange={() => toggle(row.label, !row.done)}
                      className="size-[18px] accent-ok"
                    />
                    <span className="flex-1">{row.label}</span>
                    {fromSow && <span className="text-[12px] text-ink-3">From the SOW</span>}
                    {!row.done && row.label === c.pending_items[0] && (
                      <span className="text-[12px] text-ink-3">Next</span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          {rows.length > SHOWN_ITEMS && (
            <div className="mt-1">
              <MoreButton onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show ${rows.length - SHOWN_ITEMS} more`}
              </MoreButton>
            </div>
          )}
        </>
      )}
      {canWrite && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-[13px] text-ink-2">Move stage</span>
          <select
            aria-label="Move the HubSpot ticket to stage"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-8 rounded-[8px] border border-border bg-surface px-2 text-[13px]"
          >
            <option value="">Choose a stage…</option>
            {STAGES.filter((s) => s !== program.stage).map((s) => (
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
        </div>
      )}
      <HubspotConfirm pending={pending} onClose={() => setPending(null)} onDone={refresh} />
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
        <p className="text-[14px] text-ink-2">
          No update posted yet. Use Post update at the top of the page.
        </p>
      ) : (
        <>
          <p className="whitespace-pre-wrap font-medium">{latest.body}</p>
          {latest.blockers && (
            <p className="mt-2 rounded-[8px] bg-danger-bg px-3 py-2.5 text-[13px] text-danger">
              Blocked: {latest.blockers}
            </p>
          )}
          <p className="mt-2.5 text-[12px] text-ink-3">
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

function Brief({ ticketId, program }: { ticketId: string; program: Program }) {
  const docs = useQuery(programDocumentsQueryOptions(ticketId)).data;
  const regs = useQuery(registrationsQueryOptions(ticketId)).data;
  const sow = docs?.sow?.details ?? null;
  const linked = program.company_name ?? program.blackops_account_name;
  const sowClient = known(sow?.customer);
  const est = regs?.estimate;
  const people = peopleByName(program);
  const [linking, setLinking] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const canAssign = useCan("users.manage");
  const assigned = useQuery(assignmentsQuery(ticketId)).data ?? [];
  const [copied, setCopied] = useState(false);
  const rows: { k: string; v: ReactNode }[] = [
    {
      k: "Client",
      v: linked ? (
        linked
      ) : sowClient ? (
        <span className="text-ink-2">
          Not linked ·{" "}
          <button
            type="button"
            onClick={() => setLinking(true)}
            className="text-primary hover:underline"
          >
            How to link {sowClient}
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
      <dl className="-mt-1">
        {rows.map((r) => (
          <div
            key={r.k}
            className="flex justify-between gap-4 border-t border-border py-2.5 text-[13px] first:border-t-0"
          >
            <dt className="shrink-0 text-ink-2">{r.k}</dt>
            <dd className="min-w-0 text-right">{r.v}</dd>
          </div>
        ))}
      </dl>
      <Dialog open={linking} onOpenChange={setLinking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link {sowClient} in HubSpot</DialogTitle>
            <DialogDescription>
              ProgramOps reads the client from HubSpot and can't link it from here. The SOW names{" "}
              <strong>{sowClient}</strong>. In HubSpot, open ticket {program.ticket_id}, associate
              that company, then press Sync in the top bar. The client appears here after the sync.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(sowClient ?? "");
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy name"}
            </Button>
            <Button variant="outline" onClick={() => setLinking(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {assigning && (
        <AssignDialog ticketId={ticketId} current={assigned} onClose={() => setAssigning(false)} />
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

function Notes({ ticketId }: { ticketId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery(notesQueryOptions(ticketId));
  const notes = data ?? [];
  const canEdit = useCan("comment.add");
  const [body, setBody] = useState("");
  const [showAll, setShowAll] = useState(false);
  const add = useMutation({
    mutationFn: () => createNote(ticketId, body.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["programs", ticketId, "notes"] });
      setBody("");
    },
  });
  const canSend = body.trim().length > 0 && !add.isPending;
  const shown = showAll ? notes : notes.slice(0, 3);
  return (
    <Section
      title="Internal notes"
      meta={
        notes.length > 3 ? (
          <MoreButton onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show latest 3" : `All ${notes.length}`}
          </MoreButton>
        ) : undefined
      }
    >
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) add.mutate();
          }}
          className="space-y-2"
        >
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Client confirmed creatives by Thursday"
            aria-label="Internal note"
            rows={2}
            className="min-h-16 bg-raised"
          />
          {add.isError && (
            <p className="text-[13px] text-danger">
              {add.error instanceof Error ? add.error.message : "Couldn't save the note."}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" size="sm" variant="outline" disabled={!canSend}>
              {add.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Add note
            </Button>
          </div>
        </form>
      )}
      {isLoading ? (
        <Skeleton className="mt-2 h-16" />
      ) : notes.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-2">No internal notes yet.</p>
      ) : (
        <ul className={cn("mt-2", showAll && "max-h-80 overflow-y-auto")}>
          {shown.map((n) => (
            <li key={n.note_id} className="border-t border-border py-2.5">
              <p className="whitespace-pre-wrap text-[13px]">{n.body}</p>
              <p className="text-[12px] text-ink-3">
                {n.author_name ??
                  (n.author_user_id != null
                    ? `HubSpot user ${n.author_user_id}`
                    : "Unknown author")}{" "}
                · {formatWhen(n.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function HubspotHistory({ ticketId }: { ticketId: string }) {
  const { data, isLoading } = useQuery(historyQueryOptions(ticketId));
  const history = data ?? [];
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? history : history.slice(0, 3);
  return (
    <Section
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
        <Skeleton className="h-20" />
      ) : history.length === 0 ? (
        <p className="text-[13px] text-ink-2">No changes recorded for this program yet.</p>
      ) : (
        <ol className={cn(showAll && "max-h-96 overflow-y-auto")}>
          {shown.map((h, i) => {
            const line = describeHistory(h);
            return (
              <li
                key={`${h.property_name}|${h.changed_at}|${i}`}
                className="flex items-start justify-between gap-3 border-t border-border py-2.5 text-[13px] first:border-t-0"
              >
                <div className="min-w-0">
                  <p>{line.text}</p>
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
                <span className="shrink-0 text-[12px] text-ink-3">{formatWhen(h.changed_at)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}
