import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { AlertTriangle, Hash, MoreHorizontal, Plus, RefreshCw, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
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
  KpiCell,
  KpiStrip,
  MonoLabel,
  Num,
  Segmented,
  Skeleton,
  type Tone,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { lookupSlackChannel, registrationsQueryOptions, useCan } from "@/lib/api";
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
import { groupLog, logSentence, splitList } from "@/lib/history";
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
    <div className="relative overflow-x-auto">
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

const dash = <span className="text-ink-3">–</span>;
const cellN = (v: number | null | undefined) => (v == null ? dash : n(v));
const sub = (v: number | null | undefined, text: string) =>
  v == null ? null : (
    <span className="block text-[12px] font-normal text-ink-2">{`${v}% ${text}`}</span>
  );

type RoundPanel = "history" | "edit" | "enter" | "round" | "delete";

/** One funnel row per round (counts with their percentages) plus an expandable panel for forms and history. */
function RoundRows({
  round,
  step,
  ticketId,
  onChanged,
}: {
  round: RoundFull;
  step: FunnelStep | undefined;
  ticketId: string;
  onChanged: () => void;
}) {
  const canEnter = useCan("counts.enter");
  const canEdit = useCan("rounds.edit");
  const [open, setOpen] = useState<RoundPanel | null>(null);
  const toggle = (p: RoundPanel) => setOpen(open === p ? null : p);
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
  const dropOff = step?.drop_off;
  return (
    <>
      <tr className="border-t border-border align-top">
        <td className="px-4 py-3">
          <p className="text-[14px] font-medium">
            <span className="mr-1.5 text-[13px] text-ink-2">{round.seq}</span>
            {round.name}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip>{titleCase(round.kind)}</Chip>
            {round.source === "sow" && <Chip>From SOW</Chip>}
          </div>
          {missing && (
            <p className="mt-1 text-[13px] text-warn">
              Counts missing: this round has ended and nothing has been recorded.
            </p>
          )}
          {c && (
            <p className="mt-1 text-[12px] text-ink-2" title={formatDateTime(c.entered_at)}>
              as of {formatDate(c.as_of)} · {c.entered_by_name}
            </p>
          )}
        </td>
        <td className="px-3 py-3">
          <Chip tone={ROUND_TONE[round.status]}>{titleCase(round.status)}</Chip>
        </td>
        <td className="px-3 py-3 text-right tabular-nums">
          {cellN(c?.invited)}
          {c?.invited ? sub(100, "of invited") : null}
        </td>
        <td className="px-3 py-3 text-right tabular-nums">
          {cellN(c?.attempted)}
          {sub(step?.participation_pct, "took part")}
        </td>
        <td className="px-3 py-3 text-right tabular-nums">
          {cellN(c?.cleared)}
          {sub(step?.clearance_pct, "cleared")}
        </td>
        <td className="px-3 py-3 text-right tabular-nums">
          {cellN(c?.shortlisted)}
          {sub(step?.shortlist_pct, "shortlisted")}
        </td>
        <td className="px-3 py-3 text-right tabular-nums">
          {dropOff == null ? dash : dropOff > 0 ? `−${n(dropOff)}` : n(dropOff)}
          {dropOff != null && (
            <span className="block text-[12px] text-ink-2">invited, not attempted</span>
          )}
        </td>
        <td className="px-4 py-2.5">
          <div className="flex items-center justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open === "history"}
              onClick={() => toggle("history")}
            >
              Counts history
            </Button>
            {canEnter && (
              <Button
                size="sm"
                variant="outline"
                aria-expanded={open === (c ? "edit" : "enter")}
                onClick={() => toggle(c ? "edit" : "enter")}
              >
                {c ? "Edit counts" : "Enter counts"}
              </Button>
            )}
            {(canEnter || canEdit) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" aria-label={`More actions for ${round.name}`}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canEnter && c && (
                    <DropdownMenuItem onSelect={() => setOpen("enter")}>
                      Add a new date
                    </DropdownMenuItem>
                  )}
                  {canEdit && (
                    <>
                      <DropdownMenuItem onSelect={() => setOpen("round")}>
                        Edit round
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Status</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={round.status}
                        onValueChange={(v) => setStatus.mutate(v as RoundStatus)}
                      >
                        {ROUND_STATUSES.map((s) => (
                          <DropdownMenuRadioItem key={s} value={s}>
                            {titleCase(s)}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-danger" onSelect={() => setOpen("delete")}>
                        Delete round
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </td>
      </tr>
      {(open || setStatus.isError || remove.isError) && (
        <tr>
          <td colSpan={8} className="px-4 pb-3">
            <div className="space-y-2">
              {open === "history" && (
                <CountsHistory ticketId={ticketId} round={round} onChanged={onChanged} />
              )}
              {open === "edit" && c && (
                <>
                  <p className="text-[13px] text-ink-2">
                    Editing the counts as of {formatDate(c.as_of)}. The earlier values stay in the
                    counts history.
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
                </>
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
              {open === "round" && (
                <EditRound
                  ticketId={ticketId}
                  round={round}
                  onDone={() => {
                    setOpen(null);
                    onChanged();
                  }}
                  onCancel={() => setOpen(null)}
                />
              )}
              {open === "delete" && (
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span>Delete {round.name}? Its counts history goes with it.</span>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    Delete round
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                    Keep
                  </Button>
                </div>
              )}
              <MutationError m={setStatus} />
              <MutationError m={remove} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** The funnel as one table, with one-hue bars under it for each round that has counts. */
function RoundsTable({
  rounds,
  steps,
  ticketId,
  onChanged,
}: {
  rounds: RoundFull[];
  steps: FunnelStep[];
  ticketId: string;
  onChanged: () => void;
}) {
  const withCounts = rounds.filter((r) => r.latest_counts);
  return (
    <Card aria-label="Round funnel">
      <CardHeader title="Round funnel" meta="Share of invited" />
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[920px] border-collapse text-[14px]">
          <thead>
            <tr className="text-left">
              <th className="t-th px-4 pb-2 font-medium">Round</th>
              <th className="t-th px-3 pb-2 font-medium">Status</th>
              <th className="t-th px-3 pb-2 text-right font-medium">Invited</th>
              <th className="t-th px-3 pb-2 text-right font-medium">Attempted</th>
              <th className="t-th px-3 pb-2 text-right font-medium">Cleared</th>
              <th className="t-th px-3 pb-2 text-right font-medium">Shortlisted</th>
              <th className="t-th px-3 pb-2 text-right font-medium">Drop-off</th>
              <th className="px-4 pb-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((r) => (
              <RoundRows
                key={r.id}
                round={r}
                step={steps.find((s) => s.round_id === r.id)}
                ticketId={ticketId}
                onChanged={onChanged}
              />
            ))}
          </tbody>
        </table>
      </div>
      {withCounts.length > 0 && (
        <div className="space-y-4 border-t border-border p-4">
          {withCounts.map((r) => {
            const c = r.latest_counts!;
            const rows = [
              ["Invited", c.invited],
              ["Attempted", c.attempted],
              ["Cleared", c.cleared],
              ["Shortlisted", c.shortlisted],
            ] as const;
            const base = Math.max(...rows.map(([, v]) => v ?? 0), 0);
            return (
              <div key={r.id} className="space-y-1.5">
                {withCounts.length > 1 && <p className="text-[13px] font-medium">{r.name}</p>}
                <div
                  role="img"
                  aria-label={`Funnel for ${r.name}: ${rows.map(([l, v]) => `${v == null ? "no figure" : n(v)} ${l.toLowerCase()}`).join(", ")}`}
                  className="grid gap-1.5"
                >
                  {rows.map(([l, v]) => (
                    <div key={l} className="flex items-center gap-3 text-[13px]">
                      <span className="w-24 shrink-0 text-ink-2">{l}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-raised">
                        <div
                          className="h-2 rounded-full"
                          style={{
                            width: `${v == null || !base ? 0 : (v / base) * 100}%`,
                            background: "var(--chart-1)",
                          }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right tabular-nums">{cellN(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** The SOW's stages as a stepper: status and dates, "Date TBC" until they are set. */
function DeliveryStages({
  rounds,
  suggested,
  ticketId,
  onChanged,
}: {
  rounds: RoundFull[];
  suggested: { name: string; notes: string }[];
  ticketId: string;
  onChanged: () => void;
}) {
  const canEdit = useCan("rounds.edit");
  const [setting, setSetting] = useState(false);
  const sow = rounds.filter((r) => r.source === "sow");
  const stages = [
    ...sow.map((r) => ({
      key: `r${r.id}`,
      name: r.name,
      status: r.status as RoundStatus | null,
      dates:
        r.starts_on || r.ends_on ? `${formatDate(r.starts_on)} – ${formatDate(r.ends_on)}` : null,
    })),
    ...suggested.map((s) => ({ key: `s${s.name}`, name: s.name, status: null, dates: null })),
  ];
  const undated = sow.find((r) => !r.starts_on || !r.ends_on);
  if (stages.length === 0) return null;
  return (
    <Card aria-label="Delivery stages">
      <CardHeader
        title="Delivery stages"
        meta={
          <>
            <span>From the SOW{undated || suggested.length ? " · dates are not set yet" : ""}</span>
            {canEdit && undated && (
              <Button size="sm" variant="outline" onClick={() => setSetting((v) => !v)}>
                Set dates
              </Button>
            )}
          </>
        }
      />
      <CardBody className="space-y-4">
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stages.map((s) => (
            <li key={s.key} className="min-w-0">
              <div className="mb-2 h-1 overflow-hidden rounded-full bg-border">
                <div
                  className={cn(
                    "h-1 rounded-full",
                    s.status === "done"
                      ? "bg-ink-2"
                      : s.status === "live" || s.status === "evaluating"
                        ? "bg-primary"
                        : "w-0",
                  )}
                  style={s.status && s.status !== "planned" ? { width: "100%" } : undefined}
                />
              </div>
              <p className="text-[13px] font-medium">{s.name}</p>
              <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-2">
                {s.status && s.status !== "planned" ? (
                  <Chip tone={ROUND_TONE[s.status]}>{titleCase(s.status)}</Chip>
                ) : (
                  <span>Not started</span>
                )}
                <span>{s.dates ?? "Date TBC"}</span>
              </p>
            </li>
          ))}
        </ol>
        {setting && undated && (
          <div className="space-y-1.5">
            <p className="text-[13px] text-ink-2">Dates for {undated.name}.</p>
            <EditRound
              ticketId={ticketId}
              round={undated}
              onDone={() => {
                setSetting(false);
                onChanged();
              }}
              onCancel={() => setSetting(false)}
            />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function SuggestedRounds({
  ticketId,
  onChanged,
  nextSeq,
  suggested,
}: {
  ticketId: string;
  onChanged: () => void;
  nextSeq: number;
  suggested: { name: string; notes: string }[];
}) {
  const accept = useMutation({
    mutationFn: (s: { name: string }) => createRound(ticketId, { name: s.name, source: "sow" }),
    onSuccess: onChanged,
  });
  if (suggested.length === 0) return null;
  return (
    <Card aria-label="Suggested from the SOW">
      <CardHeader title="Suggested from the SOW" meta={`Next round: ${nextSeq}`} divided />
      <ul>
        {suggested.map((s) => (
          <li
            key={s.name}
            className="flex min-h-16 items-center justify-between gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="text-[14px] font-medium">{s.name}</p>
              {s.notes && <p className="truncate text-[13px] text-ink-2">{s.notes}</p>}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={accept.isPending}
              onClick={() => accept.mutate(s)}
            >
              Accept
            </Button>
          </li>
        ))}
      </ul>
      <MutationError m={accept} />
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
  onClose,
  nextSeq,
}: {
  ticketId: string;
  onChanged: () => void;
  onClose: () => void;
  nextSeq: number;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<RoundKind>("assessment");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [rule, setRule] = useState("");
  const [value, setValue] = useState("");
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
    onSuccess: () => {
      onClose();
      onChanged();
    },
  });
  return (
    <Card>
      <CardHeader title="Add a round" meta={`Next round: ${nextSeq}`} divided />
      <CardBody className="pt-4">
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
                autoFocus
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
              <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={!name.trim() || add.isPending}>
              Add round
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <MutationError m={add} />
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

export function ProgramRounds({ ticketId }: { ticketId: string }) {
  const refresh = useRefresh(ticketId);
  const rounds = useQuery(roundsFullQuery(ticketId));
  const report = useQuery(reportQuery(ticketId));
  const suggestedQ = useQuery(suggestedRoundsQuery(ticketId));
  const canEdit = useCan("rounds.edit");
  const [adding, setAdding] = useState(false);
  if (rounds.isLoading) return <ListSkeleton />;
  if (rounds.isError)
    return <ErrorBox error={rounds.error} onRetry={() => void rounds.refetch()} />;
  const list = rounds.data ?? [];
  const suggested = suggestedQ.data ?? [];
  const summary = report.data?.funnel_summary;
  const latest = list
    .map((r) => r.latest_counts)
    .filter((c): c is NonNullable<typeof c> => !!c)
    .sort((a, b) => b.as_of.localeCompare(a.as_of))[0];
  return (
    <div className="space-y-4 page-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[16px] font-semibold">
            {list.length} {list.length === 1 ? "round" : "rounds"}
            {summary?.final_shortlisted != null &&
              ` · ${n(summary.participants)} participants → ${n(summary.final_shortlisted)} shortlisted`}
          </p>
          {summary?.registered_to_shortlist_pct != null && (
            <p className="text-[13px] text-ink-2">
              {pct(summary.registered_to_shortlist_pct)} of registrations reach the shortlist.
              {latest && ` Counts as of ${formatDate(latest.as_of)} by ${latest.entered_by_name}.`}
            </p>
          )}
        </div>
        {canEdit && (
          <Button aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
            New round
          </Button>
        )}
      </div>
      {adding && canEdit && (
        <AddRound
          ticketId={ticketId}
          onChanged={refresh}
          onClose={() => setAdding(false)}
          nextSeq={list.length + 1}
        />
      )}
      <DeliveryStages rounds={list} suggested={suggested} ticketId={ticketId} onChanged={refresh} />
      {report.isError && <ErrorBox error={report.error} onRetry={() => void report.refetch()} />}
      {list.length === 0 ? (
        <EmptyState
          title="No rounds yet"
          hint="Add the rounds this program runs, or accept the ones suggested from the SOW."
        />
      ) : (
        <RoundsTable
          rounds={list}
          steps={report.data?.funnel ?? []}
          ticketId={ticketId}
          onChanged={refresh}
        />
      )}
      {canEdit && (
        <SuggestedRounds
          ticketId={ticketId}
          onChanged={refresh}
          nextSeq={list.length + 1}
          suggested={suggested}
        />
      )}
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

type ChannelCheck = {
  state: "idle" | "loading" | "ok" | "error";
  text: string;
  note?: string | undefined;
};

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
        .then(
          (r) =>
            !stale &&
            next({
              state: "ok",
              text: `#${r.channel_name}`,
              note: r.is_member
                ? undefined
                : r.is_private
                  ? "The bot isn't in this private channel: in Slack, type /invite and pick the bot."
                  : "The bot isn't in this channel yet. It joins public channels by itself with the first message.",
            }),
        )
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
        {check.state === "ok" && check.note && (
          <span className="block text-status-warning">{check.note}</span>
        )}
        {check.state === "error" && check.text}
        {check.state === "idle" &&
          "Updates for this request are posted there. Leave empty for none."}
      </p>
    </Field>
  );
}

function RaiseRequest({
  ticketId,
  onChanged,
  onClose,
}: {
  ticketId: string;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { data: templates = [] } = useQuery(requestTemplatesQuery);
  const canLink = useCan("integrations.link"); // sending updates to a Slack channel takes the same permission as linking one
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
      onClose();
      onChanged();
    },
  });
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
        {canLink && (
          <SlackChannelField
            ticketId={ticketId}
            value={channel}
            onChange={setChannel}
            onCheck={setChannelCheck}
          />
        )}
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
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <MutationError m={raise} />
        </div>
      </form>
    </Card>
  );
}

const HEALTH_DOT: Record<Health, string> = {
  good: "bg-ok",
  warning: "bg-warn",
  critical: "bg-danger",
};

function PostUpdate({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const canPost = useCan("update.post");
  const slack = useQuery(registrationsQueryOptions(ticketId)).data?.slack;
  const [health, setHealth] = useState<Health | null>(null);
  const [summary, setSummary] = useDraft(`${ticketId}:summary`);
  const [blockers, setBlockers] = useDraft(`${ticketId}:blockers`);
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
  if (!canPost) return null;
  return (
    <Card>
      <CardHeader title="Post update" meta="Goes to the program's Slack channel" />
      <form
        className="space-y-4 px-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          post.mutate();
        }}
      >
        <div>
          <p className="mb-1.5 text-[13px] font-medium">How is it going?</p>
          <div
            role="radiogroup"
            aria-label="Health"
            className="inline-flex rounded-[8px] border border-border bg-secondary p-0.5"
          >
            {(["good", "warning", "critical"] as const).map((h) => (
              <button
                key={h}
                type="button"
                role="radio"
                aria-checked={health === h}
                onClick={() => setHealth(h)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-[6px] px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  health === h
                    ? "bg-card text-foreground"
                    : "text-secondary-foreground hover:text-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", health === h ? HEALTH_DOT[h] : "bg-ink-3")}
                />
                {HEALTH_NAMES[h]}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">Summary</span>
          <Textarea
            id="update-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={4}
            placeholder="What happened today?"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">
            Blockers <span className="font-normal text-ink-2">(optional)</span>
          </span>
          <Input
            value={blockers}
            onChange={(e) => setBlockers(e.target.value)}
            placeholder="Anything holding the program up"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[13px] text-ink-2">Also posts to Slack</span>
          <Chip>
            {slack?.channel_id ? `#${slack.channel_name ?? slack.channel_id}` : "No channel linked"}
          </Chip>
          <div className="flex-1" />
          {!health && summary.trim() && (
            <span className="text-[13px] text-ink-2">Choose a health first.</span>
          )}
          <Button type="submit" disabled={!summary.trim() || !health || post.isPending}>
            Post update
          </Button>
        </div>
        <MutationError m={post} />
      </form>
    </Card>
  );
}

function Feed({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const canComment = useCan("comment.add");
  const [comment, setComment] = useDraft(`${ticketId}:comment`);
  const q = useInfiniteQuery(updatesFeedQuery(ticketId));
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const talk = useMutation({
    mutationFn: () => postComment(ticketId, comment.trim()),
    onSuccess: () => {
      setComment("");
      toast.success("Comment added");
      onChanged();
    },
  });
  return (
    <Card className="flex flex-col">
      <CardHeader title="Updates and comments" meta="Newest first" />
      <div className="flex-1 px-4 pb-4">
        {q.isLoading ? (
          <ListSkeleton rows={2} />
        ) : q.isError ? (
          <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing posted yet"
            hint="Daily updates and comments will appear here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((u) => (
              <li key={u.note_id} className="py-3 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Avatar name={u.author_name} />
                  <span className="text-[14px] font-medium">{u.author_name ?? "Unknown"}</span>
                  <Chip>{titleCase(u.kind)}</Chip>
                  {u.health && <HealthPill health={u.health} />}
                  <span
                    className="ml-auto text-[13px] text-ink-2"
                    title={formatDateTime(u.created_at)}
                  >
                    {u.source !== "programops" && `${u.source} · `}
                    {timeAgo(u.created_at)}
                  </span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-[14px]">{u.body}</p>
                {u.blockers && (
                  <p className="mt-1 text-[13px] text-danger">
                    <span className="mr-1.5 font-medium">Blockers</span>
                    {u.blockers}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {q.hasNextPage && (
          <div className="mt-3 text-center">
            <Button
              size="sm"
              variant="outline"
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {q.isFetchingNextPage ? "Loading…" : "Load older"}
            </Button>
          </div>
        )}
      </div>
      {canComment && (
        <form
          className="border-t border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            talk.mutate();
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a comment"
              aria-label="Comment"
            />
            <Button type="submit" variant="outline" disabled={!comment.trim() || talk.isPending}>
              Comment
            </Button>
          </div>
          <MutationError m={talk} />
        </form>
      )}
    </Card>
  );
}

const dayCell = (iso: string) => {
  const parts = new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    timeZone: "Asia/Kolkata",
  }).formatToParts(new Date(`${iso}T12:00:00+05:30`));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")}`;
};

/** Which of the last 7 days have a daily update, from the updates already loaded. Today shows "Due" until one is posted. */
function UpdateCadence({ ticketId }: { ticketId: string }) {
  const canPost = useCan("update.post");
  const feed = useInfiniteQuery(updatesFeedQuery(ticketId));
  const posted = new Set(
    (feed.data?.pages.flatMap((p) => p.items) ?? [])
      .filter((u) => u.health)
      .map((u) => istDay(u.created_at)),
  );
  const days = Array.from({ length: 7 }, (_, i) => istDay(new Date(Date.now() - (6 - i) * 864e5)));
  const todayIso = days[6]!;
  const done = days.filter((d) => posted.has(d)).length;
  return (
    <Card aria-label="Update cadence">
      <CardHeader
        title="Update cadence"
        meta={<span>Daily update · last 7 days · {done} of 7 posted</span>}
      />
      <CardBody className="space-y-3">
        <ol className="grid grid-cols-7 gap-1.5 sm:gap-2">
          {days.map((d) => {
            const isToday = d === todayIso;
            const has = posted.has(d);
            return (
              <li
                key={d}
                className={cn(
                  "min-w-0 rounded-[6px] border px-1.5 py-2 text-center text-[12px] leading-4 sm:text-[13px]",
                  isToday ? "border-primary" : "border-border",
                  has ? "bg-accent-bg text-foreground" : "text-ink-2",
                )}
              >
                <b className="block truncate font-medium text-foreground">
                  {dayCell(d)}
                  {isToday && <span className="hidden sm:inline"> · today</span>}
                </b>
                {has ? "Posted" : isToday ? "Due" : "—"}
              </li>
            );
          })}
        </ol>
        {canPost && !posted.has(todayIso) && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => document.getElementById("update-summary")?.focus()}
          >
            Post today's update
          </Button>
        )}
      </CardBody>
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

export function ProgramRequests({ ticketId }: { ticketId: string }) {
  const refresh = useRefresh(ticketId);
  const requests = useQuery(requestsFullQuery(ticketId));
  const canRaise = useCan("request.create");
  const [section, setSection] = useState<OpsSection>("requests");
  const [raising, setRaising] = useState(false);
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
      <KpiStrip label="Requests summary">
        <KpiCell
          label="Last update"
          value={lastUpdate ? timeAgo(lastUpdate.created_at) : "None yet"}
          sub={
            lastUpdate ? <HealthPill health={lastUpdate.health as Health} /> : "Post the first one"
          }
        />
        <KpiCell
          label="Open requests"
          value={open.length}
          sub={
            overdueRequests ? (
              <span className="text-danger">{overdueRequests} overdue</span>
            ) : (
              "None overdue"
            )
          }
        />
        <KpiCell
          label="Client dependencies"
          value={deps?.impact.open ?? "–"}
          sub={
            deps?.impact.overdue ? (
              <span className="text-danger">{deps.impact.overdue} overdue</span>
            ) : (
              "None overdue"
            )
          }
        />
        <KpiCell
          label="Changes to decide"
          value={proposed}
          sub={
            lateComms ? (
              <span className="text-warn">{lateComms} overdue comms</span>
            ) : (
              "Timeline changes"
            )
          }
        />
      </KpiStrip>

      <UpdateCadence ticketId={ticketId} />

      <div className="grid items-stretch gap-4 xl:grid-cols-2">
        <PostUpdate ticketId={ticketId} onChanged={refresh} />
        <Feed ticketId={ticketId} onChanged={refresh} />
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3.5">
          <div className="max-w-full relative overflow-x-auto">
            <Segmented
              value={section}
              onChange={setSection}
              options={[
                { id: "requests" as const, label: "Special requests", count: open.length },
                { id: "blockers" as const, label: "Dependencies and changes", count: attention },
              ]}
            />
          </div>
          {canRaise && (
            <Button
              aria-expanded={raising}
              onClick={() => {
                setSection("requests");
                setRaising(true);
              }}
            >
              Raise request
            </Button>
          )}
        </div>
        <CardBody className="mt-3 space-y-4">
          {section === "requests" ? (
            <>
              <p className="text-[13px] text-ink-2">
                Anything the client or team asks for beyond the plan. Each one has a checklist to
                tick off until it is done.
              </p>
              {canRaise && raising && (
                <RaiseRequest
                  ticketId={ticketId}
                  onChanged={refresh}
                  onClose={() => setRaising(false)}
                />
              )}
              {requests.isLoading ? (
                <ListSkeleton rows={2} />
              ) : requests.isError ? (
                <ErrorBox error={requests.error} onRetry={() => void requests.refetch()} />
              ) : requests.data?.length ? (
                <>
                  {open.map(card)}
                  {resolved.length > 0 && (
                    <details className="space-y-4">
                      <summary className="cursor-pointer text-[13px] text-ink-2">
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
            </>
          ) : (
            <div className="grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              <Dependencies ticketId={ticketId} onChanged={refresh} />
              <Communications ticketId={ticketId} onChanged={refresh} />
              <TimelineChanges ticketId={ticketId} onChanged={refresh} />
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// ==== ACTIVITY LOG ===============================================================================

const ENTITY_LABEL: Record<string, string> = {
  activity: "Activity",
  activity_metrics: "Activity",
  round: "Round",
  rounds: "Round",
  round_counts: "Round",
  checklist: "Checklist",
  phase: "Phase",
  dependency: "Dependency",
  communication: "Communication",
  timeline_change: "Timeline",
  update: "Update",
  comment: "Comment",
  note: "Note",
};
const chipLabel = (e: string) => ENTITY_LABEL[e] ?? titleCase(e);

/** The type filter: each group is one or more audit entities. "other" is whatever no group claims. */
const TYPE_GROUPS: { id: string; label: string; entities: string[] }[] = [
  { id: "all", label: "All", entities: [] },
  { id: "activity", label: "Activities", entities: ["activity", "activity_metrics"] },
  { id: "round", label: "Rounds", entities: ["round", "rounds", "round_counts"] },
  { id: "checklist", label: "Checklists", entities: ["checklist"] },
  { id: "communication", label: "Communication", entities: ["communication"] },
  { id: "update", label: "Updates and comments", entities: ["update", "comment", "note"] },
  { id: "other", label: "Other", entities: [] },
];
const groupOf = (entity: string) =>
  TYPE_GROUPS.find((g) => g.entities.includes(entity))?.id ?? "other";

const utc = (at: string) => new Date(/[Zz]|[+-]\d{2}:\d{2}$/.test(at) ? at : `${at}Z`);
const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
const istDay = (at: string | Date) => IST_DAY.format(typeof at === "string" ? utc(at) : at);
const timeOf = (at: string) =>
  utc(at)
    .toLocaleTimeString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Kolkata",
    })
    .replace(/\s?(am|pm)/i, (_, ap: string) => ` ${ap.toLowerCase()}`);
const dayHeading = (iso: string) =>
  iso === istDay(new Date())
    ? "Today"
    : iso === istDay(new Date(Date.now() - 864e5))
      ? "Yesterday"
      : formatDate(iso);

/** Names already loaded by the other tabs' queries, keyed "entity:id", to turn "round 6" into a title. */
function useNames(ticketId: string) {
  const rounds = useQuery(roundsFullQuery(ticketId)).data;
  const acts = useQuery(activitiesQuery(ticketId)).data;
  const reqs = useQuery(requestsFullQuery(ticketId)).data;
  const deps = useQuery(dependenciesQuery(ticketId)).data;
  const comms = useQuery(communicationsQuery(ticketId)).data;
  const changes = useQuery(timelineChangesQuery(ticketId)).data;
  return useMemo(() => {
    const m = new Map<string, string>();
    rounds?.forEach((r) => m.set(`round:${r.id}`, r.name));
    acts?.forEach((a) => m.set(`activity:${a.id}`, a.title));
    reqs?.forEach((r) => m.set(`checklist:${r.id}`, r.title));
    deps?.items.forEach((d) => m.set(`dependency:${d.id}`, d.title));
    comms?.forEach((c) => m.set(`communication:${c.id}`, `${titleCase(c.kind)} to ${c.audience}`));
    changes?.forEach((c) => m.set(`timeline_change:${c.id}`, c.label));
    return m;
  }, [rounds, acts, reqs, deps, comms, changes]);
}

const REF_ENTITY: Record<string, string> = {
  activity: "activity",
  round: "round",
  checklist: "checklist",
  dependency: "dependency",
  communication: "communication",
  "timeline change": "timeline_change",
};
/** logSentence with its raw ids ("activity 31", "counts (round 2)") swapped for names where we know them. */
function humanSentence(e: AuditEvent, names: Map<string, string>) {
  const s = logSentence(e).replace(/ \((round|activity) (\d+)\)/, (m, k: string, id: string) => {
    const nm = names.get(`${k}:${id}`);
    return nm ? ` for ${nm}` : m;
  });
  return s.replace(
    /\b(activity|round|checklist|dependency|communication|timeline change) (\d+)\b/g,
    (m, k: string, id: string) => {
      const nm = names.get(`${REF_ENTITY[k]}:${id}`);
      return nm ? (k === "checklist" ? `request ${nm}` : nm) : m;
    },
  );
}

/** A payload value as plain words: {"sent":100,"opens":10} becomes "Sent 100 · Opens 10". */
function plain(v: unknown): string {
  if (v === null || v === undefined || v === "") return "empty";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v.toLocaleString("en-IN");
  if (Array.isArray(v)) return v.length ? v.map(plain).join(", ") : "none";
  if (typeof v === "object")
    return (
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== null && x !== undefined && x !== "")
        .map(([k, x]) => `${titleCase(k)} ${plain(x)}`)
        .join(" · ") || "empty"
    );
  const s = String(v);
  return s.includes(";") ? splitList(s).join(", ") : s;
}
const changeLine = (e: AuditEvent) =>
  e.field ? `${titleCase(e.field)}: ${plain(e.old)} → ${plain(e.new)}` : plain(e.new ?? e.old);
const hasDetail = (e: AuditEvent) => e.field != null || (e.new != null && e.new !== "");

const CHART_DAYS = 14;

/** Events per day over the last 14 days, counted from the events loaded below. One hue, text summary for screen readers. */
function EventsPerDay({ events }: { events: AuditEvent[] }) {
  const days = Array.from({ length: CHART_DAYS }, (_, i) =>
    istDay(new Date(Date.now() - (CHART_DAYS - 1 - i) * 864e5)),
  );
  const counts = new Map<string, number>(days.map((d) => [d, 0]));
  for (const e of events) {
    const d = istDay(e.at);
    if (counts.has(d)) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts.values());
  const summary = days
    .filter((d) => counts.get(d))
    .map((d) => `${counts.get(d)} on ${formatDate(d)}`)
    .join(", ");
  return (
    <Card aria-label="Events per day">
      <CardHeader
        title="Events per day"
        meta={
          <span>
            {formatDate(days[0]!)} – {formatDate(days[days.length - 1]!)} · {n(total)}{" "}
            {total === 1 ? "event" : "events"}
          </span>
        }
      />
      <CardBody>
        <div
          role="img"
          aria-label={`Events per day: ${summary || "none"}${summary ? ", none on other days" : " in the last 14 days"}`}
          className="flex h-[132px] items-end gap-1 border-b border-ink-2"
        >
          {days.map((d) => {
            const c = counts.get(d) ?? 0;
            return (
              <div
                key={d}
                title={`${formatDate(d)}: ${c} ${c === 1 ? "event" : "events"}`}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
              >
                {c > 0 && (
                  <span className="mb-0.5 text-center text-[12px] leading-4 text-ink-2">{c}</span>
                )}
                <div
                  className="bar-rise mx-auto w-full max-w-[26px] rounded-t-[2px]"
                  style={{
                    height: c ? `${Math.max(3, (c / max) * 88)}px` : 0,
                    background: "var(--chart-1)",
                  }}
                />
              </div>
            );
          })}
        </div>
        <div aria-hidden className="mt-1.5 flex gap-1 text-[12px] leading-4 text-ink-2">
          {days.map((d, i) => (
            <span key={d} className="min-w-0 flex-1 text-center">
              {i === 0 || d.endsWith("-01")
                ? formatDate(d).replace(/ \d{4}$/, "")
                : Number(d.slice(8))}
            </span>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

export function ProgramActivityLog({ ticketId }: { ticketId: string }) {
  const [type, setType] = useState("all");
  const [actor, setActor] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const q = useInfiniteQuery(auditFeedQuery(ticketId, null));
  const names = useNames(ticketId);
  const items: AuditEvent[] = q.data?.pages.flatMap((p) => p.items) ?? [];
  const actors = [...new Set(items.map((e) => e.actor_name))].sort();
  const term = search.trim().toLowerCase();
  const shown = items.filter(
    (e) =>
      (type === "all" || groupOf(e.entity) === type) &&
      (!actor || e.actor_name === actor) &&
      (!term ||
        `${e.actor_name} ${humanSentence(e, names)} ${hasDetail(e) ? changeLine(e) : ""}`
          .toLowerCase()
          .includes(term)),
  );
  const count = (id: string) =>
    id === "all" ? items.length : items.filter((e) => groupOf(e.entity) === id).length;
  const options = TYPE_GROUPS.filter((g) => g.id !== "other" || count("other") > 0).map((g) => ({
    id: g.id,
    label: g.label,
    count: count(g.id),
  }));
  const days = groupLog(shown, dayHeading);
  const filtered = type !== "all" || actor || term;
  return (
    <div className="space-y-4 page-in">
      <EventsPerDay events={items} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="max-w-full relative overflow-x-auto">
          <Segmented value={type} onChange={setType} options={options} />
        </div>
        <div className="flex-1" />
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search events"
          aria-label="Search events"
          className="w-full sm:w-[220px]"
        />
        <Select aria-label="Actor" value={actor} onChange={(e) => setActor(e.target.value)}>
          <option value="">Everyone</option>
          {actors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
      </div>

      <Card aria-label="Activity feed">
        {q.isLoading ? (
          <div className="p-[18px]">
            <ListSkeleton rows={4} />
          </div>
        ) : q.isError ? (
          <div className="p-[18px]">
            <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : shown.length === 0 ? (
          <p className="px-[18px] py-8 text-center text-[14px] text-ink-2">
            {filtered
              ? "No loaded events match this filter."
              : "Nothing recorded yet. Changes to this program will be listed here."}
          </p>
        ) : (
          days.map((day) => (
            <section key={day.day}>
              <h3 className="border-y border-border bg-raised px-4 py-1.5 text-[13px] font-medium text-ink-2 first:border-t-0 lg:sticky lg:top-[57px] lg:z-[1]">
                {day.label}
              </h3>
              <ul>
                {day.entries.map((en) => {
                  const first = en.events[0]!;
                  const many = en.events.length > 1;
                  const open = expanded[en.key];
                  return (
                    <li
                      key={en.key}
                      className="grid grid-cols-[auto_1fr_auto] items-start gap-x-3 border-b border-border px-4 py-2.5 last:border-b-0 sm:grid-cols-[64px_auto_1fr_auto]"
                    >
                      <time
                        dateTime={first.at}
                        title={`${first.at} · #${first.id}`}
                        className="hidden pt-0.5 text-[13px] text-ink-2 sm:block"
                      >
                        {timeOf(first.at)}
                      </time>
                      <Avatar name={en.actor} className="mt-0.5" />
                      <div className="min-w-0 text-[14px]">
                        <span className="font-medium">{en.actor}</span>{" "}
                        {humanSentence(first, names)}
                        <time dateTime={first.at} className="ml-2 text-[13px] text-ink-2 sm:hidden">
                          {timeOf(first.at)}
                        </time>
                        {many ? (
                          <p className="text-[13px] text-ink-2">
                            {en.events.length} changes ·{" "}
                            <button
                              type="button"
                              aria-expanded={!!open}
                              onClick={() => setExpanded({ ...expanded, [en.key]: !open })}
                              className="text-primary hover:underline"
                            >
                              {open ? "Hide details" : "Show details"}
                            </button>
                          </p>
                        ) : (
                          hasDetail(first) && (
                            <p className="text-[13px] text-ink-2">{changeLine(first)}</p>
                          )
                        )}
                        {many && open && (
                          <ul className="mt-1.5 space-y-1 border-l border-border pl-3 text-[13px] text-ink-2">
                            {en.events.map((ev) => (
                              <li key={ev.id} className="flex justify-between gap-3">
                                <span>{changeLine(ev)}</span>
                                <span className="shrink-0" title={`${ev.at} · #${ev.id}`}>
                                  {timeOf(ev.at)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <Chip>{chipLabel(first.entity)}</Chip>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
        {(items.length > 0 || q.hasNextPage) && (
          <div className="flex items-center justify-center gap-3 border-t border-border px-4 py-3 text-[13px] text-ink-2">
            <span>
              Showing {n(shown.length)} of {n(items.length)} loaded events
            </span>
            {q.hasNextPage && (
              <Button
                size="sm"
                variant="outline"
                disabled={q.isFetchingNextPage}
                onClick={() => void q.fetchNextPage()}
              >
                {q.isFetchingNextPage ? "Loading…" : "Load older"}
              </Button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
