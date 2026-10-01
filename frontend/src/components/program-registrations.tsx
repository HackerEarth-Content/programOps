import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Bell,
  BellOff,
  Check,
  Hash,
  Loader2,
  Megaphone,
  Plus,
  Trash2,
  Upload,
  UsersRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  checkRedash,
  deleteRegistration,
  lookupSlackChannel,
  previewSlackMessage,
  registrationsQueryOptions,
  runRedash,
  saveRedash,
  saveRegistrationConfig,
  saveRegistrations,
  saveSlack,
  testSlack,
  type RegistrationEntry,
  type Registrations,
  type SaveResult,
} from "@/lib/api";
import type { PoaActivity } from "@/lib/program-documents";
import { cn } from "@/lib/utils";

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("en", { day: "2-digit", month: "short" }).format(
    new Date(`${iso}T00:00:00`),
  );
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

export function ProgramRegistrations({
  ticketId,
  isHiring,
  activities,
}: {
  ticketId: string;
  isHiring: boolean;
  activities: PoaActivity[];
}) {
  const query = useQuery(registrationsQueryOptions(ticketId));
  const [roleFilter, setRoleFilter] = useState("all");
  const activityByDate = useMemo(() => {
    const m = new Map<string, PoaActivity[]>();
    activities.forEach((a) => m.set(a.date, [...(m.get(a.date) ?? []), a]));
    return m;
  }, [activities]);

  const data = query.data;
  const entries = useMemo(
    () => (data?.entries ?? []).filter((e) => roleFilter === "all" || e.role === roleFilter),
    [data, roleFilter],
  );
  const daily = useMemo(() => {
    const m = new Map<string, { date: string; registrations: number; relevant: number }>();
    entries.forEach((e) => {
      const d = m.get(e.date) ?? { date: e.date, registrations: 0, relevant: 0 };
      d.registrations += e.registrations;
      d.relevant += e.relevant;
      m.set(e.date, d);
    });
    activityByDate.forEach((_, date) => {
      if (!m.has(date)) m.set(date, { date, registrations: 0, relevant: 0 });
    });
    const rows = [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
    const max = Math.max(1, ...rows.map((r) => r.registrations));
    return rows.map((r) => ({
      ...r,
      label: fmt(r.date),
      rest: Math.max(0, r.registrations - r.relevant),
      marker: activityByDate.has(r.date) ? max * 1.1 : null,
      acts: activityByDate.get(r.date) ?? [],
    }));
  }, [entries, activityByDate]);

  if (query.isLoading)
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  if (query.isError || !data)
    return <p className="text-sm text-muted-foreground">Couldn't load registrations.</p>;

  const total = entries.reduce((s, e) => s + e.registrations, 0);
  const relevant = entries.reduce((s, e) => s + e.relevant, 0);
  const days = new Set(entries.map((e) => e.date)).size;
  const peak = daily.reduce(
    (a, b) => (b.registrations > a.registrations ? b : a),
    daily[0] ?? { registrations: 0, label: "-" },
  );

  return (
    <div className="space-y-4">
      <SlackChannelBox ticketId={ticketId} data={data} />
      <RedashBox ticketId={ticketId} data={data} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total registrations" value={total.toLocaleString()} />
        <Stat
          label="Relevant registrations"
          value={relevant.toLocaleString()}
          hint={total ? `${Math.round((relevant / total) * 100)}% of total` : undefined}
        />
        <Stat label="Peak day" value={peak.registrations.toLocaleString()} hint={peak.label} />
        <Stat
          label="Marketing activities"
          value={String(activities.length)}
          hint={`${days} days tracked`}
        />
      </div>

      <div className="workspace-panel p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">Registrations per day</h3>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className="inline-block size-2.5 rounded-full"
                style={{ background: "var(--color-warning)" }}
              />
              Dot = marketing activity that day (hover for details)
              <span className="ml-2 inline-block size-2.5 rounded-sm bg-primary" />
              Relevant
              <span className="inline-block size-2.5 rounded-sm bg-primary/25" />
              Other registrations
            </p>
          </div>
          {isHiring && data.roles.length > 0 && (
            <div className="flex flex-wrap gap-1 rounded-lg bg-secondary/60 p-1">
              {["all", ...data.roles].map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRoleFilter(r)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs transition",
                    roleFilter === r
                      ? "bg-card font-semibold text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {r === "all" ? "All roles" : r}
                </button>
              ))}
            </div>
          )}
        </div>
        {daily.length ? (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={daily} margin={{ top: 10, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid
                  vertical={false}
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, (m: number) => Math.ceil(m * 1.08)]}
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: "var(--color-secondary)", opacity: 0.5 }}
                  content={<ChartTip />}
                />
                {/* Stacked: bright relevant at the bottom, dim remainder above, so total height = registrations. */}
                <Bar
                  dataKey="relevant"
                  stackId="r"
                  fill="var(--color-primary)"
                  maxBarSize={28}
                  animationDuration={700}
                />
                <Bar
                  dataKey="rest"
                  stackId="r"
                  fill="var(--color-primary)"
                  fillOpacity={0.22}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={28}
                  animationDuration={700}
                />
                <Scatter
                  dataKey="marker"
                  fill="var(--color-warning)"
                  shape={(p: { cx?: number; cy?: number }) => (
                    <circle
                      cx={p.cx}
                      cy={p.cy}
                      r={6}
                      fill="var(--color-warning)"
                      stroke="var(--color-card)"
                      strokeWidth={2}
                    />
                  )}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No registrations added yet. Add the first day below.
          </p>
        )}
      </div>

      {!data.redash.auto && <EntryEditor ticketId={ticketId} data={data} isHiring={isHiring} />}
    </div>
  );
}

// ---- Slack channel box -------------------------------------------------------

function SlackChannelBox({ ticketId, data }: { ticketId: string; data: Registrations }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["programs", ticketId, "registrations"] });
  const { channel_id, channel_name } = data.slack;
  const [editing, setEditing] = useState(!channel_id);
  const [input, setInput] = useState("");
  // Preview of the typed id, resolved from Slack before anything is saved.
  const [preview, setPreview] = useState<{
    state: "idle" | "loading" | "ok" | "error";
    text: string;
  }>({ state: "idle", text: "" });

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

  return (
    <div className="workspace-panel flex flex-wrap items-center gap-3 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Hash className="size-4 text-muted-foreground" />
        Slack channel
      </div>
      {!data.slack_configured && (
        <span className="text-xs text-destructive">
          Slack isn't configured on the server (SLACK_BOT_TOKEN).
        </span>
      )}
      {channel_id && !editing ? (
        <>
          <span className="inline-flex items-center gap-2 rounded-md bg-success/10 px-2.5 py-1 text-sm text-success">
            <Check className="size-3.5" />#{channel_name ?? channel_id}
            <span className="font-mono text-[10px] text-muted-foreground">{channel_id}</span>
          </span>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Change
          </Button>
          <Button size="sm" variant="ghost" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? "Sending…" : "Send test"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => save.mutate(null)}>
            Remove
          </Button>
          {test.isSuccess && <span className="text-xs text-success">Test message sent.</span>}
          {test.isError && <span className="text-xs text-destructive">{errMsg(test.error)}</span>}
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
              className="h-8 w-60 font-mono text-sm"
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
            <p className="basis-full text-xs text-warning">
              Slack channel not added. Add one before posting updates.
            </p>
          )}
          {preview.state === "loading" && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Looking up…
            </span>
          )}
          {preview.state === "ok" && (
            <span className="text-sm text-success">→ #{preview.text}</span>
          )}
          {preview.state === "error" && (
            <span className="text-xs text-destructive">{preview.text}</span>
          )}
          {save.isError && <span className="text-xs text-destructive">{errMsg(save.error)}</span>}
        </>
      )}
    </div>
  );
}

// ---- Redash (auto mode) --------------------------------------------------------

function RedashBox({ ticketId, data }: { ticketId: string; data: Registrations }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["programs", ticketId, "registrations"] });
  const { auto, event_slug, configured } = data.redash;
  const [slug, setSlug] = useState(event_slug ?? "");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const s = slug.trim();
  const fail = (e: unknown) => setNotice({ ok: false, text: errMsg(e) });

  // Confirm = look the slug up in Redash first; auto is only switched on after it returns data.
  const check = useMutation({
    mutationFn: () => checkRedash(ticketId, s),
    onSuccess: (r) =>
      setNotice({
        ok: true,
        text: `Found ${r.rows} ${r.rows === 1 ? "row" : "rows"} (${fmt(r.from)} to ${fmt(r.to)}), ${r.registrations.toLocaleString()} registrations. Confirm to use auto.`,
      }),
    onError: fail,
  });
  const save = useMutation({
    mutationFn: (v: { auto: boolean; event_slug?: string }) => saveRedash(ticketId, v),
    onSuccess: () => {
      setNotice(null);
      void refresh();
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
    <div className="workspace-panel space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm font-semibold">Registrations source</div>
        <div className="inline-flex rounded-md border border-border p-0.5">
          <Button
            size="sm"
            variant={auto ? "ghost" : "default"}
            className="h-7"
            disabled={save.isPending}
            onClick={() => auto && save.mutate({ auto: false })}
          >
            Manual
          </Button>
          <Button size="sm" variant={auto ? "default" : "ghost"} className="h-7" disabled>
            Auto (Redash)
          </Button>
        </div>
        {!configured && (
          <span className="text-xs text-destructive">Redash isn't configured on the server.</span>
        )}
      </div>
      {auto ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-success/10 px-2.5 py-1 font-mono text-sm text-success">
            {event_slug}
          </span>
          <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Fetching…" : "Fetch from Redash"}
          </Button>
          {notice && (
            <span className={cn("text-xs", notice.ok ? "text-success" : "text-destructive")}>
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
            placeholder="Event slug, to fetch registrations automatically"
            className="h-8 w-80 font-mono text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            type="submit"
            disabled={!s || !configured || check.isPending}
          >
            {check.isPending ? "Checking…" : "Check"}
          </Button>
          {check.isSuccess && (
            <Button
              size="sm"
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate({ auto: true, event_slug: s })}
            >
              Confirm and use auto
            </Button>
          )}
          {notice && (
            <span className={cn("text-xs", notice.ok ? "text-success" : "text-destructive")}>
              {notice.text}
            </span>
          )}
        </form>
      )}
    </div>
  );
}

// ---- Stats / chart tooltip -----------------------------------------------------

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="workspace-panel p-4">
      <p className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ChartTip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{
    payload: { label: string; registrations: number; relevant: number; acts: PoaActivity[] };
  }>;
}) {
  const d = active ? payload?.[0]?.payload : undefined;
  if (!d) return null;
  return (
    <div className="max-w-64 rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
      <p className="font-semibold">{d.label}</p>
      <p className="mt-1">
        Registrations: <span className="font-mono font-semibold">{d.registrations}</span>
      </p>
      <p>
        Relevant: <span className="font-mono font-semibold">{d.relevant}</span>
      </p>
      {d.acts.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          {d.acts.map((a) => (
            <p key={a.activity} className="flex items-center gap-1.5">
              <Megaphone className="size-3" style={{ color: "var(--color-warning)" }} />
              {a.activity} <span className="text-muted-foreground">· {a.channel}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Editor --------------------------------------------------------------------

function EntryEditor({
  ticketId,
  data,
  isHiring,
}: {
  ticketId: string;
  data: Registrations;
  isHiring: boolean;
}) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["programs", ticketId, "registrations"] });
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

  const needsRole = isHiring && roles.length === 0; // hiring counts are per role
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

  // Live preview of the exact message Add would post (debounced).
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
    save.mutate(rows); // one request = one Slack summary
  };

  return (
    <div className="workspace-panel p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Update registrations</h3>
          <p className="text-xs text-muted-foreground">
            Add daily counts manually or upload a CSV (date, {isHiring ? "role, " : ""}registrations
            and relevant are required, plus any extra columns).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <label className="cursor-pointer">
              <Upload className="size-4" />
              Upload CSV
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importCsv(f);
                  e.target.value = "";
                }}
              />
            </label>
          </Button>
        </div>
      </div>
      {slack.notify && !slack.channel_id && (
        <p className="mb-3 text-xs text-muted-foreground">
          Notify Slack is on, but no channel is set, nothing will be posted until you add one above.
        </p>
      )}
      {notice && (
        <p
          className={cn(
            "mb-3 text-xs",
            notice.tone === "ok"
              ? "text-success"
              : notice.tone === "warn"
                ? "text-warning"
                : "text-destructive",
          )}
        >
          {notice.text}
        </p>
      )}

      <div className="mb-4 grid gap-4 md:grid-cols-2">
        {isHiring && (
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
              <UsersRound className="size-3.5" />
              Roles
            </p>
            <div className="flex flex-wrap gap-1.5">
              {roles.map((r) => (
                <Chip
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
                className="h-8 text-sm"
              />
              <Button size="sm" variant="secondary" type="submit">
                <Plus className="size-4" />
              </Button>
            </form>
          </div>
        )}
        <div>
          <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Extra fields</p>
          <div className="flex flex-wrap gap-1.5">
            {fields.length ? (
              fields.map((f) => (
                <Chip
                  key={f}
                  label={f}
                  onRemove={() => config.mutate({ roles, fields: fields.filter((x) => x !== f) })}
                />
              ))
            ) : (
              <span className="text-xs text-muted-foreground">
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
              className="h-8 text-sm"
            />
            <Button size="sm" variant="secondary" type="submit">
              <Plus className="size-4" />
            </Button>
          </form>
        </div>
      </div>

      {needsRole && (
        <p className="mb-2 text-xs text-warning">
          Hiring programs track registrations per role. Add at least one role above (e.g. Software
          Engineer) to start adding daily counts.
        </p>
      )}
      <form
        className="flex flex-wrap items-end gap-2 rounded-lg bg-secondary/40 p-3"
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
            className="h-8 w-36 text-sm"
          />
        </Field>
        {isHiring && (
          <Field label="Role">
            <select
              value={role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
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
            className="h-8 w-28 text-sm"
          />
        </Field>
        <Field label="Relevant">
          <Input
            type="number"
            min={0}
            required
            value={form.relevant}
            onChange={(e) => setForm({ ...form, relevant: e.target.value })}
            className="h-8 w-24 text-sm"
          />
        </Field>
        {fields.map((f) => (
          <Field key={f} label={f}>
            <Input
              value={form.extra[f] ?? ""}
              onChange={(e) => setForm({ ...form, extra: { ...form.extra, [f]: e.target.value } })}
              className="h-8 w-28 text-sm"
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
          {slack.notify ? <Bell className="size-4" /> : <BellOff className="size-4" />}Notify Slack
        </Button>
        <Button size="sm" type="submit" disabled={save.isPending || needsRole}>
          <Plus className="size-4" />
          {save.isPending ? "Saving…" : "Add"}
        </Button>
      </form>
      {preview && (
        <div className="mt-3 rounded-lg border border-border bg-card p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">
            Slack message preview
            {slack.notify && slack.channel_id
              ? ` · will post to #${slack.channel_name}`
              : slack.notify
                ? " · no channel set, won't post"
                : " · Notify Slack is off, won't post"}
          </p>
          <pre className="whitespace-pre-wrap font-sans text-sm">{preview}</pre>
        </div>
      )}

      <div className="mt-4 max-h-72 overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card text-left text-[10px] uppercase text-muted-foreground">
            <tr>
              <th className="p-2">Date</th>
              {isHiring && <th className="p-2">Role</th>}
              <th className="p-2 text-right">Registrations</th>
              <th className="p-2 text-right">Relevant</th>
              {fields.map((f) => (
                <th key={f} className="p-2">
                  {f}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="p-2 font-mono text-xs">{fmt(e.date)}</td>
                {isHiring && <td className="p-2">{e.role || "-"}</td>}
                <td className="p-2 text-right font-mono">{e.registrations}</td>
                <td className="p-2 text-right font-mono">{e.relevant}</td>
                {fields.map((f) => (
                  <td key={f} className="p-2 text-muted-foreground">
                    {e.extra[f] || "-"}
                  </td>
                ))}
                <td className="p-2">
                  <button type="button" aria-label="Delete row" onClick={() => remove.mutate(e.id)}>
                    <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
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

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs">
      {label}
      <button type="button" aria-label={`Remove ${label}`} onClick={onRemove}>
        <X className="size-3 text-muted-foreground hover:text-foreground" />
      </button>
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[10px] font-semibold uppercase text-muted-foreground">
      {label}
      {children}
    </label>
  );
}
