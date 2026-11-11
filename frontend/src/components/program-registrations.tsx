import { Fragment, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar as RBar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  Hash,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  TrendingUp,
  Upload,
  UsersRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Chip,
  EmptyState,
  KpiCell,
  KpiStrip,
  Legend,
  Notice,
  Num,
  SegBar,
  Segmented,
  Skeleton,
} from "@/components/kit";
import {
  apiFetch,
  checkRedash,
  deleteRegistration,
  API_BASE_URL,
  joinSlackChannel,
  lookupSlackChannel,
  previewSlackMessage,
  runRedash,
  saveRedash,
  saveRegistrationConfig,
  saveRegistrations,
  saveSlack,
  testSlack,
  useCan,
  type RedashEvent,
  type RegistrationEntry,
  type RegistrationEstimate,
  type SaveResult,
} from "@/lib/api";
import { activitiesQuery, type Activity } from "@/lib/ops-api";
import { programDocumentsQueryOptions, type PoaActivity } from "@/lib/program-documents";
import {
  liftQuery,
  refreshSources,
  registrationsViewQuery,
  saveTargets,
  sourcesQuery,
  EMPTY_DRAFT,
  draftYoe,
  requirementLabel,
  useCandidates,
  useLiveElapsed,
  yrs,
  type CandidateRequirement,
  type Candidates,
  type Lift,
  type ReqDraft,
  type RegistrationsView,
  type SourceLine,
  type Sources,
} from "@/lib/registrations-api";
import {
  CandidatesPanel,
  RequirementDialog,
  RequirementFields,
} from "@/components/program-candidates";
import { systemStatusQuery } from "@/lib/system-api";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---- helpers ---------------------------------------------------------------------------

const dayMs = 86_400_000;
const isoMs = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).getTime();
const toIso = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const todayKey = () => toIso(Date.now());
const fmt = (iso: string) =>
  new Intl.DateTimeFormat("en", { day: "2-digit", month: "short" }).format(new Date(isoMs(iso)));
const fmtLong = (iso: string) =>
  new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric" }).format(
    new Date(isoMs(iso)),
  );
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
const compact = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    // A text cell starting with = + - @ (or a tab / carriage return) would run as a formula in a spreadsheet: a
    // leading ' makes it plain text. Numbers are untouched.
    const s = typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// Window length, how far into it we are, and the even pace the target implies.
function windowStats(est: RegistrationEstimate, nowMs = Date.now()) {
  if (!est.start || !est.end) return { length: null, elapsed: null, pace: null as number | null };
  const length = Math.round((isoMs(est.end) - isoMs(est.start)) / dayMs) + 1;
  const elapsed = Math.min(length, Math.max(0, Math.floor((nowMs - isoMs(est.start)) / dayMs) + 1));
  return { length, elapsed, pace: est.target ? Math.round(est.target / length) : null };
}

/** Small grey caption (replaces the old uppercase mono label). */
const MonoLabel = ({ className, ...rest }: ComponentProps<"span">) => (
  <span className={cn("text-[12px] font-medium text-ink-3", className)} {...rest} />
);

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** What a manual Redash fetch did: the days saved and where the Slack update is (it waits for the relevant count). */
const fetchedText = (r: SaveResult) =>
  `Fetched ${r.saved} ${r.saved === 1 ? "day" : "days"}.${r.slack.sent ? " Posted to Slack." : ""}${
    r.slack.queued
      ? " The Slack update will be posted when the relevant count is ready (about a minute)."
      : ""
  }${r.slack.error ? ` Slack failed: ${r.slack.error}` : ""}`;

type SubView = "pace" | "sources" | "candidates";

/**
 * Bring the first of these elements into view (the setup block must already be open), focus its first control and
 * ring it in red for about 3 seconds, or until the first click or key, so the person can see where to act.
 * Scrolling is instant and the ring static when motion is reduced (see [data-flash] in styles.css).
 */
function scrollToSetup(ids: string[]) {
  // two frames: the block has to be open and laid out before it can be scrolled to
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = ids.map((id) => document.getElementById(id)).find((e) => e != null);
      if (!el) return;
      el.scrollIntoView({ behavior: motionOk() ? "smooth" : "auto", block: "center" });
      el.querySelector<HTMLElement>("input, select, textarea, button")?.focus({
        preventScroll: true,
      });
      el.setAttribute("data-flash", "");
      const off = () => {
        el.removeAttribute("data-flash");
        window.clearTimeout(timer);
        document.removeEventListener("pointerdown", off, true);
        document.removeEventListener("keydown", off, true);
      };
      const timer = window.setTimeout(off, 3000);
      document.addEventListener("pointerdown", off, true);
      document.addEventListener("keydown", off, true);
    }),
  );
}

// ---- the tab ------------------------------------------------------------------------------

export function ProgramRegistrationsTab({
  ticketId,
  isHiring,
  redashEnabled,
}: {
  ticketId: string;
  isHiring: boolean;
  redashEnabled: boolean;
}) {
  const qc = useQueryClient();
  const reg = useQuery(registrationsViewQuery(ticketId));
  const sources = useQuery({
    ...sourcesQuery(ticketId),
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  });
  const status = useQuery(systemStatusQuery);
  const cand = useCandidates(ticketId, redashEnabled && !!reg.data?.redash.event_slug);
  const canManage = useCan("registrations.manage");
  const canLink = useCan("integrations.link");
  const [view, setView] = useState<SubView>("pace");
  const [setupOpen, setSetupOpen] = useState(false);
  const [editReq, setEditReq] = useState(false);
  const elapsed = useLiveElapsed(cand);
  const [behindEarlier, setBehindEarlier] = useState(false);
  useEffect(() => {
    if (!cand.data?.running) setBehindEarlier(false);
  }, [cand.data?.running]);
  const [editTargets, setEditTargets] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const sync = useMutation({
    mutationFn: () => runRedash(ticketId),
    onSuccess: (r) => {
      setNotice({
        ok: !r.slack.error,
        text: fetchedText(r),
      });
      void qc.invalidateQueries({ queryKey: ["programs", ticketId] });
      void qc.invalidateQueries({ queryKey: ["system", "status"] });
    },
    onError: (e) => setNotice({ ok: false, text: errMsg(e) }),
  });

  if (reg.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-96 max-w-full" />
        <Skeleton className="h-[104px]" />
        <Skeleton className="h-[420px]" />
      </div>
    );
  if (reg.isError || !reg.data)
    return (
      <EmptyState
        title="Couldn't load registrations"
        hint={errMsg(reg.error)}
        action={
          <Button size="sm" variant="outline" onClick={() => void reg.refetch()}>
            Retry
          </Button>
        }
      />
    );

  const data = reg.data;
  const slug = data.redash.event_slug;
  // Open the (collapsed) setup block, then scroll to and ring the part that needs filling in.
  const goSetup = (target: "link" | "entry") => {
    setSetupOpen(true);
    scrollToSetup(target === "link" ? ["reg-redash", "reg-setup"] : ["reg-entry", "reg-setup"]);
  };
  // No daily counts yet: say what to do, and give the button only to people who can do it.
  const noDaily = data.entries.length === 0;
  const dailyMissing = (title: string) => {
    const linkable = redashEnabled && !slug;
    const fetchable = redashEnabled && !!slug && data.redash.auto;
    const can = linkable ? canLink || canManage : fetchable ? canLink : canManage;
    const text = linkable
      ? "Link the HackerEarth event (Auto) or add the first day's count to see daily registrations."
      : fetchable
        ? "Daily counts come from Redash. Fetch them to see daily registrations."
        : "Add the first day's count to see daily registrations.";
    return (
      <Callout
        title={title}
        action={
          can ? (
            fetchable ? (
              <Button
                size="sm"
                disabled={sync.isPending}
                onClick={() => sync.mutate()}
                className="max-sm:min-h-11"
              >
                <RefreshCw className={cn(sync.isPending && "animate-spin")} />
                {sync.isPending ? "Fetching…" : "Fetch from Redash"}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => goSetup(linkable ? "link" : "entry")}
                className="max-sm:min-h-11"
              >
                {linkable ? "Link the event or add a day" : "Add the first day"}
              </Button>
            )
          ) : undefined
        }
      >
        {can ? text : "Ask the CSM to link the event or add the first day."}
      </Callout>
    );
  };
  const exportEntries = () =>
    downloadCsv("registrations.csv", [
      ["date", ...(isHiring ? ["role"] : []), "registrations", "relevant", ...data.fields],
      ...data.entries.map((e) => [
        e.date,
        ...(isHiring ? [e.role] : []),
        e.registrations,
        e.relevant,
        ...data.fields.map((f) => e.extra[f] ?? ""),
      ]),
    ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<SubView>
          value={view}
          onChange={setView}
          options={[
            { id: "pace", label: "Daily pace & velocity" },
            { id: "sources", label: "Sources & attribution" },
            ...(redashEnabled ? [{ id: "candidates" as const, label: "Candidates" }] : []),
          ]}
          className="max-w-full relative overflow-x-auto"
        />
        <div className="flex-1" />
        {redashEnabled && slug && (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                status.data?.redash_registrations_synced_at ? "bg-ok" : "bg-warn",
              )}
            />
            Redash #{slug} ·{" "}
            {status.data?.redash_registrations_synced_at
              ? `synced ${timeAgo(status.data.redash_registrations_synced_at)}`
              : "never synced"}
            {data.redash.auto ? " · auto" : ""}
          </span>
        )}
        {redashEnabled && canLink && slug && (
          <Button
            size="sm"
            variant="outline"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            <RefreshCw className={cn(sync.isPending && "animate-spin")} />
            {sync.isPending ? "Syncing…" : "Sync Redash now"}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={exportEntries} disabled={!data.entries.length}>
          <Download />
          Export CSV
        </Button>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => setEditTargets(true)}>
            <Pencil />
            Edit target and dates
          </Button>
        )}
      </div>
      {notice && (
        <p className={cn("text-[13px]", notice.ok ? "text-ok" : "text-danger")} role="status">
          {notice.text}
        </p>
      )}

      {noDaily && dailyMissing("Daily registrations aren't set up yet")}

      <RegKpis
        data={data}
        sources={sources.data}
        candidates={cand.data}
        enabled={redashEnabled}
        linked={!!slug}
        canManage={canManage}
        onEdit={() => setEditReq(true)}
        refreshSeconds={elapsed}
      />

      {view === "candidates" && redashEnabled && (
        <CandidatesPanel
          ticketId={ticketId}
          q={cand}
          linked={!!slug}
          elapsed={elapsed}
          behindEarlier={behindEarlier}
          onSetup={() => goSetup("link")}
          onEditRequirement={() => setEditReq(true)}
        />
      )}
      {view === "pace" && (
        <PacePanel
          ticketId={ticketId}
          data={data}
          isHiring={isHiring}
          sources={sources.data}
          empty={dailyMissing("No daily registrations yet")}
        />
      )}
      {view === "sources" && <SourcesPanel ticketId={ticketId} />}

      {(canManage || canLink) && (
        <Integrations
          requirement={cand.data?.requirement ?? null}
          onEditRequirement={() => setEditReq(true)}
          open={setupOpen}
          setOpen={setSetupOpen}
          ticketId={ticketId}
          data={data}
          isHiring={isHiring}
          redashEnabled={redashEnabled}
          canManage={canManage}
          canLink={canLink}
        />
      )}

      {editReq && (
        <RequirementDialog
          ticketId={ticketId}
          req={cand.data?.requirement ?? { yoe: null, cities: [] }}
          onClose={() => setEditReq(false)}
          onSaved={setBehindEarlier}
        />
      )}

      {editTargets && (
        <TargetsDialog
          ticketId={ticketId}
          est={data.estimate}
          onClose={() => setEditTargets(false)}
        />
      )}
    </div>
  );
}

// ---- KPI strip (the four numbers) -----------------------------------------------------------------------------

/**
 * The second KPI: who meets the CSM's requirement (Redash candidates snapshot), or what is needed to show it.
 * People with registrations.manage get the whole cell as a button that opens the requirement dialog in place.
 */
function MeetsCell({
  candidates,
  enabled,
  linked,
  canManage,
  onEdit,
  elapsed,
}: {
  elapsed: number | null;
  candidates: Candidates | undefined;
  enabled: boolean;
  linked: boolean;
  canManage: boolean;
  onEdit: () => void;
}) {
  // Cells that ask for something to be set up wear the same red outline and icon as the other missing-data prompts.
  const ALERT = "bg-danger-bg/30 ring-1 ring-inset ring-danger/50";
  const alertIcon = <CircleAlert aria-hidden className="size-4 shrink-0 text-danger" />;
  const editable = canManage && enabled && linked;
  const label = (
    <span className="flex items-center justify-between gap-2">
      Meets requirement
      {editable && <Pencil aria-hidden className="size-3.5 shrink-0 text-ink-3" />}
    </span>
  );
  const props = (alert?: boolean) => ({
    label,
    ...(alert ? { className: ALERT } : {}),
    ...(editable
      ? { onClick: onEdit, ariaLabel: "Meets requirement: edit who counts as relevant" }
      : {}),
  });
  const quiet = (text: string, sub?: string, alert?: boolean) => (
    <KpiCell
      {...props(alert)}
      value={
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-[15px] font-medium",
            alert ? "text-foreground" : "text-ink-3",
          )}
        >
          {alert && alertIcon}
          {text}
        </span>
      }
      sub={sub}
    />
  );
  if (!enabled) return quiet("Not tracked", "Only for programs on the HackerEarth platform.");
  if (!linked) return quiet("Event not linked", "Link the HackerEarth event to see this.", true);
  const req = candidates?.requirement;
  if (!req) return quiet("Not fetched yet");
  if (!req.yoe && req.cities.length === 0)
    return (
      <KpiCell
        {...props(true)}
        value={
          <span className="inline-flex items-center gap-1.5 text-[15px] font-medium text-foreground">
            {alertIcon}
            {canManage ? "Set who counts as relevant" : "No requirement set"}
          </span>
        }
        sub="Experience and cities that count as relevant."
      />
    );
  const snap = candidates.snapshot;
  if (candidates.running || candidates.outdated)
    return quiet(elapsed != null ? `Refreshing… ${elapsed}s` : "Refreshing…");
  if (!snap) return quiet("Not fetched yet");
  return (
    <KpiCell
      {...props()}
      value={<Num value={snap.relevant} />}
      unit={
        snap.total ? `${Math.round((snap.relevant / snap.total) * 1000) / 10}% of total` : undefined
      }
      sub={`${snap.requirement.yoe ? yrs(snap.requirement.yoe) : "Any experience"}${
        snap.requirement.cities.length ? ` · ${snap.requirement.cities.join(", ")}` : ""
      } · +${snap.possibly.toLocaleString()} possibly`}
    />
  );
}

function RegKpis({
  data,
  sources,
  candidates,
  enabled,
  linked,
  canManage,
  onEdit,
  refreshSeconds,
}: {
  refreshSeconds: number | null;
  data: RegistrationsView;
  sources: Sources | undefined;
  candidates: Candidates | undefined;
  enabled: boolean;
  linked: boolean;
  canManage: boolean;
  onEdit: () => void;
}) {
  const est = data.estimate;
  const raw = data.raw_total;
  const target = est.target;
  const latestDate = data.entries.reduce((m, e) => (e.date > m ? e.date : m), "");
  const latest = latestDate
    ? data.entries.filter((e) => e.date === latestDate).reduce((s, e) => s + e.registrations, 0)
    : null;
  const { length, elapsed } = windowStats(est);
  const expected =
    target && length && elapsed != null ? Math.round((target * elapsed) / length) : null;
  const pctTarget = target ? Math.round((raw / target) * 100) : null;

  // Runway: only what real target / window / actuals allow.
  const today = todayKey();
  const daysLeft = est.end
    ? Math.max(0, Math.round((isoMs(est.end) - isoMs(today)) / dayMs))
    : null;
  const needed = target ? Math.max(0, target - raw) : null;
  const required = daysLeft && needed != null && daysLeft > 0 ? Math.ceil(needed / daysLeft) : null;
  const first =
    est.start && est.start < (latestDate || today)
      ? est.start
      : data.entries.reduce((m, e) => (!m || e.date < m ? e.date : m), "");
  const activeDays =
    first && latestDate ? Math.round((isoMs(latestDate) - isoMs(first)) / dayMs) + 1 : 0;
  const rate = activeDays > 0 ? raw / activeDays : 0;
  const projected =
    needed != null && rate > 0 && latestDate
      ? toIso(isoMs(latestDate) + Math.ceil(needed / rate) * dayMs)
      : null;
  const slip =
    projected && est.end ? Math.round((isoMs(est.end) - isoMs(projected)) / dayMs) : null;
  const paceTone = expected ? (raw >= expected ? ("good" as const) : ("warning" as const)) : null;

  const report = sources?.report;
  const campaignCount = report?.lines.filter((l) => l.bucket === "activity").length ?? 0;

  const ended = !!est.end && est.end < today;
  const latestLine =
    latest != null ? `+${latest.toLocaleString()} on ${fmt(latestDate)}` : "No days yet";

  return (
    <KpiStrip label="Registration numbers">
      <KpiCell
        label="Total registrations"
        value={<Num value={raw} />}
        unit={target ? `/ ${target.toLocaleString()} target` : "no target set"}
        pct={target ? Math.min(100, pctTarget ?? 0) : undefined}
        bar={target && raw >= target ? "ok" : "accent"}
        sub={target ? `${latestLine} · ${pctTarget}% of target` : latestLine}
      />
      <MeetsCell
        candidates={candidates}
        enabled={enabled}
        linked={linked}
        canManage={canManage}
        onEdit={onEdit}
        elapsed={refreshSeconds}
      />
      <KpiCell
        label="Runway and pacing"
        value={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {ended && est.end ? (
              `Closed ${fmt(est.end)}`
            ) : daysLeft != null ? (
              <>
                <Num value={daysLeft} />
                <span className="text-[13px] font-normal text-ink-2">
                  days left{est.end ? ` · ends ${fmt(est.end)}` : ""}
                </span>
              </>
            ) : rate ? (
              <>
                <Num value={Math.round(rate)} />
                <span className="text-[13px] font-normal text-ink-2">/ day average</span>
              </>
            ) : (
              <span className="text-ink-3">—</span>
            )}
            {paceTone && (
              <Chip tone={paceTone}>{paceTone === "good" ? "Ahead of pace" : "Behind pace"}</Chip>
            )}
          </span>
        }
        sub={
          daysLeft == null && !rate ? (
            "Needs a campaign window or some daily counts."
          ) : (
            <>
              {needed === 0 && <span className="block">Target reached.</span>}
              {required != null && !ended && (
                <span className="block">Required: {required.toLocaleString()} / day</span>
              )}
              {projected && needed !== 0 && (
                <span className="block">
                  Projected finish: {fmt(projected)}
                  {slip != null &&
                    slip !== 0 &&
                    ` (${Math.abs(slip)}d ${slip > 0 ? "early" : "late"})`}
                </span>
              )}
              {expected != null && (
                <span className="block">
                  Expected by {ended ? "the close" : "today"}: about {expected.toLocaleString()}
                </span>
              )}
            </>
          )
        }
      />
      <KpiCell
        label="Attribution snapshot"
        value={
          report ? (
            <Num value={report.organic_pct} decimals={1} />
          ) : (
            <span className="text-ink-3">—</span>
          )
        }
        unit={report ? "% organic" : undefined}
        sub={
          report
            ? `${plural(campaignCount, "campaign source")} · fetched ${timeAgo(sources?.fetched_at)}`
            : "No attribution snapshot yet."
        }
      />
    </KpiStrip>
  );
}

// The SOW / event window in one honest line.
function TimelineLine({ data }: { data: RegistrationsView }) {
  const est = data.estimate;
  const weeks =
    est.weeks_min && est.weeks_max
      ? est.weeks_min === est.weeks_max
        ? `${est.weeks_min}-week`
        : `${est.weeks_min}/${est.weeks_max}-week`
      : null;
  if (!est.start && !est.target && !weeks)
    return (
      <p className="text-[13px] text-ink-3">
        No registration timeline yet: the SOW states no window or target. Set one with Edit target /
        dates.
      </p>
    );
  const source =
    est.start_source === "event"
      ? "the HackerEarth event"
      : (est.start_source as string | null) === "override"
        ? "set by the CSM"
        : est.start_source;
  return (
    <p className="text-[13px] text-ink-2">
      <span className="font-medium">Estimated timeline.</span>{" "}
      {est.start ? (
        <>
          Opens <span className="t-data-sm">{fmtLong(est.start)}</span>
          {est.end && (
            <>
              {" "}
              · {est.end_is_actual ? "closes" : "expected to close"}{" "}
              <span className="t-data-sm">
                {!est.end_is_actual && est.end_min && est.end_min !== est.end
                  ? `${fmt(est.end_min)} – ${fmt(est.end)}`
                  : fmtLong(est.end)}
              </span>
            </>
          )}{" "}
          <span className="text-ink-3">
            (start from {source}
            {!est.end_is_actual && est.end ? ", end estimated" : ""})
          </span>
        </>
      ) : (
        "Start date unknown: link the HackerEarth event or add the first day's count to anchor it."
      )}
      {weeks && <span className="text-ink-3"> · SOW: {weeks} window</span>}
    </p>
  );
}

// ---- Daily pace chart ------------------------------------------------------------------

type DayRow = {
  date: string;
  daily: number;
  cum: number | null;
  pace: number | null;
  relevant: number | null; // that day's relevant registrations; null = no figure for the day
  acts: PoaActivity[];
  live: Activity[];
};

// Round axis ticks: 4-5 steps of 1/2/5 x 10^n up to the first step at or above the max.
function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = 0; v < max + step; v += step) {
    out.push(v);
    if (v >= max) break;
  }
  return out;
}

function PacePanel({
  ticketId,
  data,
  isHiring,
  sources,
  empty,
}: {
  ticketId: string;
  data: RegistrationsView;
  isHiring: boolean;
  sources: Sources | undefined;
  empty: ReactNode; // shown when there are no daily counts at all: what to do about it
}) {
  const activities = useQuery(activitiesQuery(ticketId));
  const docs = useQuery(programDocumentsQueryOptions(ticketId));
  const [role, setRole] = useState("all");
  const [asTable, setAsTable] = useState(false);
  const est = data.estimate;
  const poaActs = docs.data?.poa?.details?.activities;

  const live = useMemo(
    () => (activities.data ?? []).filter((a) => a.status === "live" && a.go_live_at),
    [activities.data],
  );
  const rows = useMemo<DayRow[]>(() => {
    const entries = data.entries.filter((e) => role === "all" || e.role === role);
    if (!entries.length) return [];
    const byDate = new Map<string, number>();
    entries.forEach((e) => byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.registrations));
    // A day's relevant count is the sum over its roles; unknown (null) if any of them is unknown.
    const byRelevant = new Map<string, number | null>();
    entries.forEach((e) => {
      const prev = byRelevant.get(e.date);
      byRelevant.set(e.date, e.relevant == null || prev === null ? null : (prev ?? 0) + e.relevant);
    });
    const dates = [...byDate.keys()].sort();
    const firstEntry = dates[0]!;
    const lastEntry = dates[dates.length - 1]!;
    const from = est.start && est.start < firstEntry ? est.start : firstEntry;
    const to = est.end && est.end > lastEntry ? est.end : lastEntry;
    const length =
      est.start && est.end ? Math.round((isoMs(est.end) - isoMs(est.start)) / dayMs) + 1 : null;
    const out: DayRow[] = [];
    let cum = 0;
    const days = Math.min(500, Math.round((isoMs(to) - isoMs(from)) / dayMs) + 1);
    for (let i = 0; i < days; i++) {
      const date = toIso(isoMs(from) + i * dayMs);
      const daily = byDate.get(date) ?? 0;
      cum += daily;
      const idx = est.start ? Math.round((isoMs(date) - isoMs(est.start)) / dayMs) + 1 : 0;
      out.push({
        date,
        daily,
        cum: date <= lastEntry ? cum : null,
        relevant: byRelevant.get(date) ?? null,
        pace:
          role === "all" && est.target && length && idx >= 1 && idx <= length
            ? Math.round((est.target * idx) / length)
            : null,
        acts: (poaActs ?? []).filter((a) => a.date === date),
        live: live.filter((a) => a.go_live_at?.slice(0, 10) === date),
      });
    }
    return out;
  }, [data.entries, role, est.start, est.end, est.target, poaActs, live]);

  const goLives = rows.filter((r) => r.live.length);
  const hasPace = rows.some((r) => r.pace != null);
  const hasRelevant = rows.some((r) => r.relevant != null);
  const lastCum = [...rows].reverse().find((r) => r.cum != null);
  const lastPace = [...rows].reverse().find((r) => r.pace != null);
  const maxY = Math.max(0, ...rows.map((r) => Math.max(r.cum ?? 0, r.pace ?? 0, r.daily)));
  const ticks = niceTicks(maxY);
  const summary = lastCum
    ? `Cumulative registrations rise from 0 to ${lastCum.cum!.toLocaleString()} on ${fmt(lastCum.date)}${
        lastPace
          ? `, against a target pace line that ends at ${lastPace.pace!.toLocaleString()}`
          : ""
      }.`
    : "No registrations yet.";
  const axis = { fontSize: 12, fill: "var(--color-ink-2)", fontFamily: "inherit" };

  return (
    <>
      <Card>
        <CardHeader
          title="Registration velocity vs target pace"
          meta={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAsTable((v) => !v)}
              aria-pressed={asTable}
            >
              {asTable ? <TrendingUp /> : <Table2 />}
              {asTable ? "View as chart" : "View as table"}
            </Button>
          }
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2">
              <Swatch mark={<span className="h-0.5 w-4 bg-primary" />}>Actual cumulative</Swatch>
              <Swatch mark={<span className="size-2.5 rounded-[2px] bg-ink-2 opacity-35" />}>
                Daily volume
              </Swatch>
              {hasPace && (
                <Swatch mark={<span className="w-4 border-t border-dashed border-ink-2" />}>
                  Target pace
                </Swatch>
              )}
              {goLives.length > 0 && (
                <Swatch mark={<span className="h-3 w-0 border-l border-dashed border-chart-2" />}>
                  Marketing go-live
                </Swatch>
              )}
            </ul>
            {isHiring && data.roles.length > 0 && (
              <Segmented
                value={role}
                onChange={setRole}
                options={[
                  { id: "all", label: "All roles" },
                  ...data.roles.map((r) => ({ id: r, label: r })),
                ]}
                className="max-w-full relative overflow-x-auto"
              />
            )}
          </div>

          {!rows.length ? (
            data.entries.length === 0 ? (
              empty
            ) : (
              <EmptyState
                title="No registrations yet"
                hint="Daily counts appear here once Redash syncs or someone adds the first day."
              />
            )
          ) : asTable ? (
            <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
              <table className="w-full min-w-[420px]">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border">
                    <th className="t-th p-2.5 text-left">Date</th>
                    <th className="t-th p-2.5 text-right">Daily</th>
                    {hasRelevant && <th className="t-th p-2.5 text-right">Relevant</th>}
                    <th className="t-th p-2.5 text-right">Cumulative</th>
                    {hasPace && <th className="t-th p-2.5 text-right">Target pace</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.date} className="border-b border-border last:border-0">
                      <td className="p-2.5 text-[13px]">{fmtLong(r.date)}</td>
                      <td className="p-2.5 text-right text-[13px]">{r.daily.toLocaleString()}</td>
                      {hasRelevant && (
                        <td className="p-2.5 text-right text-[13px]">
                          {r.relevant?.toLocaleString() ?? <span className="text-ink-3">—</span>}
                        </td>
                      )}
                      <td className="p-2.5 text-right text-[13px]">
                        {r.cum?.toLocaleString() ?? <span className="text-ink-3">—</span>}
                      </td>
                      {hasPace && (
                        <td className="p-2.5 text-right text-[13px]">
                          {r.pace?.toLocaleString() ?? <span className="text-ink-3">—</span>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="h-[300px]" role="img" aria-label={summary}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 24, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid
                    vertical={false}
                    stroke="var(--color-border)"
                    strokeDasharray="3 4"
                  />
                  <XAxis
                    dataKey="date"
                    tickFormatter={fmt}
                    minTickGap={32}
                    tick={axis}
                    axisLine={{ stroke: "var(--color-ink-2)" }}
                    tickLine={false}
                  />
                  <YAxis
                    ticks={ticks}
                    domain={[0, ticks[ticks.length - 1]!]}
                    tickFormatter={compact}
                    tick={axis}
                    axisLine={false}
                    tickLine={false}
                    width={44}
                  />
                  <Tooltip content={<PaceTip />} cursor={{ stroke: "var(--color-border)" }} />
                  {goLives.map((r) => (
                    <ReferenceLine
                      key={r.date}
                      x={r.date}
                      stroke="var(--color-chart-2)"
                      strokeDasharray="4 3"
                    />
                  ))}
                  <RBar
                    dataKey="daily"
                    fill="var(--color-ink-2)"
                    fillOpacity={0.35}
                    maxBarSize={20}
                    isAnimationActive={motionOk()}
                    animationDuration={500}
                    animationEasing="ease-out"
                  />
                  {hasPace && (
                    <Line
                      dataKey="pace"
                      type="linear"
                      stroke="var(--color-ink-2)"
                      strokeDasharray="4 4"
                      strokeWidth={1}
                      activeDot={false}
                      isAnimationActive={motionOk()}
                      animationDuration={500}
                      animationEasing="ease-out"
                      dot={(p: { index?: number; cx?: number; cy?: number }) => (
                        <g key={`p${p.index}`}>
                          {p.index === rows.indexOf(lastPace!) && p.cx != null && p.cy != null && (
                            <text
                              x={p.cx - 6}
                              y={p.cy + 16}
                              textAnchor="end"
                              fontSize={12}
                              fill="var(--color-ink-2)"
                            >
                              Target {lastPace!.pace!.toLocaleString()}
                            </text>
                          )}
                        </g>
                      )}
                    />
                  )}
                  <Line
                    dataKey="cum"
                    type="linear"
                    stroke="var(--color-chart-1)"
                    strokeWidth={2}
                    activeDot={{ r: 4 }}
                    isAnimationActive={motionOk()}
                    animationDuration={500}
                    animationEasing="ease-out"
                    dot={(p: { index?: number; cx?: number; cy?: number }) => (
                      <g key={`c${p.index}`}>
                        {p.index === rows.indexOf(lastCum!) && p.cx != null && p.cy != null && (
                          <>
                            <circle cx={p.cx} cy={p.cy} r={4} fill="var(--color-chart-1)" />
                            <text
                              x={p.cx - 8}
                              y={p.cy - 10}
                              textAnchor="end"
                              fontSize={12}
                              fontWeight={500}
                              fill="var(--color-foreground)"
                            >
                              {lastCum!.cum!.toLocaleString()} on {fmt(lastCum!.date)}
                            </text>
                          </>
                        )}
                      </g>
                    )}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {goLives.length > 0 && !asTable && (
            <ul className="flex flex-wrap gap-1.5">
              {goLives.flatMap((r) =>
                r.live.map((a) => (
                  <li key={a.id}>
                    <Chip tone="good" title={a.channel}>
                      {fmt(r.date)}: {a.title}
                    </Chip>
                  </li>
                )),
              )}
            </ul>
          )}
          {activities.isError && (
            <p className="text-[13px] text-ink-3">
              Go-live markers unavailable: {errMsg(activities.error)}
            </p>
          )}
          <TimelineLine data={data} />
        </CardBody>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <SourceSplit sources={sources} />
        <WindowCard est={est} />
      </div>
    </>
  );
}

function Swatch({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span aria-hidden className="inline-flex items-center">
        {mark}
      </span>
      {children}
    </li>
  );
}

/** Organic vs everything else, from the existing attribution snapshot. */
function SourceSplit({ sources }: { sources: Sources | undefined }) {
  const report = sources?.report;
  const organic = report ? Math.round(report.organic_pct * 10) / 10 : 0;
  const other = Math.round((100 - organic) * 10) / 10;
  const campaigns = report?.lines.filter((l) => l.bucket === "activity").length ?? 0;
  return (
    <Card>
      <CardHeader
        title="Where registrations came from"
        meta={
          sources?.fetched_at ? (
            <span className="text-[13px]">Attribution fetched {timeAgo(sources.fetched_at)}</span>
          ) : undefined
        }
      />
      <CardBody>
        {report ? (
          <>
            <SegBar
              label={`${organic}% organic, ${other}% other`}
              parts={[
                { label: `Organic ${organic}%`, value: organic },
                { label: other >= 8 ? `${other}%` : "", value: other, muted: true },
              ]}
            />
            <div className="mt-2.5">
              <Legend
                items={[
                  { label: `Organic ${organic}%` },
                  { label: `Other ${other}%`, muted: true },
                  { label: plural(campaigns, "campaign source"), muted: true },
                ]}
              />
            </div>
          </>
        ) : (
          <p className="text-[13px] text-ink-2">
            No attribution snapshot yet. Open Sources &amp; attribution to refresh it.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/** Bar from open to close, days open vs the SOW window. */
function WindowCard({ est }: { est: RegistrationEstimate }) {
  const { length, elapsed } = windowStats(est);
  const today = todayKey();
  const ended = !!est.end && est.end < today;
  const notStarted = !!est.start && est.start > today;
  const pct = length && elapsed != null ? (elapsed / length) * 100 : 0;
  const days = (a: string, b: string) => Math.abs(Math.round((isoMs(a) - isoMs(b)) / dayMs));
  const meta =
    !est.start || !est.end
      ? undefined
      : ended
        ? `Closed ${plural(days(today, est.end), "day")} ago`
        : notStarted
          ? `Opens in ${plural(days(est.start, today), "day")}`
          : `${plural(days(est.end, today), "day")} left`;
  let sow: string | null = null;
  if (length && est.weeks_min && est.weeks_max) {
    const lo = est.weeks_min * 7;
    const hi = est.weeks_max * 7;
    const w =
      est.weeks_min === est.weeks_max
        ? `${est.weeks_min}-week`
        : `${est.weeks_min}–${est.weeks_max} week`;
    sow = `${length >= lo && length <= hi ? "inside" : length > hi ? "longer than" : "shorter than"} the SOW's ${w} window`;
  }
  return (
    <Card>
      <CardHeader
        title="Registration window"
        meta={meta && <span className="text-[13px]">{meta}</span>}
      />
      <CardBody>
        {est.start && est.end && length ? (
          <>
            <div
              className="mb-2 h-2 overflow-hidden rounded-full bg-border"
              role="progressbar"
              aria-label="Registration window elapsed"
              aria-valuenow={Math.round(Math.min(100, pct))}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <div className="flex justify-between text-[13px] text-ink-2">
              <span>Opened {fmt(est.start)}</span>
              <span>
                {est.end_is_actual || ended ? "Closed" : "Expected close"} {fmt(est.end)}
              </span>
            </div>
            <p className="mt-2 text-[13px] text-ink-2">
              {ended || notStarted
                ? `Open for ${plural(length, "day")}`
                : `Day ${elapsed} of ${length}`}
              {sow ? `, ${sow}` : ""}.
            </p>
          </>
        ) : (
          <p className="text-[13px] text-ink-2">
            No start and end dates yet. Set them with Edit target and dates.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function PaceTip({ active, payload }: { active?: boolean; payload?: Array<{ payload: DayRow }> }) {
  const d = active ? payload?.[0]?.payload : undefined;
  if (!d) return null;
  const ahead = d.cum != null && d.pace != null ? d.cum - d.pace : null;
  return (
    <div className="max-w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground">
      <MonoLabel className="block">{fmtLong(d.date)}</MonoLabel>
      <p className="mt-1 t-data-sm">+{d.daily.toLocaleString()} registrations</p>
      {d.relevant != null && <p className="t-data-sm">{d.relevant.toLocaleString()} relevant</p>}
      {d.cum != null && <p className="t-data-sm">Cumulative: {d.cum.toLocaleString()}</p>}
      {ahead != null && (
        <p className={cn("t-data-sm", ahead >= 0 ? "text-ok" : "text-warn")}>
          {ahead >= 0 ? "+" : ""}
          {ahead.toLocaleString()} {ahead >= 0 ? "ahead of" : "behind"} pace
        </p>
      )}
      {(d.live.length > 0 || d.acts.length > 0) && (
        <div className="mt-2 space-y-0.5 border-t border-border pt-2 text-[13px]">
          {d.live.map((a) => (
            <p key={`l${a.id}`}>
              <span className="text-ok">Went live:</span> {a.title}
            </p>
          ))}
          {d.acts.map((a) => (
            <p key={a.activity} className="text-ink-3">
              Planned: {a.activity} · {a.channel}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Sources & attribution -------------------------------------------------------------

function SourcesPanel({ ticketId }: { ticketId: string }) {
  const qc = useQueryClient();
  const canLink = useCan("integrations.link");
  const q = useQuery({
    ...sourcesQuery(ticketId),
    refetchInterval: (s) => (s.state.data?.running ? 3000 : false),
  });
  const lift = useQuery(liftQuery(ticketId));
  const refresh = useMutation({
    mutationFn: () => refreshSources(ticketId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["programs", ticketId, "sources"] }),
  });
  const liftBy = useMemo(
    () => new Map((lift.data ?? []).map((l) => [l.activity_id, l])),
    [lift.data],
  );
  const s = q.data;
  const running = !!s?.running || refresh.isPending;

  return (
    <Card>
      <CardHeader
        title="Acquisition sources"
        meta={
          canLink && (
            <Button size="sm" variant="outline" disabled={running} onClick={() => refresh.mutate()}>
              <RefreshCw className={cn(running && "animate-spin")} />
              {running ? "Refreshing…" : "Refresh snapshot"}
            </Button>
          )
        }
      />
      <CardBody className="space-y-3">
        <p className="text-[13px] text-ink-2">
          {s?.fetched_at
            ? `Snapshot fetched ${timeAgo(s.fetched_at)}${s.stale ? " (stale)" : ""}. `
            : ""}
          Organic and unmatched sources stay grey; campaign UTMs are blue and get a lift figure.
        </p>
        {(s?.error || refresh.isError) && (
          <p className="text-[13px] text-danger" role="alert">
            {refresh.isError ? errMsg(refresh.error) : `Last refresh failed: ${s?.error}`}
            {s?.report ? " Showing the last good snapshot." : ""}
          </p>
        )}
        {q.isLoading ? (
          <Skeleton className="h-56" />
        ) : q.isError ? (
          <EmptyState
            title="Couldn't load sources"
            hint={errMsg(q.error)}
            action={
              <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
                Retry
              </Button>
            }
          />
        ) : !s?.report ? (
          <EmptyState
            title="No attribution snapshot yet"
            hint={
              canLink
                ? "Link the program to its HackerEarth event, then refresh the snapshot."
                : "A snapshot appears once the event is linked and refreshed."
            }
          />
        ) : (
          <>
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead>
                  <tr className="border-b border-border">
                    <th className="t-th p-2.5 text-left">Source / UTM campaign</th>
                    <th className="t-th p-2.5 text-right">Registrations</th>
                    <th className="t-th p-2.5 text-right">Share</th>
                    <th className="t-th p-2.5 text-right">Lift</th>
                  </tr>
                </thead>
                <tbody>
                  {s.report.lines.map((l, i) => (
                    <SourceRow
                      key={`${l.source_medium}|${l.campaign}`}
                      line={l}
                      i={i}
                      lift={l.activity_id != null ? liftBy.get(l.activity_id) : undefined}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-2 text-[13px] text-ink-3">
              <p className="max-w-xl">
                Lift compares registrations per day before and after a go-live. It is concurrent,
                not causal: other channels run at the same time.
              </p>
              <p className="t-data-sm">
                Sum: {s.report.total.toLocaleString()}{" "}
                {s.report.reconciles ? "" : "(does not reconcile with raw total)"}
              </p>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SourceRow({ line, i, lift }: { line: SourceLine; i: number; lift: Lift | undefined }) {
  const neutral = line.bucket !== "activity";
  const title =
    line.bucket === "activity"
      ? (line.activity_code ?? line.campaign)
      : line.campaign || line.source_medium;
  return (
    <tr className="border-b border-border last:border-0" style={{ ["--i" as string]: i }}>
      <td className="p-2.5">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{
              background: neutral
                ? line.bucket === "unmatched"
                  ? "var(--color-ink-3)"
                  : "var(--color-chart-4)"
                : "var(--color-chart-1)",
            }}
          />
          <div className="min-w-0">
            <p className={cn("truncate text-[14px] font-medium", neutral && "text-ink-2")}>
              {title}
            </p>
            <p className="truncate font-mono text-[12px] text-ink-3">{line.source_medium}</p>
          </div>
        </div>
      </td>
      <td className="p-2.5 text-right text-[14px]">{line.users.toLocaleString()}</td>
      <td className="p-2.5 text-right text-[13px] text-ink-2">{line.share_pct.toFixed(1)}%</td>
      <td className="p-2.5 text-right">
        {neutral ? (
          <span className="text-[13px] text-ink-3">
            {line.bucket === "unmatched" ? "N/A" : "Baseline"}
          </span>
        ) : lift?.lift_pct != null ? (
          <Chip
            tone={lift.lift_pct >= 0 ? "good" : "critical"}
            title={`${lift.before_avg}/day before, ${lift.after_avg}/day after`}
          >
            {lift.lift_pct >= 0 ? "+" : ""}
            {Math.round(lift.lift_pct)}% lift*
          </Chip>
        ) : (
          <span className="text-[13px] text-ink-3">N/A</span>
        )}
      </td>
    </tr>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <MonoLabel>{label}</MonoLabel>
      {children}
    </label>
  );
}

// ---- Edit target / dates ----------------------------------------------------------------------

function TargetsDialog({
  ticketId,
  est,
  onClose,
}: {
  ticketId: string;
  est: RegistrationEstimate;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [target, setTarget] = useState(est.target ? String(est.target) : "");
  const [start, setStart] = useState(est.start ?? "");
  const [end, setEnd] = useState(est.end ?? "");
  const save = useMutation({
    mutationFn: () =>
      saveTargets(ticketId, {
        target: target ? Number(target) : null,
        campaign_start: start || null,
        campaign_end: end || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["programs", ticketId] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit target and campaign dates</DialogTitle>
          <DialogDescription>
            These override the SOW and Redash values. Clear a field to fall back to them.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Registration target">
            <Input
              type="number"
              min={1}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Campaign start">
              <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Campaign end">
              <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          {save.isError && <p className="text-[13px] text-danger">{errMsg(save.error)}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Data entry & integrations (collapsed by default) -------------------------------------------

function Integrations({
  requirement,
  onEditRequirement,
  open,
  setOpen,
  ticketId,
  data,
  isHiring,
  redashEnabled,
  canManage,
  canLink,
}: {
  requirement: CandidateRequirement | null;
  onEditRequirement: () => void;
  open: boolean;
  setOpen: (v: boolean | ((o: boolean) => boolean)) => void;
  ticketId: string;
  data: RegistrationsView;
  isHiring: boolean;
  redashEnabled: boolean;
  canManage: boolean;
  canLink: boolean;
}) {
  const manualOk = canManage && (!redashEnabled || !data.redash.auto);
  return (
    <section id="reg-setup" className="surface scroll-mt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>
          <span className="block text-[14px] font-semibold">Data entry &amp; integrations</span>
          <span className="text-[13px] text-ink-2">
            {data.redash.auto ? "Daily counts from Redash" : "Manual daily counts"} ·{" "}
            {data.slack.channel_id
              ? `Slack #${data.slack.channel_name ?? data.slack.channel_id}`
              : "Slack channel not linked"}
            {redashEnabled && ` · Redash ${data.redash.event_slug ?? "event not linked"}`}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn("size-4 text-ink-3 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="space-y-4 border-t border-border p-4">
          {canLink && <SlackChannelBox ticketId={ticketId} data={data} />}
          {canLink && redashEnabled && (
            <RedashBox
              ticketId={ticketId}
              data={data}
              requirement={requirement}
              onEditRequirement={onEditRequirement}
            />
          )}
          {manualOk ? (
            <div id="reg-entry" className="scroll-mt-4">
              <EntryEditor ticketId={ticketId} data={data} isHiring={isHiring} />
            </div>
          ) : (
            canManage && (
              <p className="text-[13px] text-ink-3">
                Daily counts come from Redash while auto mode is on. Switch to Manual above to enter
                them by hand.
              </p>
            )
          )}
        </div>
      )}
    </section>
  );
}

const invalidateReg = (qc: ReturnType<typeof useQueryClient>, ticketId: string) =>
  qc.invalidateQueries({ queryKey: ["programs", ticketId] });

const PRIVATE_ID = /^[CG][A-Z0-9]{8,}$/;

/** Slack won't let a bot join a private channel, so a person in it approves once and the bot is invited as them. */
function InviteBotLink({ ticketId, channelId }: { ticketId: string; channelId: string }) {
  const href = `${API_BASE_URL}/api/slack/invite/start?ticket_id=${encodeURIComponent(ticketId)}&channel_id=${encodeURIComponent(channelId)}`;
  return (
    <Button size="sm" variant="outline" asChild>
      <a href={href}>Add the bot to this private channel</a>
    </Button>
  );
}

function SlackChannelBox({ ticketId, data }: { ticketId: string; data: RegistrationsView }) {
  // Slack sends the person back here with the outcome in the address; show it once, then tidy the address.
  const [returned, setReturned] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const error = q.get("slack_error");
    if (!error && q.get("slack") !== "invited") return;
    setReturned(
      error
        ? { ok: false, text: error }
        : { ok: true, text: "The bot was added. Now add the channel ID below." },
    );
    q.delete("slack");
    q.delete("slack_error");
    window.history.replaceState(null, "", `${window.location.pathname}?${q.toString()}`);
  }, []);
  const qc = useQueryClient();
  const refresh = () => invalidateReg(qc, ticketId);
  const { channel_id, channel_name } = data.slack;
  const [editing, setEditing] = useState(!channel_id);
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<{
    state: "idle" | "loading" | "ok" | "error";
    text: string;
  }>({
    state: "idle",
    text: "",
  });

  useEffect(() => {
    const id = input.trim();
    if (!id) return setPreview({ state: "idle", text: "" });
    setPreview({ state: "loading", text: "" });
    let stale = false;
    const t = setTimeout(() => {
      lookupSlackChannel(ticketId, id)
        .then((r) => !stale && setPreview({ state: "ok", text: r.channel_name }))
        .catch((e) => !stale && setPreview({ state: "error", text: errMsg(e) }));
    }, 400);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [input, ticketId]);

  const save = useMutation({
    mutationFn: (id: string | null) => saveSlack(ticketId, { channel_id: id }),
    onSuccess: () => {
      setEditing(false);
      setInput("");
      void refresh();
    },
  });
  const test = useMutation({ mutationFn: () => testSlack(ticketId) });
  // Is the bot in the saved channel? A public channel can be joined from here; a private one needs /invite in Slack.
  const botStatus = useQuery({
    queryKey: ["programs", ticketId, "slack-status", channel_id],
    queryFn: () => lookupSlackChannel(ticketId, channel_id as string),
    enabled: !!channel_id && !editing && data.slack_configured,
    retry: false,
    staleTime: 30_000,
  });
  const join = useMutation({
    mutationFn: () => joinSlackChannel(ticketId),
    onSuccess: () => void botStatus.refetch(),
  });

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
      <span className="flex items-center gap-2 text-[14px] font-semibold">
        <Hash className="size-4 text-ink-3" />
        Slack channel
      </span>
      {data.slack_paused && <Chip>Slack messages are paused in the admin settings</Chip>}
      {!data.slack_configured && (
        <span className="text-[13px] text-danger">
          Slack isn't connected yet. Ask an admin to connect it.
        </span>
      )}
      {returned && (
        <span
          role="status"
          className={cn("basis-full text-[13px]", returned.ok ? "text-ok" : "text-danger")}
        >
          {returned.text}
        </span>
      )}
      {channel_id && !editing ? (
        <>
          <Chip tone="good">
            <Check className="size-3" />#{channel_name ?? channel_id}
          </Chip>
          <span className="t-data-sm text-ink-3">{channel_id}</span>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Change
          </Button>
          <Button size="sm" variant="ghost" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? "Sending…" : "Send test"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => save.mutate(null)}>
            Remove
          </Button>
          {botStatus.data &&
            (botStatus.data.is_member ? (
              <span className="text-[13px] text-ok">The bot is in this channel.</span>
            ) : botStatus.data.is_private ? (
              <>
                <span className="text-[13px] text-warn">
                  The bot isn't in this private channel.
                </span>
                <InviteBotLink ticketId={ticketId} channelId={channel_id as string} />
              </>
            ) : (
              <>
                <span className="text-[13px] text-warn">The bot isn't in this channel yet.</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={join.isPending}
                  onClick={() => join.mutate()}
                >
                  {join.isPending ? "Adding…" : "Add the bot"}
                </Button>
              </>
            ))}
          {join.isError && <span className="text-[13px] text-danger">{errMsg(join.error)}</span>}
          {test.isSuccess && <span className="text-[13px] text-ok">Test message sent.</span>}
          {test.isError && <span className="text-[13px] text-danger">{errMsg(test.error)}</span>}
        </>
      ) : (
        <>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (preview.state === "ok") save.mutate(input.trim());
            }}
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Channel ID, e.g. C0123456789"
              aria-label="Slack channel ID"
              className="w-60 font-mono"
            />
            <Button size="sm" type="submit" disabled={preview.state !== "ok" || save.isPending}>
              {save.isPending ? "Saving…" : "Add channel"}
            </Button>
            {channel_id && (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => {
                  setEditing(false);
                  setInput("");
                }}
              >
                Cancel
              </Button>
            )}
          </form>
          {!channel_id && (
            <p className="basis-full text-[13px] text-warn">
              Slack channel not added. Add one before posting updates.
            </p>
          )}
          {preview.state === "loading" && (
            <span className="flex items-center gap-1 text-[13px] text-ink-3">
              <Loader2 className="size-3 animate-spin" />
              Looking up…
            </span>
          )}
          {preview.state === "ok" && <span className="text-[13px] text-ok">→ #{preview.text}</span>}
          {preview.state === "error" && (
            <span className="text-[13px] text-danger">{preview.text}</span>
          )}
          {preview.state === "error" && PRIVATE_ID.test(input.trim()) && (
            <InviteBotLink ticketId={ticketId} channelId={input.trim()} />
          )}
          {save.isError && <span className="text-[13px] text-danger">{errMsg(save.error)}</span>}
        </>
      )}
    </div>
  );
}

function RedashBox({
  ticketId,
  data,
  requirement,
  onEditRequirement,
}: {
  ticketId: string;
  data: RegistrationsView;
  requirement: CandidateRequirement | null;
  onEditRequirement: () => void;
}) {
  const qc = useQueryClient();
  const canManage = useCan("registrations.manage");
  // The requirement travels with the slug, so it is an explicit choice: nothing is preselected.
  const [draft, setDraft] = useState<ReqDraft>(EMPTY_DRAFT);
  const yoe = draftYoe(draft);
  const refresh = () => invalidateReg(qc, ticketId);
  const { auto, event_slug, configured } = data.redash;
  const [slug, setSlug] = useState(event_slug ?? "");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const s = slug.trim();
  const events = useQuery({
    queryKey: ["redash-events"],
    queryFn: () => apiFetch<RedashEvent[]>(`/programs/${ticketId}/registrations/redash/events`),
    enabled: configured && !auto,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const picked = events.data?.find((e) => e.slug === s);
  const fail = (e: unknown) => setNotice({ ok: false, text: errMsg(e) });

  const check = useMutation({
    mutationFn: () => checkRedash(ticketId, s),
    onSuccess: () => setNotice(null),
    onError: fail,
  });
  const save = useMutation({
    mutationFn: (v: { auto: boolean; event_slug?: string; requirement?: CandidateRequirement }) =>
      saveRedash(ticketId, v),
    onSuccess: (_, v) => {
      setNotice(null);
      void refresh();
      if (v.auto) run.mutate();
    },
    onError: fail,
  });
  const run = useMutation({
    mutationFn: () => runRedash(ticketId),
    onSuccess: (r) => {
      setNotice({
        ok: !r.slack.error,
        text: fetchedText(r),
      });
      void refresh();
    },
    onError: fail,
  });

  return (
    <div id="reg-redash" className="scroll-mt-4 space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[14px] font-semibold">Registrations source</span>
        <Segmented
          value={auto ? "auto" : "manual"}
          onChange={(v) => v === "manual" && auto && save.mutate({ auto: false })}
          options={[
            { id: "manual", label: "Manual" },
            { id: "auto", label: "Auto (Redash)" },
          ]}
        />
        {!configured && (
          <span className="text-[13px] text-danger">
            Redash isn't connected yet. Ask an admin to connect it.
          </span>
        )}
      </div>
      {auto ? (
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="good">
            {data.redash.event_name ? `${data.redash.event_name} · ${event_slug}` : event_slug}
          </Chip>
          {requirement && (
            <>
              <Chip title="Who counts as relevant">{requirementLabel(requirement)}</Chip>
              {canManage && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Edit who counts as relevant"
                  onClick={onEditRequirement}
                  className="max-sm:min-h-11"
                >
                  <Pencil />
                </Button>
              )}
            </>
          )}
          <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Fetching…" : "Fetch from Redash"}
          </Button>
          {notice && (
            <span className={cn("text-[13px]", notice.ok ? "text-ok" : "text-danger")}>
              {notice.text}
            </span>
          )}
        </div>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (s) check.mutate();
          }}
        >
          <Input
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              check.reset();
              setNotice(null);
            }}
            placeholder="Pick an active event or type its slug"
            aria-label="Redash event slug"
            list={`events-${ticketId}`}
            className="w-96 max-w-full font-mono"
          />
          <datalist id={`events-${ticketId}`}>
            {(events.data ?? []).map((e) => (
              <option key={e.slug} value={e.slug}>
                {`${e.name ?? e.slug} · ${e.type ?? "Event"}${e.live ? " · live" : ""}`}
              </option>
            ))}
          </datalist>
          <Button
            size="sm"
            variant="outline"
            type="submit"
            disabled={!s || !configured || check.isPending}
          >
            {check.isPending ? "Checking…" : "Check"}
          </Button>
          {check.isSuccess && (
            <div className="flex basis-full flex-col gap-3 rounded-lg bg-raised p-3">
              <div>
                <MonoLabel>Is this the right event?</MonoLabel>
                <p className="text-[14px] font-semibold">{check.data.event.name}</p>
                <p className="text-[13px] text-ink-3">
                  {[
                    check.data.event.company,
                    check.data.event.type,
                    check.data.event.live ? "Live" : "Not live",
                    check.data.event.start && check.data.event.end
                      ? `${check.data.event.start.slice(0, 10)} to ${check.data.event.end.slice(0, 10)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="grid gap-4 border-t border-border pt-3">
                <p className="text-[13px] font-medium">Who counts as relevant?</p>
                <RequirementFields value={draft} onChange={setDraft} idPrefix="redash-req" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  type="button"
                  disabled={save.isPending || yoe === undefined}
                  onClick={() =>
                    yoe !== undefined &&
                    save.mutate({
                      auto: true,
                      event_slug: s,
                      requirement: { yoe, cities: draft.cities },
                    })
                  }
                  className="max-sm:min-h-11"
                >
                  {save.isPending ? "Saving…" : "Yes, use this event"}
                </Button>
                {yoe === undefined && (
                  <span className="text-[12px] text-ink-3">
                    Choose an experience option to continue.
                  </span>
                )}
              </div>
            </div>
          )}
          {picked && (
            <span className="text-[13px] text-ink-3">
              {picked.name} · {picked.company}
            </span>
          )}
          {events.isError && !notice && (
            <span className="text-[13px] text-ink-3">
              Couldn't load active events (VPN?). You can still type the slug.
            </span>
          )}
          {notice && (
            <span className={cn("text-[13px]", notice.ok ? "text-ok" : "text-danger")}>
              {notice.text}
            </span>
          )}
        </form>
      )}
    </div>
  );
}

function EntryEditor({
  ticketId,
  data,
  isHiring,
}: {
  ticketId: string;
  data: RegistrationsView;
  isHiring: boolean;
}) {
  const qc = useQueryClient();
  const refresh = () => invalidateReg(qc, ticketId);
  const { roles, fields, entries, slack } = data;
  const [form, setForm] = useState({
    date: todayKey(),
    role: "",
    registrations: "",
    relevant: "",
    extra: {} as Record<string, string>,
  });
  const [newRole, setNewRole] = useState("");
  const [newField, setNewField] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(
    null,
  );
  const role = form.role || roles[0] || "";

  const report = (r: SaveResult) => {
    const posted = r.slack.sent ? ` Posted to #${slack.channel_name}.` : "";
    setNotice(
      r.slack.error
        ? { tone: "warn", text: `Saved ${r.saved}. Slack notification failed: ${r.slack.error}` }
        : { tone: "ok", text: `Saved ${r.saved} ${r.saved === 1 ? "entry" : "entries"}.${posted}` },
    );
    void refresh();
  };
  const save = useMutation({
    mutationFn: (rows: Omit<RegistrationEntry, "id">[]) => saveRegistrations(ticketId, rows),
    onSuccess: report,
    onError: (e) => setNotice({ tone: "error", text: errMsg(e) }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteRegistration(ticketId, id),
    onSuccess: () => void refresh(),
  });
  const config = useMutation({
    mutationFn: (c: { roles: string[]; fields: string[] }) =>
      saveRegistrationConfig(ticketId, c.roles, c.fields),
    onSuccess: () => void refresh(),
  });
  const notify = useMutation({
    mutationFn: (on: boolean) => saveSlack(ticketId, { notify: on }),
    onSuccess: () => void refresh(),
  });

  const needsRole = isHiring && roles.length === 0;
  const draft =
    form.date && form.registrations !== "" && form.relevant !== "" && !needsRole
      ? [
          {
            date: form.date,
            role: isHiring ? role : "",
            registrations: Number(form.registrations),
            relevant: Number(form.relevant),
            extra: form.extra,
          },
        ]
      : null;
  const add = () => {
    if (!draft) return;
    save.mutate(draft);
    setForm({ ...form, registrations: "", relevant: "", extra: {} });
  };

  const draftKey = JSON.stringify(draft);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!draft) return setPreview(null);
    let stale = false;
    const t = setTimeout(() => {
      previewSlackMessage(ticketId, draft)
        .then((r) => !stale && setPreview(r.text))
        .catch(() => !stale && setPreview(null));
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, ticketId]);

  const importCsv = async (file: File) => {
    const lines = (await file.text()).trim().split(/\r?\n/);
    const head = (lines.shift() ?? "").split(",").map((h) => h.trim().toLowerCase());
    const known = ["date", "role", "registrations", "relevant"];
    const extraCols = head.filter((h) => !known.includes(h));
    const isCount = (v: string) => /^\d+$/.test(v);
    const rows: Omit<RegistrationEntry, "id">[] = [];
    for (const [i, l] of lines.entries()) {
      if (!l.trim()) continue;
      const c = l.split(",").map((x) => x.trim());
      const get = (k: string) => c[head.indexOf(k)] ?? "";
      const row = {
        date: get("date"),
        role: get("role"),
        registrations: Number(get("registrations")),
        relevant: Number(get("relevant")),
        extra: Object.fromEntries(extraCols.map((k) => [k, get(k)])),
      };
      const bad = !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
        ? "date must be YYYY-MM-DD"
        : !isCount(get("registrations")) || !isCount(get("relevant"))
          ? "registrations and relevant are required numbers"
          : row.relevant > row.registrations
            ? "relevant can't exceed registrations"
            : isHiring && !row.role
              ? "role is required"
              : null;
      if (bad)
        return setNotice({ tone: "error", text: `CSV not imported. Line ${i + 2}: ${bad}.` });
      rows.push({ ...row, role: isHiring ? row.role : "" });
    }
    if (!rows.length)
      return setNotice({ tone: "error", text: "CSV not imported: no data rows found." });
    save.mutate(rows);
  };

  return (
    <div className="space-y-4 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-semibold">Update registrations</h3>
          <p className="text-[13px] text-ink-3">
            Add daily counts manually or upload a CSV (date, {isHiring ? "role, " : ""}registrations
            and relevant are required, plus any extra columns).
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <label className="cursor-pointer">
            <Upload />
            Upload CSV
            <input
              type="file"
              accept=".csv"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importCsv(f);
                e.target.value = "";
              }}
            />
          </label>
        </Button>
      </div>
      {slack.notify && !slack.channel_id && (
        <p className="text-[13px] text-ink-3">
          Notify Slack is on, but no channel is set. Nothing will be posted until you add one above.
        </p>
      )}
      {notice && (
        <p
          className={cn(
            "text-[13px]",
            notice.tone === "ok" ? "text-ok" : notice.tone === "warn" ? "text-warn" : "text-danger",
          )}
        >
          {notice.text}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {isHiring && (
          <div>
            <MonoLabel className="mb-2 flex items-center gap-1.5">
              <UsersRound className="size-3.5" />
              Roles
            </MonoLabel>
            <div className="flex flex-wrap gap-1.5">
              {roles.map((r) => (
                <RemovableChip
                  key={r}
                  label={r}
                  onRemove={() => config.mutate({ roles: roles.filter((x) => x !== r), fields })}
                />
              ))}
            </div>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v = newRole.trim();
                if (v && !roles.includes(v)) config.mutate({ roles: [...roles, v], fields });
                setNewRole("");
              }}
            >
              <Input
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                placeholder="Add a role, e.g. DevOps Engineer"
                aria-label="New role"
              />
              <Button size="icon" variant="secondary" type="submit" aria-label="Add role">
                <Plus />
              </Button>
            </form>
          </div>
        )}
        <div>
          <MonoLabel className="mb-2 block">Extra fields</MonoLabel>
          <div className="flex flex-wrap gap-1.5">
            {fields.length ? (
              fields.map((f) => (
                <RemovableChip
                  key={f}
                  label={f}
                  onRemove={() => config.mutate({ roles, fields: fields.filter((x) => x !== f) })}
                />
              ))
            ) : (
              <span className="text-[13px] text-ink-3">
                None yet. Add things like "Source", "Shortlisted" or "Colleges".
              </span>
            )}
          </div>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = newField.trim();
              if (v && !fields.includes(v)) config.mutate({ roles, fields: [...fields, v] });
              setNewField("");
            }}
          >
            <Input
              value={newField}
              onChange={(e) => setNewField(e.target.value)}
              placeholder="Add a field"
              aria-label="New field"
            />
            <Button size="icon" variant="secondary" type="submit" aria-label="Add field">
              <Plus />
            </Button>
          </form>
        </div>
      </div>

      {needsRole && (
        <p className="text-[13px] text-warn">
          Hiring programs track registrations per role. Add at least one role above (e.g. Software
          Engineer) to start adding daily counts.
        </p>
      )}
      <form
        className="flex flex-wrap items-end gap-2 rounded-lg bg-raised p-3"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Field label="Date">
          <Input
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className="w-36"
          />
        </Field>
        {isHiring && (
          <Field label="Role">
            <select
              value={role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="h-8 rounded-[8px] border border-input bg-card px-2 text-[14px]"
            >
              {roles.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Registrations">
          <Input
            type="number"
            min={0}
            value={form.registrations}
            onChange={(e) => setForm({ ...form, registrations: e.target.value })}
            className="w-28"
          />
        </Field>
        <Field label="Relevant">
          <Input
            type="number"
            min={0}
            required
            value={form.relevant}
            onChange={(e) => setForm({ ...form, relevant: e.target.value })}
            className="w-24"
          />
        </Field>
        {fields.map((f) => (
          <Field key={f} label={f}>
            <Input
              value={form.extra[f] ?? ""}
              onChange={(e) => setForm({ ...form, extra: { ...form.extra, [f]: e.target.value } })}
              className="w-28"
            />
          </Field>
        ))}
        <Button
          size="sm"
          type="button"
          variant={slack.notify ? "default" : "outline"}
          aria-pressed={slack.notify}
          disabled={notify.isPending}
          onClick={() => notify.mutate(!slack.notify)}
          title={
            slack.channel_id
              ? `Post to #${slack.channel_name} when you click Add`
              : "Set a Slack channel above to receive notifications"
          }
        >
          {slack.notify ? <Bell /> : <BellOff />}Notify Slack
        </Button>
        <Button size="sm" type="submit" disabled={save.isPending || needsRole}>
          <Plus />
          {save.isPending ? "Saving…" : "Add"}
        </Button>
      </form>
      {preview && (
        <div className="rounded-lg border border-border p-3">
          <MonoLabel className="mb-2 block">
            Slack message preview
            {slack.notify && slack.channel_id
              ? ` · will post to #${slack.channel_name}`
              : slack.notify
                ? " · no channel set, won't post"
                : " · Notify Slack is off, won't post"}
          </MonoLabel>
          <pre className="whitespace-pre-wrap font-sans text-[14px]">{preview}</pre>
        </div>
      )}

      <div className="max-h-72 overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-[420px]">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-border">
              <th className="t-th p-2 text-left">Date</th>
              {isHiring && <th className="t-th p-2 text-left">Role</th>}
              <th className="t-th p-2 text-right">Registrations</th>
              <th className="t-th p-2 text-right">Relevant</th>
              {fields.map((f) => (
                <th key={f} className="t-th p-2 text-left">
                  {f}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-border last:border-0">
                <td className="t-data-sm p-2">{fmt(e.date)}</td>
                {isHiring && <td className="p-2 text-[14px]">{e.role || "-"}</td>}
                <td className="t-data-sm p-2 text-right">{e.registrations.toLocaleString()}</td>
                <td className="t-data-sm p-2 text-right">{e.relevant?.toLocaleString() ?? "—"}</td>
                {fields.map((f) => (
                  <td key={f} className="p-2 text-[14px] text-ink-3">
                    {e.extra[f] || "-"}
                  </td>
                ))}
                <td className="p-2">
                  <button
                    type="button"
                    aria-label={`Delete ${e.date} row`}
                    onClick={() => remove.mutate(e.id)}
                    className="text-ink-3 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RemovableChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Chip>
      {label}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="text-ink-3 hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </Chip>
  );
}

/** Chart animation only when the person has not asked for reduced motion. */
function motionOk(): boolean {
  return (
    typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
