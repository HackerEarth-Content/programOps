import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Hash,
  History,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Avatar,
  Bar,
  Card,
  CardBody,
  CardHeader,
  Chip,
  EmptyState,
  HEALTH_NAMES,
  HealthPill,
  Kpi,
  LogList,
  MonoLabel,
  Num,
  Segmented,
  Skeleton,
  type Tone,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { lookupSlackChannel, useCan } from "@/lib/api";
import { assignmentsQuery } from "@/lib/marketing-api";
import { formatDate, formatDateTime, timeAgo } from "@/lib/format";
import {
  HEALTH_REASONS,
  activitiesQuery,
  postComment,
  postUpdate,
  reportQuery,
  requestTemplatesQuery,
  roundsQuery,
  type AuditEvent,
  type Checklist,
  type FunnelStep,
  type Health,
} from "@/lib/ops-api";
import {
  AUDIT_ENTITIES,
  ROUND_KINDS,
  ROUND_STATUSES,
  addDependency,
  auditFeedQuery,
  communicationsQuery,
  countsHistoryQuery,
  createRound,
  decideChange,
  deleteRound,
  dependenciesQuery,
  patchCommunication,
  patchDependency,
  patchRequest,
  patchRound,
  recordCounts,
  planCommunication,
  proposeChange,
  raiseRequest,
  setChangeTask,
  confirmChecklistItem,
  suggestedRoundsQuery,
  supersedeCounts,
  timelineChangesQuery,
  updatesFeedQuery,
  type Comm,
  type CommKind,
  type CountsFields,
  type CountsRow,
  type RoundFull,
  type RequestFull,
  roundsFullQuery,
  requestsFullQuery,
  type Dependency,
  type RequestStatus,
  type RoundKind,
  type RoundStatus,
  type SubjectType,
  type TimelineChange,
} from "@/lib/ops-extra-api";
import { logSentence } from "@/lib/history";
import { cn } from "@/lib/utils";

// ---- shared bits ------------------------------------------------------------------------------

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
const n = (v: number | null | undefined) => (v == null ? "–" : v.toLocaleString("en-IN"));
const pct = (v: number | null | undefined) => (v == null ? "–" : `${v}%`);
const today = () => new Date().toISOString().slice(0, 10);
const label = (s: string) => s.replace(/_/g, " ");
const titleCase = (s: string) => label(s).replace(/^./, (c) => c.toUpperCase());
const isPast = (iso: string | null | undefined) => !!iso && iso.slice(0, 10) < today();

/** "due 3 Nov", turning red once it is past and the item is still open. */
function Due({
  at,
  open = true,
  prefix = "due",
}: {
  at: string | null | undefined;
  open?: boolean;
  prefix?: string;
}) {
  if (!at) return null;
  const late = open && isPast(at);
  return (
    <span className={cn(late && "font-medium text-status-critical")}>
      {prefix} {formatDate(at)}
      {late && " · overdue"}
    </span>
  );
}

/** A toast with an Undo button, for one-click status moves that can be taken back. */
const undoable = (message: string, undo: () => void) =>
  toast(message, { action: { label: "Undo", onClick: undo }, duration: 7000 });

/** A text draft that survives a reload (per program); storage may be unavailable, so it never throws. */
function useDraft(key: string): [string, (v: string) => void] {
  const k = `programops:draft:${key}`;
  const [value, setValue] = useState("");
  useEffect(() => {
    try {
      setValue(localStorage.getItem(k) ?? "");
    } catch {
      /* no storage: start empty */
    }
  }, [k]);
  const set = (v: string) => {
    setValue(v);
    try {
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  };
  return [value, set];
}

function OwnerSelect({
  ticketId,
  value,
  onPick,
  disabled,
}: {
  ticketId: string;
  value: string | null;
  onPick: (id: string | null) => void;
  disabled?: boolean;
}) {
  const people = useQuery(assignmentsQuery(ticketId)).data ?? [];
  return (
    <Select
      aria-label="Owner"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onPick(e.target.value || null)}
    >
      <option value="">Unassigned</option>
      {people.map((p) => (
        <option key={p.user_id} value={p.user_id}>
          {p.name} · {label(p.role)}
        </option>
      ))}
    </Select>
  );
}

const HEALTH_TONE: Record<Health, Tone> = {
  good: "good",
  warning: "warning",
  critical: "critical",
};
const ROUND_TONE: Record<RoundStatus, Tone> = {
  planned: "neutral",
  live: "info",
  evaluating: "warning",
  done: "good",
};
const REQUEST_TONE: Record<RequestStatus, Tone> = {
  open: "neutral",
  in_progress: "info",
  ready: "indigo",
  done: "good",
  declined: "serious",
};
function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-xl border border-status-critical/30 bg-status-critical/5 px-4 py-3"
    >
      <span className="flex items-center gap-2 t-body-sm text-status-critical">
        <AlertTriangle className="size-4 shrink-0" />
        {errorText(error)}
      </span>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="size-3.5" /> Retry
        </Button>
      )}
    </div>
  );
}

const MutationError = ({
  m,
}: {
  m: UseMutationResult<unknown, Error, never> | { isError: boolean; error: unknown };
}) =>
  m.isError ? (
    <p role="alert" className="t-body-sm text-status-critical">
      {errorText(m.error)}
    </p>
  ) : null;

function Field({
  label: l,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <MonoLabel>{l}</MonoLabel>
      {children}
    </label>
  );
}

function Select({ className, ...rest }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-8 rounded-[6px] border border-input bg-card px-2 t-body-sm text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}

const ListSkeleton = ({ rows = 3 }: { rows?: number }) => (
  <div className="space-y-3" aria-busy="true">
    {Array.from({ length: rows }, (_, i) => (
      <Skeleton key={i} className="h-24 w-full" />
    ))}
  </div>
);

function useRefresh(ticketId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["programs", ticketId] });
}

// ---- overview strip: the one-view report -------------------------------------------------------

export function ReportStrip({ ticketId }: { ticketId: string }) {
  const { data: r, isLoading, isError, error, refetch } = useQuery(reportQuery(ticketId));
  if (isLoading)
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  if (isError || !r) return <ErrorBox error={error} onRetry={() => void refetch()} />;
  const { registrations: reg, operations: ops, marketing: m, funnel_summary: f } = r;
  return (
    <section className="space-y-3" aria-label="Program report">
      <div className="flex flex-wrap items-center gap-2">
        <HealthPill health={ops.health} />
        {ops.reasons.map((code) => (
          <span key={code} className="t-body-sm text-muted-foreground">
            {HEALTH_REASONS[code] ?? code}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          index={0}
          label="Registrations"
          value={<Num value={reg.raw_total} />}
          sub={
            reg.target ? `${pct(reg.pct_of_target)} of ${n(reg.target)} target` : "No target set"
          }
        />
        <Kpi
          index={1}
          label="Relevant"
          value={<Num value={reg.relevant_total} />}
          sub={`${pct(reg.relevant_pct)} of registrations`}
        />
        <Kpi
          index={2}
          label="Participants"
          value={f.participants == null ? "–" : <Num value={f.participants} />}
          sub={`${n(f.final_shortlisted)} shortlisted · ${pct(f.registered_to_shortlist_pct)}`}
        />
        <Kpi
          index={3}
          label="Marketing"
          value={`${m.live}/${m.total}`}
          unit="live"
          {...(m.breaches ? { tone: "critical" as const } : {})}
          sub={`${m.awaiting_approval} awaiting approval${m.breaches ? ` · ${m.breaches} breach` : ""}`}
        />
      </div>
    </section>
  );
}

// ==== ROUNDS ====================================================================================

type FunnelStage = { key: string; name: string; value: number | null };
const stagesOf = (s: FunnelStep): FunnelStage[] => [
  { key: "invited", name: "Invited", value: s.invited },
  { key: "took", name: "Attempted", value: s.attempted },
  { key: "cleared", name: "Cleared", value: s.cleared },
  { key: "short", name: "Shortlisted", value: s.shortlisted },
];

function FunnelCard({
  steps,
  summary,
}: {
  steps: FunnelStep[];
  summary: {
    participants: number | null;
    final_shortlisted: number | null;
    registered_to_shortlist_pct: number | null;
  };
}) {
  return (
    <Card>
      <CardHeader
        title="Round funnel"
        meta={
          summary.final_shortlisted != null && (
            <span>
              {n(summary.participants)} participants → {n(summary.final_shortlisted)} shortlisted ·{" "}
              {pct(summary.registered_to_shortlist_pct)}
            </span>
          )
        }
        divided
      />
      <ol className="divide-y divide-border reveal">
        {steps.map((s, si) => {
          const stages = stagesOf(s);
          const base = Math.max(...stages.map((x) => x.value ?? 0), 0);
          return (
            <li
              key={s.round_id}
              className="grid gap-3 px-[18px] py-3.5 md:grid-cols-[200px_1fr]"
              style={{ ["--i" as string]: si }}
            >
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold">
                  <span className="t-data-sm mr-1.5 text-muted-foreground">{s.seq}</span>
                  {s.name}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Chip tone="info">{pct(s.participation_pct)} took part</Chip>
                  {s.clearance_pct != null && (
                    <Chip tone="indigo">{pct(s.clearance_pct)} cleared</Chip>
                  )}
                  {s.shortlist_pct != null && (
                    <Chip tone="good">{pct(s.shortlist_pct)} shortlisted</Chip>
                  )}
                  {s.drop_off != null && s.drop_off > 0 && (
                    <Chip tone="warning">−{n(s.drop_off)} drop-off</Chip>
                  )}
                </div>
                {s.as_of && (
                  <p className="mt-1 t-data-sm text-muted-foreground">
                    as of {formatDate(s.as_of)}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
                {stages.map((st, i) => (
                  <div key={st.key} className="min-w-0">
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <MonoLabel>{st.name}</MonoLabel>
                      <span className="t-data-sm">{n(st.value)}</span>
                    </div>
                    <Bar
                      pct={st.value == null || !base ? 0 : (st.value / base) * 100}
                      tone={(["info", "indigo", "warning", "good"] as const)[i] ?? "info"}
                      index={si * 4 + i}
                    />
                  </div>
                ))}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

const COUNT_FIELDS = ["invited", "attempted", "cleared", "shortlisted"] as const;

function CountsForm({
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  withDate,
}: {
  initial?: Omit<CountsRow, "supersedes_id"> | null | undefined;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (asOf: string, fields: CountsFields) => void;
  onCancel?: () => void;
  withDate: boolean;
}) {
  const [asOf, setAsOf] = useState(today());
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      COUNT_FIELDS.map((f) => [f, initial?.[f] == null ? "" : String(initial[f])]),
    ),
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const submit = () => {
    const f: CountsFields = {};
    for (const k of COUNT_FIELDS) {
      const v = draft[k];
      if (v !== undefined && v !== "") f[k] = Number(v);
    }
    if (note.trim()) f.note = note.trim();
    onSubmit(asOf, f);
  };
  const any = Object.values(draft).some((v) => v !== "");
  return (
    <form
      className="surface-inset space-y-3 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap items-end gap-2.5">
        {withDate && (
          <Field label="As of">
            <Input
              type="date"
              value={asOf}
              max={today()}
              onChange={(e) => setAsOf(e.target.value)}
              className="w-36"
            />
          </Field>
        )}
        {COUNT_FIELDS.map((f) => (
          <Field key={f} label={f}>
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              value={draft[f] ?? ""}
              onChange={(e) => setDraft({ ...draft, [f]: e.target.value })}
              className="w-24"
            />
          </Field>
        ))}
        <Field label="Note" className="min-w-40 flex-1">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </Field>
      </div>
      <p className="t-body-sm text-muted-foreground">
        Attempted can't exceed invited, cleared can't exceed attempted, and shortlisted can't exceed
        cleared. A round can only invite people the round before shortlisted.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending || !any || !asOf}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {error != null && (
          <span className="t-body-sm text-status-critical">{errorText(error)}</span>
        )}
      </div>
    </form>
  );
}

function CountsHistory({
  ticketId,
  round,
  onChanged,
}: {
  ticketId: string;
  round: RoundFull;
  onChanged: () => void;
}) {
  const canEnter = useCan("counts.enter");
  const { data, isLoading, isError, error, refetch } = useQuery(
    countsHistoryQuery(ticketId, round.id),
  );
  const [correcting, setCorrecting] = useState<number | null>(null);
  const fix = useMutation({
    mutationFn: ({ id, f }: { id: number; f: CountsFields }) =>
      supersedeCounts(ticketId, round.id, id, f),
    onSuccess: () => {
      setCorrecting(null);
      onChanged();
    },
  });
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (isError) return <ErrorBox error={error} onRetry={() => void refetch()} />;
  if (!data?.length)
    return <p className="t-body-sm text-muted-foreground">No counts recorded yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="t-th py-1.5 pr-3">As of</th>
            {COUNT_FIELDS.map((f) => (
              <th key={f} className="t-th py-1.5 text-right">
                {f}
              </th>
            ))}
            <th className="t-th py-1.5 pl-4">Entered by</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.map((c) => (
            <tr key={c.id} className="border-b border-border/60 last:border-0 align-top">
              <td className="t-data-sm py-1.5 pr-3">
                {formatDate(c.as_of)}
                {c.supersedes_id != null && (
                  <span className="ml-1.5 text-muted-foreground">corrected</span>
                )}
              </td>
              {COUNT_FIELDS.map((f) => (
                <td key={f} className="t-data-sm py-1.5 text-right">
                  {n(c[f])}
                </td>
              ))}
              <td
                className="py-1.5 pl-4 t-body-sm text-secondary-foreground"
                title={formatDateTime(c.entered_at)}
              >
                {c.entered_by_name}
                {c.note && <span className="block text-muted-foreground">{c.note}</span>}
              </td>
              <td className="py-1.5 text-right">
                {canEnter && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setCorrecting(correcting === c.id ? null : c.id)}
                  >
                    Correct
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {correcting != null && (
        <div className="mt-2">
          <CountsForm
            withDate={false}
            initial={data.find((c) => c.id === correcting)}
            submitLabel="Save correction"
            pending={fix.isPending}
            error={fix.isError ? fix.error : null}
            onSubmit={(_, f) => fix.mutate({ id: correcting, f })}
            onCancel={() => setCorrecting(null)}
          />
        </div>
      )}
    </div>
  );
}

function RoundCard({
  round,
  ticketId,
  onChanged,
  index,
}: {
  round: RoundFull;
  ticketId: string;
  onChanged: () => void;
  index: number;
}) {
  const canEnter = useCan("counts.enter");
  const canEdit = useCan("rounds.edit");
  const [open, setOpen] = useState<"history" | "enter" | "edit" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useMutation({
    mutationFn: ({ asOf, f }: { asOf: string; f: CountsFields }) =>
      recordCounts(ticketId, round.id, { as_of: asOf, ...f }),
    onSuccess: () => {
      setOpen(null);
      onChanged();
    },
  });
  const edit = useMutation({
    mutationFn: ({ id, f }: { id: number; f: CountsFields }) =>
      supersedeCounts(ticketId, round.id, id, f),
    onSuccess: () => {
      setOpen(null);
      onChanged();
    },
  });
  const setStatus = useMutation({
    mutationFn: (status: RoundStatus) => patchRound(ticketId, round.id, { status }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => deleteRound(ticketId, round.id),
    onSuccess: onChanged,
  });
  const c = round.latest_counts;
  const ended =
    round.status === "evaluating" ||
    round.status === "done" ||
    (!!round.ends_on && round.ends_on < today());
  const missing = ended && !c;
  return (
    <Card className="rise" style={{ ["--i" as string]: index }}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-[18px] pt-4">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-[16px] font-semibold leading-[22px]">
            <span className="t-data-sm text-muted-foreground">{round.seq}</span>
            {round.name}
            <Chip tone={ROUND_TONE[round.status]}>{round.status}</Chip>
            <Chip>{round.kind}</Chip>
            {round.source === "sow" && <Chip tone="indigo">from SOW</Chip>}
          </h3>
          <p className="mt-1 t-data-sm text-muted-foreground">
            {formatDate(round.starts_on)} – {formatDate(round.ends_on)}
            {round.cutoff_rule &&
              ` · cutoff ${round.cutoff_rule}${round.cutoff_value != null ? ` ${round.cutoff_value}` : ""}`}
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-1.5">
            <Select
              aria-label="Round status"
              value={round.status}
              disabled={setStatus.isPending}
              onChange={(e) => setStatus.mutate(e.target.value as RoundStatus)}
            >
              {ROUND_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Edit round"
              aria-expanded={renaming}
              onClick={() => setRenaming((v) => !v)}
            >
              <Pencil className="size-4" />
            </Button>
            {confirmDelete ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  Delete round
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Delete round"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      <CardBody className="mt-3 space-y-3">
        {renaming && (
          <EditRound
            ticketId={ticketId}
            round={round}
            onDone={() => {
              setRenaming(false);
              onChanged();
            }}
            onCancel={() => setRenaming(false)}
          />
        )}
        {missing && (
          <p className="flex items-center gap-2 rounded-[8px] bg-status-warning/15 px-3 py-2 t-body-sm text-warn">
            <AlertTriangle className="size-4 shrink-0" /> Counts missing: this round has ended and
            nothing has been recorded.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {COUNT_FIELDS.map((f) => (
            <div key={f}>
              <MonoLabel>{f}</MonoLabel>
              <p className="t-data-md">{c ? n(c[f]) : "–"}</p>
            </div>
          ))}
        </div>
        {c && (
          <p className="t-data-sm text-muted-foreground" title={formatDateTime(c.entered_at)}>
            as of {formatDate(c.as_of)} · {c.entered_by_name}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-expanded={open === "history"}
            onClick={() => setOpen(open === "history" ? null : "history")}
          >
            <History className="size-3.5" /> Counts history
            {open === "history" ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </Button>
          {canEnter && c && (
            <Button
              size="sm"
              variant="outline"
              aria-expanded={open === "edit"}
              onClick={() => setOpen(open === "edit" ? null : "edit")}
            >
              <Pencil className="size-3.5" /> Edit counts
            </Button>
          )}
          {canEnter && (
            <Button
              size="sm"
              variant={missing ? "default" : "outline"}
              onClick={() => setOpen(open === "enter" ? null : "enter")}
            >
              <Plus className="size-3.5" /> {c ? "Add a new date" : "Enter counts"}
            </Button>
          )}
        </div>
        {open === "edit" && c && (
          <div className="space-y-1.5">
            <p className="t-body-sm text-muted-foreground">
              Editing the counts as of {formatDate(c.as_of)}. The earlier values stay in the counts
              history.
            </p>
            <CountsForm
              withDate={false}
              initial={c}
              submitLabel="Save changes"
              pending={edit.isPending}
              error={edit.isError ? edit.error : null}
              onSubmit={(_, f) => edit.mutate({ id: c.id, f })}
              onCancel={() => setOpen(null)}
            />
          </div>
        )}
        {open === "enter" && (
          <CountsForm
            withDate
            submitLabel="Record counts"
            pending={save.isPending}
            error={save.isError ? save.error : null}
            onSubmit={(asOf, f) => save.mutate({ asOf, f })}
            onCancel={() => setOpen(null)}
          />
        )}
        {open === "history" && (
          <CountsHistory ticketId={ticketId} round={round} onChanged={onChanged} />
        )}
        <MutationError m={setStatus} />
        <MutationError m={remove} />
      </CardBody>
    </Card>
  );
}

/** Rename a round or change its kind, dates and cutoff. The audit trail records each field that changed. */
function EditRound({
  ticketId,
  round,
  onDone,
  onCancel,
}: {
  ticketId: string;
  round: RoundFull;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(round.name);
  const [kind, setKind] = useState(round.kind as RoundKind);
  const [starts, setStarts] = useState(round.starts_on ?? "");
  const [ends, setEnds] = useState(round.ends_on ?? "");
  const [rule, setRule] = useState(round.cutoff_rule ?? "");
  const [value, setValue] = useState(round.cutoff_value == null ? "" : String(round.cutoff_value));
  const save = useMutation({
    mutationFn: () =>
      patchRound(ticketId, round.id, {
        name: name.trim(),
        kind,
        starts_on: starts || null,
        ends_on: ends || null,
        cutoff_rule: rule.trim() || null,
        cutoff_value: value === "" ? null : Number(value),
      }),
    onSuccess: onDone,
  });
  return (
    <form
      className="surface-inset space-y-3 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name" className="lg:col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value as RoundKind)}>
            {ROUND_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </Select>
        </Field>
        <span />
        <Field label="Starts">
          <Input type="date" value={starts} onChange={(e) => setStarts(e.target.value)} />
        </Field>
        <Field label="Ends">
          <Input type="date" value={ends} min={starts} onChange={(e) => setEnds(e.target.value)} />
        </Field>
        <Field label="Cutoff rule">
          <Input
            value={rule}
            onChange={(e) => setRule(e.target.value)}
            placeholder="e.g. Score at least"
          />
        </Field>
        <Field label="Cutoff value">
          <Input
            type="number"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={save.isPending || !name.trim()}>
          Save changes
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {save.isError && (
          <span className="t-body-sm text-status-critical">{errorText(save.error)}</span>
        )}
      </div>
    </form>
  );
}

function AddRound({
  ticketId,
  onChanged,
  nextSeq,
}: {
  ticketId: string;
  onChanged: () => void;
  nextSeq: number;
}) {
  const { data: suggested = [] } = useQuery(suggestedRoundsQuery(ticketId));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<RoundKind>("assessment");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [rule, setRule] = useState("");
  const [value, setValue] = useState("");
  const reset = () => {
    setName("");
    setStarts("");
    setEnds("");
    setRule("");
    setValue("");
    setOpen(false);
    onChanged();
  };
  const add = useMutation({
    mutationFn: () =>
      createRound(ticketId, {
        name: name.trim(),
        kind,
        starts_on: starts || null,
        ends_on: ends || null,
        cutoff_rule: rule.trim() || null,
        cutoff_value: value === "" ? null : Number(value),
      }),
    onSuccess: reset,
  });
  const accept = useMutation({
    mutationFn: (s: { name: string }) => createRound(ticketId, { name: s.name, source: "sow" }),
    onSuccess: onChanged,
  });
  return (
    <Card>
      <CardHeader
        title="Add a round"
        meta={`next: round ${nextSeq}`}
        divided={open || suggested.length > 0}
      />
      {suggested.length > 0 && (
        <div className="space-y-2 px-[18px] py-3">
          <MonoLabel>Suggested from the SOW</MonoLabel>
          <ul className="space-y-1.5">
            {suggested.map((s) => (
              <li
                key={s.name}
                className="flex items-center justify-between gap-3 rounded-[8px] border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-[14px] font-medium">{s.name}</p>
                  {s.notes && <p className="truncate t-body-sm text-muted-foreground">{s.notes}</p>}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={accept.isPending}
                  onClick={() => accept.mutate(s)}
                >
                  <Check className="size-3.5" /> Accept
                </Button>
              </li>
            ))}
          </ul>
          <MutationError m={accept} />
        </div>
      )}
      <CardBody className={cn(!open && suggested.length === 0 && "pt-0")}>
        {open ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Name" className="lg:col-span-2">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Round 2: Coding assessment"
                  required
                />
              </Field>
              <Field label="Kind">
                <Select value={kind} onChange={(e) => setKind(e.target.value as RoundKind)}>
                  {ROUND_KINDS.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </Select>
              </Field>
              <span />
              <Field label="Starts">
                <Input type="date" value={starts} onChange={(e) => setStarts(e.target.value)} />
              </Field>
              <Field label="Ends">
                <Input
                  type="date"
                  value={ends}
                  min={starts}
                  onChange={(e) => setEnds(e.target.value)}
                />
              </Field>
              <Field label="Cutoff rule">
                <Input
                  value={rule}
                  onChange={(e) => setRule(e.target.value)}
                  placeholder="e.g. score >="
                />
              </Field>
              <Field label="Cutoff value">
                <Input
                  type="number"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="font-mono"
                />
              </Field>
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={!name.trim() || add.isPending}>
                Add round
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <MutationError m={add} />
            </div>
          </form>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Plus className="size-3.5" /> New round
          </Button>
        )}
      </CardBody>
    </Card>
  );
}

export function ProgramRounds({ ticketId }: { ticketId: string }) {
  const refresh = useRefresh(ticketId);
  const rounds = useQuery(roundsFullQuery(ticketId));
  const report = useQuery(reportQuery(ticketId));
  const canEdit = useCan("rounds.edit");
  if (rounds.isLoading) return <ListSkeleton />;
  if (rounds.isError)
    return <ErrorBox error={rounds.error} onRetry={() => void rounds.refetch()} />;
  const list = rounds.data ?? [];
  return (
    <div className="space-y-4 page-in">
      {report.data && report.data.funnel.length > 0 && (
        <FunnelCard steps={report.data.funnel} summary={report.data.funnel_summary} />
      )}
      {report.isError && <ErrorBox error={report.error} onRetry={() => void report.refetch()} />}
      {list.length === 0 ? (
        <EmptyState
          title="No rounds yet"
          hint="Add the rounds this program runs, or accept the ones suggested from the SOW."
        />
      ) : (
        list.map((r, i) => (
          <RoundCard key={r.id} round={r} ticketId={ticketId} onChanged={refresh} index={i} />
        ))
      )}
      {canEdit && <AddRound ticketId={ticketId} onChanged={refresh} nextSeq={list.length + 1} />}
    </div>
  );
}

// ==== REQUESTS & UPDATES =========================================================================

function ItemRow({
  item,
  disabled,
  onConfirm,
}: {
  item: Checklist["items"][number];
  disabled: boolean;
  onConfirm: (on: boolean, detail?: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [detail, setDetail] = useState("");
  const done = !!item.confirmed_at;
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <Checkbox
        className="mt-0.5"
        checked={done}
        disabled={disabled}
        aria-label={item.label}
        onCheckedChange={(v) => {
          if (v === true && item.needs_detail) setAsking(true);
          else onConfirm(v === true);
        }}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("text-[14px]", done && "text-muted-foreground")}>
          {item.label}
          {!item.required && (
            <span className="ml-1.5 t-mono-label text-muted-foreground">optional</span>
          )}
        </p>
        {done && (
          <p className="t-data-sm text-muted-foreground" title={formatDateTime(item.confirmed_at)}>
            {item.confirmed_by_name} · {timeAgo(item.confirmed_at)}
            {item.detail && ` · ${item.detail}`}
          </p>
        )}
        {asking && (
          <form
            className="mt-1.5 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onConfirm(true, detail.trim());
              setAsking(false);
              setDetail("");
            }}
          >
            <Input
              autoFocus
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder={item.instruction || "Detail required"}
              aria-label={`Detail for ${item.label}`}
            />
            <Button type="submit" size="sm" disabled={!detail.trim()}>
              Confirm
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAsking(false)}
              aria-label="Cancel"
            >
              <X className="size-3.5" />
            </Button>
          </form>
        )}
      </div>
    </li>
  );
}

const STATUS_CHOICES: RequestStatus[] = ["open", "in_progress", "ready", "done", "declined"];

function RequestCard({
  c,
  ticketId,
  onChanged,
}: {
  c: RequestFull;
  ticketId: string;
  onChanged: () => void;
}) {
  const canManage = useCan("request.manage");
  const [pending, setPending] = useState<RequestStatus | null>(null);
  const [resolution, setResolution] = useState("");
  const confirm = useMutation({
    mutationFn: ({
      itemId,
      on,
      detail,
    }: {
      itemId: number;
      on: boolean;
      detail?: string | undefined;
    }) => confirmChecklistItem(ticketId, c.id, itemId, on, detail),
    onSuccess: onChanged,
  });
  const patch = useMutation({
    mutationFn: (b: {
      status?: RequestStatus;
      resolution?: string | null;
      owner_id?: string | null;
    }) => patchRequest(ticketId, c.id, b),
    onSuccess: () => {
      setPending(null);
      setResolution("");
      onChanged();
    },
  });
  const choose = (s: RequestStatus) => {
    if (s === "done" || s === "declined") setPending(s);
    else patch.mutate({ status: s });
  };
  const resolved = c.status === "done" || c.status === "declined";
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 px-[18px] pt-4">
        <div className="min-w-0">
          <h3 className="text-[16px] font-semibold leading-[22px]">{c.title}</h3>
          <p className="t-data-sm text-muted-foreground">
            {c.requested_by_name ?? "Unknown"} · {timeAgo(c.created_at)}
            {c.due_at && (
              <>
                {" · "}
                <Due at={c.due_at} open={!resolved} />
              </>
            )}
            {c.owner_name && ` · owner ${c.owner_name}`}
          </p>
        </div>
        <Chip tone={REQUEST_TONE[c.status]}>{label(c.status)}</Chip>
      </div>
      <CardBody className="mt-2 space-y-2">
        {c.slack_channel_id && (
          <p className="flex items-center gap-1.5 t-body-sm text-muted-foreground">
            <Hash className="size-3.5" />
            Updates go to {c.slack_channel_name ? `#${c.slack_channel_name}` : c.slack_channel_id}
            <span className="t-data-sm">({c.slack_channel_id})</span>
          </p>
        )}
        {c.detail && (
          <p className="whitespace-pre-wrap text-[14px] text-secondary-foreground">{c.detail}</p>
        )}
        <div className="flex items-center gap-3">
          <Bar
            className="flex-1"
            pct={c.progress.total ? (c.progress.done / c.progress.total) * 100 : 0}
            tone={c.progress.done === c.progress.total ? "good" : "info"}
          />
          <span className="t-data-sm">
            {c.progress.done}/{c.progress.total}
          </span>
        </div>
        <ul className="divide-y divide-border/60">
          {c.items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              disabled={!canManage || confirm.isPending}
              onConfirm={(on, detail) => confirm.mutate({ itemId: item.id, on, detail })}
            />
          ))}
        </ul>
        {c.resolution && (
          <p className="surface-inset px-3 py-2 t-body-sm">
            <MonoLabel className="mr-2">Resolution</MonoLabel>
            {c.resolution}
          </p>
        )}
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <OwnerSelect
              ticketId={ticketId}
              value={c.owner_id}
              disabled={patch.isPending}
              onPick={(owner_id) => patch.mutate({ owner_id })}
            />
            <Select
              aria-label="Request status"
              value={pending ?? c.status}
              disabled={patch.isPending}
              onChange={(e) => choose(e.target.value as RequestStatus)}
            >
              {STATUS_CHOICES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
            {pending && (
              <form
                className="flex min-w-48 flex-1 gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  patch.mutate({ status: pending, resolution: resolution.trim() || null });
                }}
              >
                <Input
                  autoFocus
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  placeholder={
                    pending === "declined" ? "Why is it declined?" : "How was it resolved?"
                  }
                  aria-label="Resolution"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={patch.isPending || (pending === "declined" && !resolution.trim())}
                >
                  Save
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setPending(null)}>
                  Cancel
                </Button>
              </form>
            )}
            {resolved && !pending && (
              <Button
                size="sm"
                variant="outline"
                disabled={patch.isPending}
                onClick={() => patch.mutate({ status: "open" })}
              >
                Reopen
              </Button>
            )}
          </div>
        )}
        <MutationError m={confirm} />
        <MutationError m={patch} />
      </CardBody>
    </Card>
  );
}

type ChannelCheck = { state: "idle" | "loading" | "ok" | "error"; text: string };

/** A Slack channel ID with a live preview of the channel it points to, so nothing is saved against a wrong one. */
function SlackChannelField({
  ticketId,
  value,
  onChange,
  onCheck,
}: {
  ticketId: string;
  value: string;
  onChange: (v: string) => void;
  onCheck: (c: ChannelCheck) => void;
}) {
  const [check, setCheck] = useState<ChannelCheck>({ state: "idle", text: "" });
  useEffect(() => {
    const id = value.trim();
    const next = (c: ChannelCheck) => {
      setCheck(c);
      onCheck(c);
    };
    if (!id) return next({ state: "idle", text: "" });
    next({ state: "loading", text: "" });
    let stale = false;
    const t = setTimeout(() => {
      lookupSlackChannel(ticketId, id)
        .then((r) => !stale && next({ state: "ok", text: `#${r.channel_name}` }))
        .catch((e) => !stale && next({ state: "error", text: errorText(e) }));
    }, 400);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // onCheck is a state setter from the parent; the lookup must only rerun when the id changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, ticketId]);
  return (
    <Field label="Slack channel ID (optional)">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="C0123456789"
        className="font-mono"
        aria-describedby="slack-channel-preview"
      />
      <p
        id="slack-channel-preview"
        aria-live="polite"
        className={cn(
          "mt-1 min-h-5 t-body-sm",
          check.state === "error" ? "text-status-critical" : "text-muted-foreground",
        )}
      >
        {check.state === "loading" && "Looking up the channel…"}
        {check.state === "ok" && `Posts to ${check.text}`}
        {check.state === "error" && check.text}
        {check.state === "idle" &&
          "Updates for this request are posted there. Leave empty for none."}
      </p>
    </Field>
  );
}

function RaiseRequest({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const { data: templates = [] } = useQuery(requestTemplatesQuery);
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [detail, setDetail] = useState("");
  const [due, setDue] = useState("");
  const [channel, setChannel] = useState("");
  const [channelCheck, setChannelCheck] = useState<ChannelCheck>({ state: "idle", text: "" });
  const raise = useMutation({
    mutationFn: () =>
      raiseRequest(ticketId, {
        template_id: Number(templateId),
        detail: detail.trim() || null,
        due_at: due ? `${due}T00:00:00` : null,
        slack_channel_id: channel.trim() || null,
      }),
    onSuccess: () => {
      setTemplateId("");
      setDetail("");
      setDue("");
      setChannel("");
      setOpen(false);
      onChanged();
    },
  });
  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> Raise request
      </Button>
    );
  return (
    <Card>
      <CardHeader title="Raise a special request" divided />
      <form
        className="space-y-3 p-[18px]"
        onSubmit={(e) => {
          e.preventDefault();
          raise.mutate();
        }}
      >
        <div className="grid gap-2.5 sm:grid-cols-[1fr_150px]">
          <Field label="Request type">
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
              <option value="">Choose…</option>
              {templates
                .filter((t) => t.active)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Due">
            <Input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
        <Field label="Detail">
          <Textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={2}
            placeholder="What does the client need?"
          />
        </Field>
        <SlackChannelField
          ticketId={ticketId}
          value={channel}
          onChange={setChannel}
          onCheck={setChannelCheck}
        />
        <div className="flex items-center gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={
              !templateId ||
              raise.isPending ||
              (channel.trim() !== "" && channelCheck.state !== "ok")
            }
          >
            Raise request
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <MutationError m={raise} />
        </div>
      </form>
    </Card>
  );
}

function Composer({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const canPost = useCan("update.post");
  const canComment = useCan("comment.add");
  const [health, setHealth] = useState<Health | null>(null);
  const [summary, setSummary] = useDraft(`${ticketId}:summary`);
  const [blockers, setBlockers] = useDraft(`${ticketId}:blockers`);
  const [comment, setComment] = useDraft(`${ticketId}:comment`);
  const feed = useInfiniteQuery(updatesFeedQuery(ticketId));
  const last = feed.data?.pages.flatMap((pg) => pg.items).find((u) => u.health);
  const post = useMutation({
    mutationFn: () =>
      postUpdate(ticketId, {
        health: health ?? "good",
        summary: summary.trim(),
        blockers: blockers.trim() || null,
      }),
    onSuccess: () => {
      setSummary("");
      setBlockers("");
      setHealth(null);
      toast.success("Update posted");
      onChanged();
    },
  });
  const talk = useMutation({
    mutationFn: () => postComment(ticketId, comment.trim()),
    onSuccess: () => {
      setComment("");
      toast.success("Comment added");
      onChanged();
    },
  });
  if (!canPost && !canComment) return null;
  return (
    <Card>
      {canPost && (
        <>
          <CardHeader title="Post update" meta="Goes to the program's Slack channel" divided />
          <form
            className="space-y-3 p-[18px]"
            onSubmit={(e) => {
              e.preventDefault();
              post.mutate();
            }}
          >
            <p className="t-body-sm text-muted-foreground">
              {last ? (
                <>
                  Last update {timeAgo(last.created_at)} · health{" "}
                  <HealthPill health={last.health as Health} />
                </>
              ) : (
                "No update posted yet."
              )}
            </p>
            <div role="radiogroup" aria-label="Health" className="flex items-center gap-1.5">
              <MonoLabel className="mr-1">How is it going?</MonoLabel>
              {(["good", "warning", "critical"] as const).map((h) => (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={health === h}
                  onClick={() => setHealth(h)}
                  className={cn(
                    "chip h-7 cursor-pointer px-3 outline-none ring-offset-2 ring-offset-card focus-visible:ring-2 focus-visible:ring-primary",
                    health === h && "ring-1 ring-current",
                  )}
                  data-tone={health === h ? HEALTH_TONE[h] : "neutral"}
                >
                  {HEALTH_NAMES[h]}
                </button>
              ))}
            </div>
            <Field label="Summary">
              <Textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={3}
                placeholder="What happened today?"
              />
            </Field>
            <Field label="Blockers">
              <Input
                value={blockers}
                onChange={(e) => setBlockers(e.target.value)}
                placeholder="Optional"
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={!summary.trim() || !health || post.isPending}
              >
                Post update
              </Button>
              {!health && summary.trim() && (
                <span className="t-body-sm text-muted-foreground">Choose a health first.</span>
              )}
              <MutationError m={post} />
            </div>
          </form>
        </>
      )}
      {canComment && (
        <form
          className={cn("flex items-start gap-2 p-[18px]", canPost && "border-t border-border")}
          onSubmit={(e) => {
            e.preventDefault();
            talk.mutate();
          }}
        >
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder="Add a comment"
            aria-label="Comment"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!comment.trim() || talk.isPending}
          >
            Comment
          </Button>
        </form>
      )}
      {talk.isError && (
        <div className="px-[18px] pb-3">
          <MutationError m={talk} />
        </div>
      )}
    </Card>
  );
}

function Feed({ ticketId }: { ticketId: string }) {
  const q = useInfiniteQuery(updatesFeedQuery(ticketId));
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader title="Updates and comments" divided />
      {q.isLoading ? (
        <div className="p-[18px]">
          <ListSkeleton rows={2} />
        </div>
      ) : q.isError ? (
        <div className="p-[18px]">
          <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : items.length === 0 ? (
        <div className="p-[18px]">
          <EmptyState
            title="Nothing posted yet"
            hint="Daily updates and comments will appear here."
          />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((u) => (
            <li key={u.note_id} className="px-[18px] py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Avatar name={u.author_name} />
                <span className="text-[14px] font-medium">{u.author_name ?? "Unknown"}</span>
                <Chip>{titleCase(u.kind)}</Chip>
                {u.health && <HealthPill health={u.health} />}
                <span
                  className="ml-auto t-data-sm text-muted-foreground"
                  title={formatDateTime(u.created_at)}
                >
                  {u.source !== "programops" && `${u.source} · `}
                  {timeAgo(u.created_at)}
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-[14px]">{u.body}</p>
              {u.blockers && (
                <p className="mt-1 t-body-sm text-status-critical">
                  <span className="t-mono-label mr-1.5">Blockers</span>
                  {u.blockers}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <div className="border-t border-border p-3 text-center">
          <Button
            size="sm"
            variant="ghost"
            disabled={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {q.isFetchingNextPage ? "Loading…" : "Load older"}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---- dependencies / communications / timeline changes ---------------------------------------------

function MiniCard({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader title={title} meta={meta} divided />
      {children}
    </Card>
  );
}

function AddRow({
  label: l,
  children,
  canAdd,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
  canAdd: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!canAdd) return null;
  return (
    <div className="mt-auto border-t border-border p-3">
      {open ? (
        children(() => setOpen(false))
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          <Plus className="size-3.5" /> {l}
        </Button>
      )}
    </div>
  );
}

function ListState({
  q,
  empty,
}: {
  q: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  empty: string | false;
}) {
  if (q.isLoading)
    return (
      <div className="p-3">
        <Skeleton className="h-16 w-full" />
      </div>
    );
  if (q.isError)
    return (
      <div className="p-3">
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  return empty ? <p className="px-[18px] py-4 t-body-sm text-muted-foreground">{empty}</p> : null;
}

function Dependencies({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const canManage = useCan("request.manage");
  const q = useQuery(dependenciesQuery(ticketId));
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  const add = useMutation({
    mutationFn: () =>
      addDependency(ticketId, {
        title: title.trim(),
        client_owner: owner.trim() || null,
        due_on: due || null,
      }),
    onSuccess: () => {
      setTitle("");
      setOwner("");
      setDue("");
      onChanged();
    },
  });
  const set = useMutation({
    mutationFn: (b: { id: number; status?: Dependency["status"]; owner_id?: string | null }) =>
      patchDependency(ticketId, b.id, {
        ...(b.status ? { status: b.status } : {}),
        ...(b.owner_id !== undefined ? { owner_id: b.owner_id } : {}),
      }),
    onSuccess: (_, v) => {
      onChanged();
      if (v.status && v.status !== "open")
        undoable(`Marked ${v.status}`, () => set.mutate({ id: v.id, status: "open" }));
    },
  });
  const items = q.data?.items ?? [];
  const impact = q.data?.impact;
  return (
    <MiniCard
      title="Client dependencies"
      meta={
        impact &&
        (impact.open
          ? `${impact.open} open${impact.overdue ? ` · ${impact.overdue} overdue` : ""}`
          : "none open")
      }
    >
      <ListState q={q} empty={!items.length && "Nothing is waiting on the client."} />
      <ul className="divide-y divide-border/60">
        {items.map((d) => (
          <li key={d.id} className="px-[18px] py-2.5">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[14px] font-medium">{d.title}</p>
              <Chip
                tone={
                  d.status === "open"
                    ? d.overdue
                      ? "critical"
                      : "warning"
                    : d.status === "received"
                      ? "good"
                      : "neutral"
                }
              >
                {d.status === "open" && d.overdue ? `${d.delay_days}d late` : titleCase(d.status)}
              </Chip>
            </div>
            <p className="t-data-sm text-muted-foreground">
              {titleCase(d.kind)}
              {d.client_owner && ` · client: ${d.client_owner}`}
              {d.owner_name && ` · ours: ${d.owner_name}`}
              {d.due_on && (
                <>
                  {" · "}
                  <Due at={d.due_on} open={d.status === "open"} />
                </>
              )}
            </p>
            {canManage && d.status === "open" && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <OwnerSelect
                  ticketId={ticketId}
                  value={d.owner_id}
                  disabled={set.isPending}
                  onPick={(owner_id) => set.mutate({ id: d.id, owner_id })}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={set.isPending}
                  onClick={() => set.mutate({ id: d.id, status: "received" })}
                >
                  Received
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={set.isPending}
                  onClick={() => set.mutate({ id: d.id, status: "waived" })}
                >
                  Waive
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <MutationError m={set} />
      <AddRow label="Add dependency" canAdd={canManage}>
        {(close) => (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate(undefined, { onSuccess: close });
            }}
          >
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What do we need?"
              aria-label="Dependency"
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="Client owner"
                aria-label="Client owner"
              />
              <Input
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                aria-label="Due"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={!title.trim() || add.isPending}>
                Add
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <MutationError m={add} />
            </div>
          </form>
        )}
      </AddRow>
    </MiniCard>
  );
}

const COMM_KINDS: CommKind[] = [
  "invitation",
  "reminder",
  "shortlist",
  "rsvp",
  "announcement",
  "other",
];

function Communications({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const canManage = useCan("request.manage");
  const q = useQuery(communicationsQuery(ticketId));
  const [kind, setKind] = useState<CommKind>("reminder");
  const [audience, setAudience] = useState("");
  const [when, setWhen] = useState("");
  const [recipients, setRecipients] = useState("");
  const add = useMutation({
    mutationFn: () =>
      planCommunication(ticketId, {
        kind,
        audience: audience.trim(),
        planned_for: new Date(when).toISOString(),
        recipients: recipients === "" ? null : Number(recipients),
      }),
    onSuccess: () => {
      setAudience("");
      setWhen("");
      setRecipients("");
      onChanged();
    },
  });
  const set = useMutation({
    mutationFn: ({ id, status }: { id: number; status: Comm["status"] }) =>
      patchCommunication(ticketId, id, { status }),
    onSuccess: (_, v) => {
      onChanged();
      if (v.status !== "planned")
        undoable(`Marked ${v.status}`, () => set.mutate({ id: v.id, status: "planned" }));
    },
  });
  const items = q.data ?? [];
  return (
    <MiniCard
      title="Participant communications"
      meta={
        items.length ? `${items.filter((c) => c.status === "planned").length} planned` : undefined
      }
    >
      <ListState q={q} empty={!items.length && "No communications planned."} />
      <ul className="divide-y divide-border/60">
        {items.map((c) => (
          <li key={c.id} className="px-[18px] py-2.5">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[14px] font-medium">
                <span className="capitalize">{c.kind}</span> to {c.audience}
              </p>
              <Chip
                tone={
                  c.status === "sent"
                    ? "good"
                    : c.overdue
                      ? "critical"
                      : c.status === "skipped"
                        ? "neutral"
                        : "info"
                }
              >
                {c.overdue && c.status === "planned" ? "Overdue" : titleCase(c.status)}
              </Chip>
            </div>
            <p className="t-data-sm text-muted-foreground">
              {c.status === "sent"
                ? `sent ${formatDateTime(c.sent_at)}`
                : `planned ${formatDateTime(c.planned_for)}`}
              {c.recipients != null && ` · ${n(c.recipients)} recipients`}
            </p>
            {canManage && c.status === "planned" && (
              <div className="mt-1 flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={set.isPending}
                  onClick={() => set.mutate({ id: c.id, status: "sent" })}
                >
                  Mark sent
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={set.isPending}
                  onClick={() => set.mutate({ id: c.id, status: "skipped" })}
                >
                  Skip
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <MutationError m={set} />
      <AddRow label="Plan communication" canAdd={canManage}>
        {(close) => (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate(undefined, { onSuccess: close });
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <Select
                value={kind}
                onChange={(e) => setKind(e.target.value as CommKind)}
                aria-label="Kind"
              >
                {COMM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {titleCase(k)}
                  </option>
                ))}
              </Select>
              <Input
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="Audience"
                aria-label="Audience"
              />
              <Input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                aria-label="Planned for"
              />
              <Input
                type="number"
                min={0}
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                placeholder="Recipients"
                aria-label="Recipients"
                className="font-mono"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={!audience.trim() || !when || add.isPending}>
                Plan
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <MutationError m={add} />
            </div>
          </form>
        )}
      </AddRow>
    </MiniCard>
  );
}

const CHANGE_TONE = { proposed: "warning", approved: "good", rejected: "serious" } as const;
const FIELDS_FOR: Record<SubjectType, string[]> = {
  round: ["starts_on", "ends_on"],
  activity: ["planned_date"],
};

function ChangeRow({
  ch,
  ticketId,
  onChanged,
}: {
  ch: TimelineChange;
  ticketId: string;
  onChanged: () => void;
}) {
  const canManage = useCan("request.manage");
  const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null);
  const decide = useMutation({
    mutationFn: (d: "approve" | "reject") => decideChange(ticketId, ch.id, d),
    onSuccess: () => {
      setDeciding(null);
      onChanged();
    },
  });
  const task = useMutation({
    mutationFn: ({ id, done }: { id: number; done: boolean }) =>
      setChangeTask(ticketId, ch.id, id, done),
    onSuccess: onChanged,
  });
  return (
    <li className="px-[18px] py-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[14px] font-medium">
          {ch.subject_type === "activity" ? (
            <Link
              to="/programs/$ticketId"
              params={{ ticketId }}
              search={{ tab: "marketing" }}
              hash={`a=${ch.subject_id}`}
              className="hover:underline"
            >
              {ch.label}
            </Link>
          ) : (
            ch.label
          )}
        </p>
        <Chip tone={CHANGE_TONE[ch.status]}>{titleCase(ch.status)}</Chip>
      </div>
      <p className="t-data-sm">
        <span className="text-muted-foreground">{ch.field}</span>{" "}
        {ch.original ? formatDate(ch.original) : "–"} → {formatDate(ch.revised)}
      </p>
      <p className="t-body-sm text-secondary-foreground">{ch.reason}</p>
      <p className="t-data-sm text-muted-foreground" title={formatDateTime(ch.created_at)}>
        {ch.proposed_by_name} · {timeAgo(ch.created_at)}
        {ch.decided_by_name && ` · ${ch.status} by ${ch.decided_by_name}`}
      </p>
      {ch.status === "approved" && ch.tasks.length > 0 && (
        <ul className="mt-1">
          {ch.tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-2 py-0.5">
              <Checkbox
                checked={t.done}
                disabled={!canManage || task.isPending}
                aria-label={t.label}
                onCheckedChange={(v) => task.mutate({ id: t.id, done: v === true })}
              />
              <span className={cn("t-body-sm", t.done && "text-muted-foreground line-through")}>
                {t.label}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canManage && ch.status === "proposed" && !deciding && (
        <div className="mt-1 flex gap-1.5">
          <Button size="sm" variant="success" onClick={() => setDeciding("approve")}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeciding("reject")}>
            Reject
          </Button>
        </div>
      )}
      {deciding && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="t-body-sm text-secondary-foreground">
            {deciding === "approve"
              ? "Approve this change? Follow-up tasks are created and the date is updated."
              : "Reject this change? It can't be reopened."}
          </span>
          <Button
            size="sm"
            variant={deciding === "approve" ? "success" : "danger"}
            disabled={decide.isPending}
            onClick={() => decide.mutate(deciding)}
          >
            Confirm {deciding}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeciding(null)}>
            Cancel
          </Button>
        </div>
      )}
      <MutationError m={decide} />
      <MutationError m={task} />
    </li>
  );
}

function TimelineChanges({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const canPropose = useCan("request.create");
  const q = useQuery(timelineChangesQuery(ticketId));
  const rounds = useQuery(roundsQuery(ticketId));
  const acts = useQuery(activitiesQuery(ticketId));
  const [type, setType] = useState<SubjectType>("round");
  const [subject, setSubject] = useState("");
  const [field, setField] = useState("");
  const [revised, setRevised] = useState("");
  const [reason, setReason] = useState("");
  const subjects: { id: string; name: string }[] =
    type === "round"
      ? (rounds.data ?? []).map((r) => ({ id: String(r.id), name: r.name }))
      : (acts.data ?? []).map((a) => ({ id: String(a.id), name: `${a.code} · ${a.title}` }));
  const add = useMutation({
    mutationFn: () =>
      proposeChange(ticketId, {
        subject_type: type,
        subject_id: subject,
        field: field || (FIELDS_FOR[type][0] ?? ""),
        revised,
        reason: reason.trim(),
      }),
    onSuccess: () => {
      setSubject("");
      setRevised("");
      setReason("");
      onChanged();
    },
  });
  const items = q.data ?? [];
  return (
    <MiniCard
      title="Timeline changes"
      meta={
        items.some((c) => c.status === "proposed")
          ? `${items.filter((c) => c.status === "proposed").length} awaiting approval`
          : undefined
      }
    >
      <ListState q={q} empty={!items.length && "No timeline changes proposed."} />
      <ul className="divide-y divide-border/60">
        {items.map((c) => (
          <ChangeRow key={c.id} ch={c} ticketId={ticketId} onChanged={onChanged} />
        ))}
      </ul>
      <AddRow label="Propose change" canAdd={canPropose}>
        {(close) => (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate(undefined, { onSuccess: close });
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <Select
                value={type}
                aria-label="Subject type"
                onChange={(e) => {
                  setType(e.target.value as SubjectType);
                  setSubject("");
                  setField("");
                }}
              >
                <option value="round">Round</option>
                <option value="activity">Activity</option>
              </Select>
              <Select
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                aria-label="Subject"
              >
                <option value="">Choose…</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <Select
                value={field || FIELDS_FOR[type][0]}
                onChange={(e) => setField(e.target.value)}
                aria-label="Field"
              >
                {FIELDS_FOR[type].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
              <Input
                type="date"
                value={revised}
                onChange={(e) => setRevised(e.target.value)}
                aria-label="New date"
              />
            </div>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is it moving?"
              aria-label="Reason"
            />
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={!subject || !revised || !reason.trim() || add.isPending}
              >
                Propose
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <MutationError m={add} />
            </div>
          </form>
        )}
      </AddRow>
    </MiniCard>
  );
}

type OpsSection = "requests" | "blockers";
const OPS_SECTIONS: { id: OpsSection; label: string }[] = [
  { id: "requests", label: "Special requests" },
  { id: "blockers", label: "Dependencies & changes" },
];

export function ProgramRequests({ ticketId }: { ticketId: string }) {
  const refresh = useRefresh(ticketId);
  const requests = useQuery(requestsFullQuery(ticketId));
  const canRaise = useCan("request.create");
  const [section, setSection] = useState<OpsSection>("requests");
  const deps = useQuery(dependenciesQuery(ticketId)).data;
  const changes = useQuery(timelineChangesQuery(ticketId)).data;
  const comms = useQuery(communicationsQuery(ticketId)).data;
  const feed = useInfiniteQuery(updatesFeedQuery(ticketId));
  const lastUpdate = feed.data?.pages.flatMap((pg) => pg.items).find((u) => u.health);
  const isOpen = (c: RequestFull) => c.status !== "done" && c.status !== "declined";
  const open = (requests.data?.filter(isOpen) ?? []).sort((a, b) =>
    (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"),
  );
  const overdueRequests = open.filter((c) => isPast(c.due_at)).length;
  const proposed = changes?.filter((c) => c.status === "proposed").length ?? 0;
  const lateComms = comms?.filter((c) => c.overdue && c.status === "planned").length ?? 0;
  const attention = (deps?.impact.overdue ?? 0) + proposed + lateComms;
  const resolved = requests.data?.filter((c) => !isOpen(c)) ?? [];
  const card = (c: RequestFull) => (
    <RequestCard key={c.id} c={c} ticketId={ticketId} onChanged={refresh} />
  );
  return (
    <div className="space-y-4 page-in">
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Composer ticketId={ticketId} onChanged={refresh} />
        <Feed ticketId={ticketId} />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <Kpi
          label="Last update"
          value={lastUpdate ? timeAgo(lastUpdate.created_at) : "None yet"}
          sub={
            lastUpdate ? <HealthPill health={lastUpdate.health as Health} /> : "Post the first one"
          }
          index={0}
        />
        <Kpi
          label="Open requests"
          value={open.length}
          tone={overdueRequests ? "critical" : undefined}
          sub={overdueRequests ? `${overdueRequests} overdue` : "none overdue"}
          index={1}
        />
        <Kpi
          label="Client dependencies"
          value={deps?.impact.open ?? "–"}
          tone={deps?.impact.overdue ? "critical" : undefined}
          sub={deps?.impact.overdue ? `${deps.impact.overdue} overdue` : "none overdue"}
          index={2}
        />
        <Kpi
          label="Changes to decide"
          value={proposed}
          tone={proposed ? "warning" : undefined}
          sub={lateComms ? `${lateComms} overdue comms` : "timeline changes"}
          index={3}
        />
      </div>
      <div className="overflow-x-auto pb-1">
        <Segmented
          value={section}
          onChange={setSection}
          options={OPS_SECTIONS.map((o) => ({
            ...o,
            ...(o.id === "requests" && open.length ? { count: open.length } : {}),
            ...(o.id === "blockers" && attention ? { count: attention } : {}),
          }))}
        />
      </div>
      {section === "requests" && (
        <div className="max-w-3xl space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-[16px] font-semibold">Special requests</h2>
              <p className="t-body-sm text-muted-foreground">
                Anything the client or team asks for beyond the plan. Each one has a checklist to
                tick off until it is done.
              </p>
            </div>
            {requests.data && (
              <span className="t-data-sm text-muted-foreground">{open.length} open</span>
            )}
          </div>
          {canRaise && <RaiseRequest ticketId={ticketId} onChanged={refresh} />}
          {requests.isLoading ? (
            <ListSkeleton rows={2} />
          ) : requests.isError ? (
            <ErrorBox error={requests.error} onRetry={() => void requests.refetch()} />
          ) : requests.data?.length ? (
            <>
              {open.map(card)}
              {resolved.length > 0 && (
                <details className="space-y-4">
                  <summary className="cursor-pointer t-body-sm text-muted-foreground">
                    {resolved.length} resolved
                  </summary>
                  <div className="mt-4 space-y-4">{resolved.map(card)}</div>
                </details>
              )}
            </>
          ) : (
            <EmptyState
              title="No requests raised"
              hint="Special asks from the client or team show up here with a confirmation checklist."
            />
          )}
        </div>
      )}
      {section === "blockers" && (
        <div className="grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          <Dependencies ticketId={ticketId} onChanged={refresh} />
          <Communications ticketId={ticketId} onChanged={refresh} />
          <TimelineChanges ticketId={ticketId} onChanged={refresh} />
        </div>
      )}
    </div>
  );
}

// ==== ACTIVITY LOG ===============================================================================

const ENTITY_LABEL: Record<string, string> = {
  activity: "activity",
  round: "round",
  rounds: "rounds",
  round_counts: "round counts",
  checklist: "checklist",
  phase: "phase",
  dependency: "dependency",
  communication: "communication",
  timeline_change: "timeline change",
  update: "update",
  comment: "comment",
  note: "note",
  plan: "marketing plan",
  registrations: "registrations",
  registration_config: "registration settings",
  registration_targets: "registration targets",
  relevant_registrations: "relevant registrations",
  activity_metrics: "activity results",
  assignments: "assignments",
  redash_link: "Redash link",
  slack_link: "Slack link",
};
const entityName = (e: string) => ENTITY_LABEL[e] ?? label(e);

export function ProgramActivityLog({ ticketId }: { ticketId: string }) {
  const [entity, setEntity] = useState<string>("all");
  const q = useInfiniteQuery(auditFeedQuery(ticketId, entity === "all" ? null : entity));
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-3 page-in">
      <div className="overflow-x-auto pb-1">
        <Segmented
          value={entity}
          onChange={setEntity}
          options={[
            { id: "all", label: "All" },
            ...AUDIT_ENTITIES.map((a) => ({ id: a as string, label: entityName(a) })),
          ]}
        />
      </div>
      <Card>
        {q.isLoading ? (
          <div className="p-[18px]">
            <ListSkeleton rows={4} />
          </div>
        ) : q.isError ? (
          <div className="p-[18px]">
            <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="p-[18px]">
            <EmptyState
              title="Nothing recorded yet"
              hint={
                entity === "all"
                  ? "Changes to this program will be listed here."
                  : "No events for this filter."
              }
            />
          </div>
        ) : (
          <LogList events={items} sentence={logSentence} />
        )}
        {q.hasNextPage && (
          <div className="border-t border-border p-3 text-center">
            <Button
              size="sm"
              variant="ghost"
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {q.isFetchingNextPage ? "Loading…" : "Load older"}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
