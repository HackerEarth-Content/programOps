import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, ExternalLink, TriangleAlert, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { EmptyStat, Skeleton } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCan } from "@/lib/api";
import { formatDay, formatWhen, safeUrl } from "@/lib/format";
import {
  activityAuditQuery,
  metricsQuery,
  patchPlanActivity,
  putMetrics,
  type ActivityMetrics,
  type PlanActivity,
} from "@/lib/marketing-api";
import {
  approveActivity,
  goLive,
  withdrawApproval,
  type ActivityStatus,
  type AuditEvent,
} from "@/lib/ops-api";
import { cn } from "@/lib/utils";
import { errText, maxGoLiveIso, STATUS_LABEL, todayIso, weekKey, weekLabel } from "./shared";

/** One numbered-free step: a pip (ticked when done, dashed when still needed), its label, hint and controls. */
function Step({
  done,
  label,
  hint,
  children,
}: {
  done: boolean;
  label: string;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 border-b border-border py-3.5 last:border-b-0">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-[18px] place-items-center rounded-full border-[1.5px]",
          done ? "border-ok bg-ok text-on-accent" : "border-dashed border-placeholder",
        )}
      >
        {done && <Check className="size-2.5" strokeWidth={3.5} />}
      </span>
      <div className="min-w-0 space-y-1.5">
        <p className="text-[14px] font-medium leading-5">
          {label}
          <span className="sr-only">{done ? " (done)" : " (still needed)"}</span>
        </p>
        {hint && <p className="text-[13px] text-ink-2">{hint}</p>}
        {children}
      </div>
    </div>
  );
}

/** The activity panel: three ordered steps, proof link, results and one Save for every edited field. */
export function ActivityDetail({
  ticketId,
  a,
  csm,
  busy,
  canApprove,
  canEdit,
  onClose,
  act,
  onNudge,
  feedback,
}: {
  feedback: ReactNode;
  ticketId: string;
  a: PlanActivity;
  csm: string | null;
  busy: boolean;
  canApprove: boolean;
  canEdit: boolean;
  /** Present on the side panel; the bottom sheet has its own close button. */
  onClose?: (() => void) | undefined;
  act: (fn: () => Promise<unknown>) => void;
  onNudge: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [approving, setApproving] = useState(false);
  const [utm, setUtm] = useState(a.utm ?? "");
  const [proof, setProof] = useState(a.creative_proof_url ?? "");
  const [date, setDate] = useState(a.planned_date ?? "");
  const eligible = !!a.approved_at && !!a.utm && !!a.planned_date;
  const missing = [
    !a.approved_at && "CSM approval",
    !a.utm && "UTM",
    !a.planned_date && "go-live date",
  ].filter(Boolean);
  const changes = {
    ...(utm.trim() !== (a.utm ?? "") && { utm: utm.trim() || null }),
    ...(date !== (a.planned_date ?? "") && { planned_date: date || null }),
    ...(proof.trim() !== (a.creative_proof_url ?? "") && {
      creative_proof_url: proof.trim() || null,
    }),
  };
  const dirty = Object.keys(changes).length;
  const discard = () => {
    setUtm(a.utm ?? "");
    setDate(a.planned_date ?? "");
    setProof(a.creative_proof_url ?? "");
  };

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      if (e.key === "Escape" && !typing && !document.querySelector("[role=dialog]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const who = csm ?? "the CSM";
  const proofHref = safeUrl(a.creative_proof_url);

  return (
    <div className="flex flex-col">
      <div className="flex items-start justify-between gap-3 px-4 pb-1 pt-4">
        <div className="min-w-0">
          <p className="text-[13px] text-ink-2">
            <span className="font-mono">{a.code}</span> · {a.channel} · {weekLabel(weekKey(a))}
          </p>
          <h2 className="mt-0.5 text-[16px] font-semibold leading-6">{a.title}</h2>
          {(a.audience ?? a.outcome ?? a.hook) && (
            <p className="mt-0.5 text-[13px] text-ink-2">{a.audience ?? a.outcome ?? a.hook}</p>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            aria-label="Close details"
            className="rounded p-1 text-ink-2 hover:text-foreground"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {feedback && <div className="space-y-2 px-4 pt-2">{feedback}</div>}

      <div className="px-4">
        <Step
          done={!!a.approved_at}
          label="CSM approval"
          hint={
            a.approved_at
              ? `Approved by ${a.approved_by_name ?? "the CSM"}, ${formatWhen(a.approved_at)}.${a.status === "live" ? "" : " Changing the description or creative proof clears it."}`
              : "Can't go live until the CSM approves it."
          }
        >
          {canApprove && !a.approved_at && !approving && (
            <div className="flex flex-wrap gap-2 pt-0.5">
              <Button size="sm" disabled={busy} onClick={() => setApproving(true)}>
                Approve activity
              </Button>
              {canEdit && (
                <Button size="sm" variant="outline" disabled={busy} onClick={onNudge}>
                  Remind {who} in Slack
                </Button>
              )}
            </div>
          )}
          {!canApprove && !a.approved_at && canEdit && (
            <Button size="sm" variant="outline" disabled={busy} onClick={onNudge}>
              Remind {who} in Slack
            </Button>
          )}
          {canApprove && !a.approved_at && approving && (
            <div className="space-y-2">
              <p className="text-[13px] text-ink-2">
                Approve “{a.title}” for {a.channel}? Editing its description or creative proof
                afterwards clears the approval.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    act(() => approveActivity(ticketId, a.id));
                    setApproving(false);
                  }}
                >
                  {busy ? "Approving…" : "Confirm approval"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setApproving(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {canApprove && a.approved_at && !confirming && (
            <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
              Withdraw approval
            </Button>
          )}
          {canApprove && a.approved_at && confirming && (
            <div className="space-y-2">
              {a.status === "live" && (
                <p className="flex items-start gap-1.5 text-[13px] text-danger">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" /> This activity is live.
                  Withdrawing the approval makes it a control breach and alerts the program channel.
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    act(() => withdrawApproval(ticketId, a.id));
                    setConfirming(false);
                  }}
                >
                  Confirm withdraw
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Step>

        <Step
          done={!!a.utm}
          label="UTM campaign"
          hint="Added to the tracking link. Lowercase, no spaces."
        >
          <div className="flex gap-2">
            <Input
              className="min-w-0 flex-1 font-mono text-[13px]"
              value={utm}
              readOnly={!canEdit}
              placeholder="campaign_name"
              onChange={(e) => setUtm(e.target.value)}
              aria-label="UTM campaign"
            />
          </div>
        </Step>

        <Step
          done={!!a.planned_date}
          label="Go-live date"
          hint="The day this goes out: today up to 2 months ahead."
        >
          <Input
            type="date"
            min={todayIso()}
            max={maxGoLiveIso()}
            className="max-w-[190px]"
            value={date}
            readOnly={!canEdit}
            aria-label="Go-live date"
            onChange={(e) => setDate(e.target.value)}
          />
        </Step>
      </div>

      <div className="space-y-4 border-t border-border px-4 py-4">
        <div className="space-y-1.5">
          <p className="text-[14px] font-medium">Creative proof link</p>
          <div className="flex gap-2">
            <Input
              className="min-w-0 flex-1"
              value={proof}
              readOnly={!canEdit}
              placeholder="https://drive.google.com/…"
              onChange={(e) => setProof(e.target.value)}
              aria-label="Creative proof link"
            />
            {proofHref && (
              <Button variant="outline" size="icon" asChild>
                <a
                  href={proofHref}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label="Open creative proof"
                >
                  <ExternalLink />
                </a>
              </Button>
            )}
          </div>
        </div>

        {canEdit && (
          <div className="space-y-1.5">
            <p className="text-[14px] font-medium">Status</p>
            {a.status !== "live" && a.status !== "off" && (
              <p className="text-[13px] text-ink-2">
                {eligible ? "Ready to go live." : `Still needs: ${missing.join(", ")}.`}
              </p>
            )}
            <Select
              value={a.status}
              disabled={busy}
              onValueChange={(v) => {
                const st = v as ActivityStatus;
                act(() =>
                  st === "live"
                    ? goLive(ticketId, a.id)
                    : patchPlanActivity(ticketId, a, { status: st }),
                );
              }}
            >
              <SelectTrigger
                aria-label={`Status of ${a.title}`}
                className="h-8 max-w-[190px] rounded-[6px] border-border bg-card text-[14px] shadow-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(STATUS_LABEL) as ActivityStatus[]).map((st) => (
                  <SelectItem
                    key={st}
                    value={st}
                    disabled={
                      (st === "live" && a.status !== "live" && !eligible) ||
                      (st === "off" && a.status !== "live" && a.status !== "off")
                    }
                  >
                    {STATUS_LABEL[st]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Telemetry ticketId={ticketId} a={a} />
        <History id={a.id} />
      </div>

      {canEdit && (
        <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-card px-4 py-3">
          <span className="flex-1 text-[13px] text-ink-2">
            {dirty === 0
              ? "No unsaved changes"
              : `${dirty} unsaved ${dirty === 1 ? "change" : "changes"}`}
          </span>
          <Button size="sm" variant="ghost" disabled={dirty === 0 || busy} onClick={discard}>
            Discard
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={dirty === 0 || busy}
            onClick={() => act(() => patchPlanActivity(ticketId, a, changes))}
          >
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </div>
  );
}

const fmt = (n: number | undefined) =>
  n === undefined ? undefined : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

function Stat({ label, value }: { label: string; value: string | undefined }) {
  return value === undefined ? (
    <EmptyStat label={label} />
  ) : (
    <div className="rounded-lg border border-border bg-raised px-2.5 py-2">
      <p className="text-[12px] text-ink-2">{label}</p>
      <p className="text-[18px] font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Telemetry({ ticketId, a }: { ticketId: string; a: PlanActivity }) {
  const qc = useQueryClient();
  const canEnter = useCan("metrics.enter");
  const { data, isLoading, isError, error } = useQuery(metricsQuery(ticketId, a.id));
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    views: "",
    clicks: "",
    sent: "",
    opens: "",
  });
  const log = useMutation({
    mutationFn: () =>
      putMetrics(ticketId, a.id, {
        date: form.date,
        ...(form.views !== "" && { views: Number(form.views) }),
        ...(form.clicks !== "" && { clicks: Number(form.clicks) }),
        ...(form.sent !== "" && { sent: Number(form.sent) }),
        ...(form.opens !== "" && { opens: Number(form.opens) }),
      }),
    onSuccess: (d: ActivityMetrics) => {
      qc.setQueryData(metricsQuery(ticketId, a.id).queryKey, d);
      setForm((f) => ({ ...f, views: "", clicks: "", sent: "", opens: "" }));
    },
  });
  const t = data?.totals;
  const hasResults = (data?.days.length ?? 0) > 0;
  // the API already returns CTR and open rate as percents (12.4 = 12.4%)
  const pct = (n: number | null | undefined) => (n == null ? undefined : `${n.toFixed(1)}%`);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[14px] font-medium">
        Results{" "}
        <span className="font-normal text-ink-2">
          {hasResults ? "" : "· recorded daily once live"}
        </span>
      </h3>
      {isLoading && <Skeleton className="h-16" />}
      {isError && <p className="text-[13px] text-danger">{errText(error)}</p>}
      {data && (
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Views" value={hasResults ? fmt(t?.views) : undefined} />
          <Stat label="Clicks" value={hasResults ? fmt(t?.clicks) : undefined} />
          <Stat label="CTR" value={hasResults ? pct(t?.ctr) : undefined} />
          {t && (t.sent > 0 || t.opens > 0) && (
            <>
              <Stat label="Sent" value={fmt(t.sent)} />
              <Stat label="Opens" value={fmt(t.opens)} />
              <Stat label="Open rate" value={pct(t.open_rate)} />
            </>
          )}
        </div>
      )}
      {canEnter && a.status === "live" && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            log.mutate();
          }}
          className="space-y-2 border-t border-border pt-3"
        >
          <p className="text-[14px] font-medium">Log results</p>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="date"
              value={form.date}
              required
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              aria-label="Date"
            />
            {(["views", "clicks", "sent", "opens"] as const).map((k) => (
              <Input
                key={k}
                type="number"
                min={0}
                inputMode="numeric"
                placeholder={k[0]?.toUpperCase() + k.slice(1)}
                aria-label={k}
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              />
            ))}
          </div>
          {log.isError && <p className="text-[13px] text-danger">{errText(log.error)}</p>}
          <Button type="submit" variant="outline" size="sm" disabled={log.isPending}>
            {log.isPending ? "Saving…" : "Log results"}
          </Button>
        </form>
      )}
    </section>
  );
}

const FIELD_LABEL: Record<string, string> = {
  utm: "UTM",
  planned_date: "Go-live date",
  creative_proof_url: "Creative proof",
  go_live_at: "Went live at",
  comes_off_at: "Done at",
  tracker_ref: "Tracker ref",
  target_note: "Target note",
};
const fieldLabel = (f: string) =>
  FIELD_LABEL[f] ?? f.charAt(0).toUpperCase() + f.slice(1).replace(/_/g, " ");

/** One audit event as a short headline plus, for field edits, the before and after values. */
function describe(e: AuditEvent): { title: string; from?: string; to?: string } {
  const v = (x: unknown) => {
    if (x === null || x === undefined || x === "") return "empty";
    if (e.field === "status") return STATUS_LABEL[x as ActivityStatus] ?? String(x);
    if (e.field === "planned_date" || e.field === "go_live_at" || e.field === "comes_off_at")
      return formatDay(String(x).slice(0, 10));
    return String(x);
  };
  switch (e.action) {
    case "activity_updated":
      return { title: fieldLabel(e.field ?? "field"), from: v(e.old), to: v(e.new) };
    case "approved":
      return { title: "Approved" };
    case "approval_withdrawn":
      return { title: "Approval withdrawn" };
    case "approval_reset":
      return { title: "Approval cleared by an edit" };
    case "channel_added":
      return { title: "Added manually" };
    default: {
      const t = e.action.replace(/_/g, " ");
      return { title: t.charAt(0).toUpperCase() + t.slice(1) };
    }
  }
}

function History({ id }: { id: number }) {
  const { data, isLoading, isError, error } = useQuery(activityAuditQuery(id));
  const items = data?.items ?? [];
  const days = new Map<string, AuditEvent[]>();
  for (const e of items) {
    const day = formatDay(e.at.slice(0, 10));
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return (
    <details className="group border-t border-border pt-3.5 text-[14px]">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium">
        <ChevronRight className="size-4 text-ink-2 transition-transform group-open:rotate-90" />
        History
        {data && <span className="font-normal text-ink-2">· {items.length}</span>}
      </summary>
      <div className="mt-3 space-y-4">
        {isLoading && <Skeleton className="h-12" />}
        {isError && <p className="text-danger">{errText(error)}</p>}
        {data && items.length === 0 && <p className="text-ink-2">No changes yet.</p>}
        {[...days].map(([day, events]) => (
          <div key={day}>
            <p className="mb-1.5 text-[12px] font-medium text-ink-2">{day}</p>
            <ol className="space-y-3 border-l border-border pl-3.5">
              {events.map((e) => {
                const d = describe(e);
                return (
                  <li key={e.id} className="relative">
                    <span
                      aria-hidden
                      className="absolute -left-[19px] top-1.5 size-2 rounded-full bg-border"
                    />
                    <p className="font-medium">{d.title}</p>
                    {d.to !== undefined && (
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-ink-2">
                        <span className="rounded-[4px] bg-chip px-1.5 py-px text-ink-2 line-through">
                          {d.from}
                        </span>
                        <span aria-hidden>→</span>
                        <span className="break-all rounded-[4px] bg-chip px-1.5 py-px">{d.to}</span>
                      </p>
                    )}
                    <p className="mt-0.5 text-[13px] text-ink-2">
                      {e.actor_name} · {formatWhen(e.at)}
                    </p>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
    </details>
  );
}
