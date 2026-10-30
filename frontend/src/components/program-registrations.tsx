import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  Bar,
  Card,
  CardBody,
  CardHeader,
  Chip,
  EmptyState,
  Kpi,
  MonoLabel,
  Num,
  Segmented,
  Skeleton,
  type Tone,
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
  addRelevant,
  liftQuery,
  refreshSources,
  registrationsViewQuery,
  relevantQuery,
  saveTargets,
  sourcesQuery,
  supersedeRelevant,
  type Lift,
  type RegistrationsView,
  type RelevantEntry,
  type SourceLine,
  type Sources,
} from "@/lib/registrations-api";
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
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

type SubView = "pace" | "sources" | "relevant";

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
  const canManage = useCan("registrations.manage");
  const canLink = useCan("integrations.link");
  const [view, setView] = useState<SubView>("pace");
  const [editTargets, setEditTargets] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const sync = useMutation({
    mutationFn: () => runRedash(ticketId),
    onSuccess: (r) => {
      setNotice({
        ok: !r.slack.error,
        text: `Fetched ${r.saved} ${r.saved === 1 ? "entry" : "entries"} from Redash.${r.slack.error ? ` Slack failed: ${r.slack.error}` : ""}`,
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
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[104px]" />
          ))}
        </div>
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<SubView>
          value={view}
          onChange={setView}
          options={[
            { id: "pace", label: "Daily Pace & Velocity" },
            { id: "sources", label: "Sources & Attribution" },
            { id: "relevant", label: "Relevant Registrations (CSM)" },
          ]}
          className="max-w-full overflow-x-auto"
        />
        <div className="flex flex-wrap items-center gap-2">
          {redashEnabled && slug && (
            <Chip tone={data.redash.auto ? "info" : "neutral"}>
              Redash #{slug} · synced {timeAgo(status.data?.redash_registrations_synced_at)}
            </Chip>
          )}
          {redashEnabled && canLink && slug && (
            <Button size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
              <RefreshCw className={cn(sync.isPending && "animate-spin")} />
              {sync.isPending ? "Syncing…" : "Sync Redash now"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={exportEntries}
            disabled={!data.entries.length}
          >
            <Download />
            Export CSV
          </Button>
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => setEditTargets(true)}>
              <Pencil />
              Edit target / dates
            </Button>
          )}
        </div>
      </div>
      {notice && (
        <p
          className={cn("t-body-sm", notice.ok ? "text-status-good" : "text-status-critical")}
          role="status"
        >
          {notice.text}
        </p>
      )}

      <KpiStrip data={data} sources={sources.data} />
      <TimelineLine data={data} />

      {view === "pace" && <PacePanel ticketId={ticketId} data={data} isHiring={isHiring} />}
      {view === "sources" && <SourcesPanel ticketId={ticketId} />}
      {view === "relevant" && <RelevantPanel ticketId={ticketId} data={data} />}

      {(canManage || canLink) && (
        <Integrations
          ticketId={ticketId}
          data={data}
          isHiring={isHiring}
          redashEnabled={redashEnabled}
          canManage={canManage}
          canLink={canLink}
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

// ---- KPI strip -----------------------------------------------------------------------------

function KpiStrip({ data, sources }: { data: RegistrationsView; sources: Sources | undefined }) {
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
  const paceTone: Tone | null = expected ? (raw >= expected ? "good" : "warning") : null;

  const report = sources?.report;
  const campaignCount = report?.lines.filter((l) => l.bucket === "activity").length ?? 0;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi
        index={0}
        label="Total registrations"
        value={<Num value={raw} />}
        unit={target ? `/ ${target.toLocaleString()} target` : "no target set"}
        sub={
          <div className="space-y-1.5">
            {target ? (
              <>
                <Bar pct={pctTarget ?? 0} />
                <div className="flex justify-between">
                  <span>
                    {latest != null
                      ? `+${latest.toLocaleString()} on ${fmt(latestDate)}`
                      : "No days yet"}
                  </span>
                  <span>{pctTarget}% of target</span>
                </div>
              </>
            ) : (
              <span>
                {latest != null
                  ? `+${latest.toLocaleString()} on ${fmt(latestDate)}`
                  : "No days yet"}
              </span>
            )}
          </div>
        }
      />
      <Kpi
        index={1}
        label="Relevant registrations"
        tone="indigo"
        value={<Num value={data.relevant_total} />}
        unit={raw ? `${Math.round((data.relevant_total / raw) * 1000) / 10}% of raw` : undefined}
        sub="CSM-entered. Kept apart, never summed into the raw count."
      />
      <Kpi
        index={2}
        label="Runway & pacing"
        value={
          daysLeft != null ? (
            <Num value={daysLeft} />
          ) : rate ? (
            <Num value={Math.round(rate)} />
          ) : (
            "—"
          )
        }
        unit={
          daysLeft != null
            ? `days left${est.end ? ` · ends ${fmt(est.end)}` : ""}`
            : rate
              ? "/ day average"
              : undefined
        }
        chip={
          paceTone && (
            <Chip tone={paceTone}>{paceTone === "good" ? "Ahead of pace" : "Behind pace"}</Chip>
          )
        }
        sub={
          daysLeft == null && !rate ? (
            "Needs a campaign window or some daily counts."
          ) : (
            <div className="space-y-0.5">
              {required != null && <div>Required: {required.toLocaleString()} / day</div>}
              {needed === 0 && <div>Target reached</div>}
              {projected && needed !== 0 && (
                <div>
                  Projected finish: {fmt(projected)}
                  {slip != null &&
                    slip !== 0 &&
                    ` (${Math.abs(slip)}d ${slip > 0 ? "early" : "late"})`}
                </div>
              )}
              {expected != null && <div>Expected by today: ~{expected.toLocaleString()}</div>}
            </div>
          )
        }
      />
      <Kpi
        index={3}
        label="Attribution snapshot"
        value={report ? <Num value={report.organic_pct} decimals={1} /> : "—"}
        unit={report ? "% organic" : undefined}
        sub={
          report
            ? `${campaignCount} campaign ${campaignCount === 1 ? "source" : "sources"} · fetched ${timeAgo(sources?.fetched_at)}`
            : "No attribution snapshot yet."
        }
      />
    </div>
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
      <p className="t-body-sm text-muted-foreground">
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
    <p className="t-body-sm text-secondary-foreground">
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
          <span className="text-muted-foreground">
            (start from {source}
            {!est.end_is_actual && est.end ? ", end estimated" : ""})
          </span>
        </>
      ) : (
        "Start date unknown: link the HackerEarth event or add the first day's count to anchor it."
      )}
      {weeks && <span className="text-muted-foreground"> · SOW: {weeks} window</span>}
    </p>
  );
}

// ---- Daily pace chart ------------------------------------------------------------------

type DayRow = {
  date: string;
  daily: number;
  cum: number | null;
  pace: number | null;
  acts: PoaActivity[];
  live: Activity[];
};

function PacePanel({
  ticketId,
  data,
  isHiring,
}: {
  ticketId: string;
  data: RegistrationsView;
  isHiring: boolean;
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

  return (
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 t-body-sm text-secondary-foreground">
            <Legend swatch={<span className="h-0.5 w-4 bg-accent-fill" />}>
              Actual cumulative
            </Legend>
            <Legend swatch={<span className="size-2.5 rounded-sm bg-chart-5/40" />}>
              Daily volume
            </Legend>
            {hasPace && (
              <Legend
                swatch={<span className="w-4 border-t border-dashed border-muted-foreground" />}
              >
                Target pace
              </Legend>
            )}
            {goLives.length > 0 && (
              <Legend swatch={<span className="h-3 w-0 border-l border-dashed border-chart-2" />}>
                Marketing go-live
              </Legend>
            )}
          </div>
          {isHiring && data.roles.length > 0 && (
            <Segmented
              value={role}
              onChange={setRole}
              options={[
                { id: "all", label: "All roles" },
                ...data.roles.map((r) => ({ id: r, label: r })),
              ]}
              className="max-w-full overflow-x-auto"
            />
          )}
        </div>

        {!rows.length ? (
          <EmptyState
            title="No registrations yet"
            hint="Daily counts appear here once Redash syncs or someone adds the first day."
          />
        ) : asTable ? (
          <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
            <table className="w-full min-w-[420px]">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border">
                  <th className="t-th p-2.5 text-left">Date</th>
                  <th className="t-th p-2.5 text-right">Daily</th>
                  <th className="t-th p-2.5 text-right">Cumulative</th>
                  {hasPace && <th className="t-th p-2.5 text-right">Target pace</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.date} className="border-b border-border last:border-0">
                    <td className="t-data-sm p-2.5">{fmtLong(r.date)}</td>
                    <td className="t-data-sm p-2.5 text-right">{r.daily.toLocaleString()}</td>
                    <td className="t-data-sm p-2.5 text-right">{r.cum?.toLocaleString() ?? "—"}</td>
                    {hasPace && (
                      <td className="t-data-sm p-2.5 text-right">
                        {r.pace?.toLocaleString() ?? "—"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div
            className="h-[340px]"
            role="img"
            aria-label="Cumulative and daily registrations against target pace"
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid
                  vertical={false}
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={fmt}
                  minTickGap={32}
                  tick={{
                    fontSize: 11,
                    fill: "var(--color-muted-foreground)",
                    fontFamily: "inherit",
                  }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={compact}
                  domain={[0, (m: number) => Math.ceil(m * 1.08)]}
                  tick={{
                    fontSize: 11,
                    fill: "var(--color-muted-foreground)",
                    fontFamily: "inherit",
                  }}
                  axisLine={false}
                  tickLine={false}
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
                  fill="var(--color-chart-5)"
                  fillOpacity={0.35}
                  maxBarSize={20}
                  radius={[3, 3, 0, 0]}
                  animationDuration={600}
                />
                {hasPace && (
                  <Line
                    dataKey="pace"
                    type="linear"
                    stroke="var(--color-muted-foreground)"
                    strokeDasharray="5 4"
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={false}
                    isAnimationActive={false}
                  />
                )}
                <Line
                  dataKey="cum"
                  type="monotone"
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  animationDuration={900}
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
          <p className="t-body-sm text-muted-foreground">
            Go-live markers unavailable: {errMsg(activities.error)}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function Legend({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {swatch}
      {children}
    </span>
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
      {d.cum != null && <p className="t-data-sm">Cumulative: {d.cum.toLocaleString()}</p>}
      {ahead != null && (
        <p className={cn("t-data-sm", ahead >= 0 ? "text-status-good" : "text-status-warning")}>
          {ahead >= 0 ? "+" : ""}
          {ahead.toLocaleString()} {ahead >= 0 ? "ahead of" : "behind"} pace
        </p>
      )}
      {(d.live.length > 0 || d.acts.length > 0) && (
        <div className="mt-2 space-y-0.5 border-t border-border pt-2 t-body-sm">
          {d.live.map((a) => (
            <p key={`l${a.id}`}>
              <span className="text-status-good">Went live:</span> {a.title}
            </p>
          ))}
          {d.acts.map((a) => (
            <p key={a.activity} className="text-muted-foreground">
              Planned: {a.activity} · {a.channel}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Sources & attribution -------------------------------------------------------------

const ACCENTS = ["chart-1", "chart-5", "chart-6", "chart-2", "chart-3", "chart-7", "chart-8"];

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
        <p className="t-body-sm text-secondary-foreground">
          {s?.fetched_at
            ? `Snapshot fetched ${timeAgo(s.fetched_at)}${s.stale ? " (stale)" : ""}. `
            : ""}
          Organic and unmatched sources stay neutral grey; campaign UTMs get a colour and a lift
          figure.
        </p>
        {(s?.error || refresh.isError) && (
          <p className="t-body-sm text-status-critical" role="alert">
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
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead>
                  <tr className="border-b border-border">
                    <th className="t-th p-2.5 text-left">Source / UTM campaign</th>
                    <th className="t-th p-2.5 text-right">Registrations</th>
                    <th className="t-th p-2.5 text-right">Share</th>
                    <th className="t-th p-2.5 text-right">Lift</th>
                  </tr>
                </thead>
                <tbody className="reveal">
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
            <div className="flex flex-wrap items-start justify-between gap-2 t-body-sm text-muted-foreground">
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
  const accent = ACCENTS[i % ACCENTS.length]!;
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
                  ? "var(--color-muted-foreground)"
                  : "var(--color-status-neutral)"
                : `var(--color-${accent})`,
            }}
          />
          <div className="min-w-0">
            <p className={cn("t-data-md truncate", neutral && "text-secondary-foreground")}>
              {title}
            </p>
            <p className="t-data-sm truncate text-muted-foreground">{line.source_medium}</p>
          </div>
        </div>
      </td>
      <td className="t-data-md p-2.5 text-right">{line.users.toLocaleString()}</td>
      <td className="t-data-sm p-2.5 text-right text-secondary-foreground">
        {line.share_pct.toFixed(1)}%
      </td>
      <td className="p-2.5 text-right">
        {neutral ? (
          <span className="t-data-sm text-muted-foreground">
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
          <span className="t-data-sm text-muted-foreground">N/A</span>
        )}
      </td>
    </tr>
  );
}

// ---- Relevant registrations (CSM) -----------------------------------------------------------

function RelevantPanel({ ticketId, data }: { ticketId: string; data: RegistrationsView }) {
  const qc = useQueryClient();
  const canEnter = useCan("relevant.enter");
  const q = useQuery(relevantQuery(ticketId));
  const [form, setForm] = useState({ date: todayKey(), count: "", criteria: "", note: "" });
  const [fixing, setFixing] = useState<{ id: number; count: string; note: string } | null>(null);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["programs", ticketId, "relevant"] });
    void qc.invalidateQueries({ queryKey: ["programs", ticketId, "registrations"] });
  };
  const add = useMutation({
    mutationFn: () =>
      addRelevant(ticketId, {
        date: form.date,
        count: Number(form.count),
        criteria: form.criteria.trim() || null,
        note: form.note.trim() || null,
      }),
    onSuccess: () => {
      setForm({ ...form, count: "", note: "" });
      done();
    },
  });
  const fix = useMutation({
    mutationFn: (e: RelevantEntry) =>
      supersedeRelevant(ticketId, e.id, {
        count: Number(fixing?.count),
        criteria: e.criteria,
        note: fixing?.note.trim() || null,
      }),
    onSuccess: () => {
      setFixing(null);
      done();
    },
  });
  const entries = useMemo(
    () => [...(q.data?.entries ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id),
    [q.data],
  );
  const validCount =
    form.count !== "" && Number(form.count) >= 0 && Number.isInteger(Number(form.count));

  return (
    <Card>
      <CardHeader title="Relevant registrations" meta={<Chip tone="indigo">CSM managed</Chip>} />
      <CardBody className="space-y-4">
        <p className="t-body-sm text-secondary-foreground">
          Relevant counts are the CSM's own pre-screened numbers. They are stored apart from the
          Redash raw total ({data.raw_total.toLocaleString()}) and never added to it. Entries are
          append-only; a correction supersedes the old entry.
        </p>

        {canEnter && (
          <form
            className="grid gap-3 rounded-lg bg-secondary/50 p-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (validCount) add.mutate();
            }}
          >
            <Field label="Date of evaluation">
              <Input
                type="date"
                required
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </Field>
            <Field label="New relevant count">
              <Input
                type="number"
                min={0}
                required
                value={form.count}
                onChange={(e) => setForm({ ...form, count: e.target.value })}
                className="font-mono"
              />
            </Field>
            <Field label="Criteria (optional)">
              <Input
                value={form.criteria}
                onChange={(e) => setForm({ ...form, criteria: e.target.value })}
              />
            </Field>
            <Field label="Audit note (optional)">
              <Input
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <Button type="submit" disabled={!validCount || add.isPending}>
                <Check />
                {add.isPending ? "Recording…" : "Record relevant entry"}
              </Button>
              {add.isError && (
                <span className="t-body-sm text-status-critical">{errMsg(add.error)}</span>
              )}
            </div>
          </form>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <MonoLabel>Recent validations</MonoLabel>
            <MonoLabel>Verified by</MonoLabel>
          </div>
          {q.isLoading ? (
            <Skeleton className="h-32" />
          ) : q.isError ? (
            <EmptyState
              title="Couldn't load the log"
              hint={errMsg(q.error)}
              action={
                <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
                  Retry
                </Button>
              }
            />
          ) : !entries.length ? (
            <EmptyState
              title="No relevant entries yet"
              hint="The CSM records validated counts here."
            />
          ) : (
            <ul className="reveal space-y-1.5">
              {entries.map((e, i) => (
                <li
                  key={e.id}
                  className="rounded-lg bg-secondary/50 p-2.5"
                  style={{ ["--i" as string]: i }}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="t-data-sm text-muted-foreground">{fmtLong(e.date)}</span>
                    <span className="t-data-sm text-primary">
                      +{e.count.toLocaleString()} relevant
                    </span>
                    <span className="t-body-sm text-secondary-foreground">{e.entered_by_name}</span>
                  </div>
                  <p className="mt-0.5 t-body-sm">
                    {[e.criteria, e.note].filter(Boolean).join(" · ") || (
                      <span className="text-muted-foreground">No note</span>
                    )}
                    {e.supersedes_id != null && (
                      <span className="text-muted-foreground"> (corrects #{e.supersedes_id})</span>
                    )}
                  </p>
                  {canEnter &&
                    (fixing?.id === e.id ? (
                      <form
                        className="mt-2 flex flex-wrap items-center gap-2"
                        onSubmit={(ev) => {
                          ev.preventDefault();
                          if (fixing.count !== "") fix.mutate(e);
                        }}
                      >
                        <Input
                          type="number"
                          min={0}
                          aria-label="Corrected count"
                          value={fixing.count}
                          onChange={(ev) => setFixing({ ...fixing, count: ev.target.value })}
                          className="w-28"
                        />
                        <Input
                          aria-label="Correction note"
                          placeholder="Why the correction"
                          value={fixing.note}
                          onChange={(ev) => setFixing({ ...fixing, note: ev.target.value })}
                          className="min-w-40 flex-1"
                        />
                        <Button size="sm" type="submit" disabled={fix.isPending}>
                          Save
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => setFixing(null)}
                        >
                          Cancel
                        </Button>
                        {fix.isError && (
                          <span className="t-body-sm text-status-critical">
                            {errMsg(fix.error)}
                          </span>
                        )}
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="mt-1 t-body-sm text-primary hover:underline"
                        onClick={() => setFixing({ id: e.id, count: String(e.count), note: "" })}
                      >
                        Correct
                      </button>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <span className="t-data-sm">
            Total relevant:{" "}
            <span className="text-primary">
              {(q.data?.total ?? data.relevant_total).toLocaleString()}
            </span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!entries.length}
            onClick={() =>
              downloadCsv("relevant-registrations-audit.csv", [
                [
                  "id",
                  "date",
                  "count",
                  "criteria",
                  "note",
                  "entered_by",
                  "entered_at",
                  "supersedes_id",
                ],
                ...entries.map((e) => [
                  e.id,
                  e.date,
                  e.count,
                  e.criteria,
                  e.note,
                  e.entered_by_name,
                  e.entered_at,
                  e.supersedes_id,
                ]),
              ])
            }
          >
            <Download />
            Download audit CSV
          </Button>
        </div>
      </CardBody>
    </Card>
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
              className="font-mono"
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
          {save.isError && <p className="t-body-sm text-status-critical">{errMsg(save.error)}</p>}
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
  ticketId,
  data,
  isHiring,
  redashEnabled,
  canManage,
  canLink,
}: {
  ticketId: string;
  data: RegistrationsView;
  isHiring: boolean;
  redashEnabled: boolean;
  canManage: boolean;
  canLink: boolean;
}) {
  const [open, setOpen] = useState(false);
  const manualOk = canManage && (!redashEnabled || !data.redash.auto);
  return (
    <section className="surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-[18px] py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>
          <span className="block text-[16px] font-semibold tracking-[-0.01em]">
            Data entry &amp; integrations
          </span>
          <span className="t-body-sm text-muted-foreground">
            Manual daily counts, Slack channel, Redash event
          </span>
        </span>
        <ChevronDown
          className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="space-y-4 border-t border-border p-[18px]">
          {canLink && <SlackChannelBox ticketId={ticketId} data={data} />}
          {canLink && redashEnabled && <RedashBox ticketId={ticketId} data={data} />}
          {manualOk ? (
            <EntryEditor ticketId={ticketId} data={data} isHiring={isHiring} />
          ) : (
            canManage && (
              <p className="t-body-sm text-muted-foreground">
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
        <Hash className="size-4 text-muted-foreground" />
        Slack channel
      </span>
      {!data.slack_configured && (
        <span className="t-body-sm text-status-critical">
          Slack isn't connected yet. Ask an admin to connect it.
        </span>
      )}
      {returned && (
        <span
          role="status"
          className={cn(
            "basis-full t-body-sm",
            returned.ok ? "text-status-good" : "text-status-critical",
          )}
        >
          {returned.text}
        </span>
      )}
      {channel_id && !editing ? (
        <>
          <Chip tone="good">
            <Check className="size-3" />#{channel_name ?? channel_id}
          </Chip>
          <span className="t-data-sm text-muted-foreground">{channel_id}</span>
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
              <span className="t-body-sm text-status-good">The bot is in this channel.</span>
            ) : botStatus.data.is_private ? (
              <>
                <span className="t-body-sm text-status-warning">
                  The bot isn't in this private channel.
                </span>
                <InviteBotLink ticketId={ticketId} channelId={channel_id as string} />
              </>
            ) : (
              <>
                <span className="t-body-sm text-status-warning">
                  The bot isn't in this channel yet.
                </span>
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
          {join.isError && (
            <span className="t-body-sm text-status-critical">{errMsg(join.error)}</span>
          )}
          {test.isSuccess && <span className="t-body-sm text-status-good">Test message sent.</span>}
          {test.isError && (
            <span className="t-body-sm text-status-critical">{errMsg(test.error)}</span>
          )}
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
            <p className="basis-full t-body-sm text-status-warning">
              Slack channel not added. Add one before posting updates.
            </p>
          )}
          {preview.state === "loading" && (
            <span className="flex items-center gap-1 t-body-sm text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Looking up…
            </span>
          )}
          {preview.state === "ok" && (
            <span className="t-body-sm text-status-good">→ #{preview.text}</span>
          )}
          {preview.state === "error" && (
            <span className="t-body-sm text-status-critical">{preview.text}</span>
          )}
          {preview.state === "error" && PRIVATE_ID.test(input.trim()) && (
            <InviteBotLink ticketId={ticketId} channelId={input.trim()} />
          )}
          {save.isError && (
            <span className="t-body-sm text-status-critical">{errMsg(save.error)}</span>
          )}
        </>
      )}
    </div>
  );
}

function RedashBox({ ticketId, data }: { ticketId: string; data: RegistrationsView }) {
  const qc = useQueryClient();
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
    mutationFn: (v: { auto: boolean; event_slug?: string }) => saveRedash(ticketId, v),
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
        text: `Fetched ${r.saved} ${r.saved === 1 ? "entry" : "entries"} from Redash.${r.slack.sent ? " Posted to Slack." : ""}${r.slack.error ? ` Slack failed: ${r.slack.error}` : ""}`,
      });
      void refresh();
    },
    onError: fail,
  });

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
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
          <span className="t-body-sm text-status-critical">
            Redash isn't connected yet. Ask an admin to connect it.
          </span>
        )}
      </div>
      {auto ? (
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="good">
            {data.redash.event_name ? `${data.redash.event_name} · ${event_slug}` : event_slug}
          </Chip>
          <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Fetching…" : "Fetch from Redash"}
          </Button>
          {notice && (
            <span
              className={cn("t-body-sm", notice.ok ? "text-status-good" : "text-status-critical")}
            >
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
            <div className="flex basis-full flex-wrap items-center gap-3 rounded-lg bg-secondary/50 p-3">
              <div>
                <MonoLabel>Is this the right event?</MonoLabel>
                <p className="text-[14px] font-semibold">{check.data.event.name}</p>
                <p className="t-body-sm text-muted-foreground">
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
              <Button
                size="sm"
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate({ auto: true, event_slug: s })}
              >
                {save.isPending ? "Saving…" : "Yes, use this event"}
              </Button>
            </div>
          )}
          {picked && (
            <span className="t-body-sm text-muted-foreground">
              {picked.name} · {picked.company}
            </span>
          )}
          {events.isError && !notice && (
            <span className="t-body-sm text-muted-foreground">
              Couldn't load active events (VPN?). You can still type the slug.
            </span>
          )}
          {notice && (
            <span
              className={cn("t-body-sm", notice.ok ? "text-status-good" : "text-status-critical")}
            >
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
          <p className="t-body-sm text-muted-foreground">
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
        <p className="t-body-sm text-muted-foreground">
          Notify Slack is on, but no channel is set. Nothing will be posted until you add one above.
        </p>
      )}
      {notice && (
        <p
          className={cn(
            "t-body-sm",
            notice.tone === "ok"
              ? "text-status-good"
              : notice.tone === "warn"
                ? "text-status-warning"
                : "text-status-critical",
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
              <span className="t-body-sm text-muted-foreground">
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
        <p className="t-body-sm text-status-warning">
          Hiring programs track registrations per role. Add at least one role above (e.g. Software
          Engineer) to start adding daily counts.
        </p>
      )}
      <form
        className="flex flex-wrap items-end gap-2 rounded-lg bg-secondary/50 p-3"
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
                <td className="t-data-sm p-2 text-right">{e.registrations}</td>
                <td className="t-data-sm p-2 text-right">{e.relevant ?? "—"}</td>
                {fields.map((f) => (
                  <td key={f} className="p-2 text-[14px] text-muted-foreground">
                    {e.extra[f] || "-"}
                  </td>
                ))}
                <td className="p-2">
                  <button
                    type="button"
                    aria-label={`Delete ${e.date} row`}
                    onClick={() => remove.mutate(e.id)}
                    className="text-muted-foreground hover:text-status-critical focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </Chip>
  );
}
