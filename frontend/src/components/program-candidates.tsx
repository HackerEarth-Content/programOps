import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Download, Loader2, Pencil, Plus, RefreshCw, Check, X } from "lucide-react";
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
  Legend,
  Segmented,
  Skeleton,
} from "@/components/kit";
import { useCan } from "@/lib/api";
import {
  draftFrom,
  draftYoe,
  progressText,
  refreshCandidates,
  saveRequirement,
  yrs,
  type CandidateRequirement,
  type CandidateSnapshot,
  type Mode,
  type ReqDraft,
  type CityItem,
  type Candidates,
} from "@/lib/registrations-api";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

// ponytail: errMsg / CSV / RemovableChip are small local copies; program-registrations.tsx doesn't export its own
// and importing from it would be circular.
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
const num = (n: number) => n.toLocaleString();
const MAX_CITIES = 10;
const CITY_OK = /^[A-Za-z][A-Za-z .-]{1,49}$/; // same rule as the backend; the server re-checks

function share(n: number, of: number) {
  if (!of) return "0%";
  const v = (n / of) * 100;
  if (n > 0 && v < 0.1) return "<0.1%";
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}%`;
}

function downloadCsv(name: string, rows: (string | number)[][]) {
  // A text cell that starts with = + - @ (or a tab / carriage return) would run as a formula when the file is opened
  // in a spreadsheet, and city names come from free text on user profiles: a leading ' makes it plain text.
  const esc = (v: string | number) => {
    const raw = typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
    return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  const url = URL.createObjectURL(
    new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const isFreshers = (yoe: string | null) => yoe === "0-0";
const hasReq = (r: CandidateRequirement) => !!r.yoe || r.cities.length > 0;

/** "meet 2+ yrs in Bengaluru, Hyderabad" / "meet 0–2 yrs" / "are in Pune". */
function phrase(r: CandidateRequirement) {
  const where = r.cities.length ? `in ${r.cities.join(", ")}` : "";
  return r.yoe ? `meet ${yrs(r.yoe)}${where ? ` ${where}` : ""}` : `are ${where}`;
}

// ---- bars ------------------------------------------------------------------------------------------------------

const NEUTRAL = "bg-ink-3/40";
const POSSIBLY = "bg-primary/50";
// ponytail: stripes via an arbitrary gradient so "not on profile" is never mistaken for a data bar
const HATCH =
  "bg-[repeating-linear-gradient(135deg,var(--color-ink-3)_0_1.5px,transparent_1.5px_5px)] ring-1 ring-inset ring-ink-3/30";

/** Listed vs not on the profile, with the absolute counts: the honest headline for a split that is half empty. */
function Completeness({
  listed,
  missing,
  noun,
}: {
  listed: number;
  missing: number;
  noun: string;
}) {
  const total = listed + missing;
  const pct = (n: number) => `${total ? Math.round((n / total) * 1000) / 10 : 0}%`;
  return (
    <div
      role="img"
      aria-label={`${num(listed)} listed ${noun} (${pct(listed)}), ${num(missing)} not on profile (${pct(missing)})`}
    >
      <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {listed > 0 && <div className="bar-grow bg-primary" style={{ flex: `${listed} 1 0` }} />}
        {missing > 0 && <div className="bg-border" style={{ flex: `${missing} 1 0` }} />}
      </div>
      <p className="mt-1.5 text-[13px] text-ink-2">
        <span className="font-medium text-foreground tabular-nums">{num(listed)}</span> listed (
        {pct(listed)}) ·{" "}
        <span className="font-medium text-foreground tabular-nums">{num(missing)}</span> not on
        profile ({pct(missing)})
      </p>
    </div>
  );
}

function Row({
  label,
  count,
  of,
  scale,
  parts,
  i,
  muted,
  mark,
  sub,
  className,
}: {
  label: ReactNode;
  count: number;
  of?: number; // share shown beside the count; omitted = count only
  scale: number; // 0-100: bar length against the largest row
  parts: { value: number; cls: string }[];
  i: number;
  muted?: boolean;
  mark?: ReactNode;
  sub?: ReactNode; // a small second line under the bar
  className?: string;
}) {
  return (
    <li
      className={cn(
        "grid min-h-8 grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-1 sm:grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_auto]",
        className,
      )}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-1 text-[13px]",
          muted ? "text-ink-3" : "text-foreground",
        )}
      >
        <span className="truncate" title={typeof label === "string" ? label : undefined}>
          {label}
        </span>
        {mark}
      </span>
      <span className="block h-2" aria-hidden>
        {parts.length > 0 && count > 0 && (
          <span
            className="bar-grow flex h-2 overflow-hidden rounded-full"
            style={{ width: `${Math.max(scale, 1.5)}%`, ["--i" as string]: i }}
          >
            {parts
              .filter((p) => p.value > 0)
              .map((p, k) => (
                <span key={k} className={p.cls} style={{ flex: `${p.value} 1 0` }} />
              ))}
          </span>
        )}
      </span>
      <span className="min-w-[5.5rem] text-right text-[13px] tabular-nums">
        <span className="font-medium">{num(count)}</span>
        {of != null && <span className="text-ink-3"> {share(count, of)}</span>}
      </span>
      {sub && (
        <span className="col-span-3 text-[12px] tabular-nums text-ink-3 sm:col-span-2 sm:col-start-2">
          {sub}
        </span>
      )}
    </li>
  );
}

/** The people with no value on their profile: its own row under a divider, so it can't flatten the real bars. */
function NotOnProfile({ count, total, i }: { count: number; total: number; i: number }) {
  if (count <= 0) return null;
  return (
    <Row
      i={i}
      label="Not on profile"
      count={count}
      of={total}
      scale={(count / Math.max(1, total)) * 100}
      parts={[{ value: count, cls: HATCH }]}
      muted
      className="mt-1 border-t border-border pt-2"
    />
  );
}

// Both cards share one structure so they line up: header, completeness bar, one explanation line, a list region of the
// same fixed height (it scrolls inside, so a long city list never stretches the page), then notes at the bottom.
const EXPLAIN = "min-h-10 text-[13px] text-ink-2";
const LIST_H = "h-[22rem]";

function ListRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={label}
      className={cn(
        "scroll-region -mx-1 rounded-md px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        LIST_H,
      )}
    >
      {children}
    </div>
  );
}

function ExperienceCard({ snap }: { snap: CandidateSnapshot }) {
  const { bands, unknown } = snap.yoe;
  const known = snap.total - unknown;
  const max = Math.max(1, ...bands.map((b) => b.count));
  const req = snap.requirement;
  const meet = bands.reduce((s, b) => s + b.matching, 0); // meet the experience requirement, in any city
  return (
    <Card className="flex flex-col">
      <CardHeader title="Experience" />
      <CardBody className="flex flex-1 flex-col gap-3">
        <Completeness listed={known} missing={unknown} noun="experience" />
        <p className={EXPLAIN}>
          {req.yoe ? (
            <>
              <b className="font-semibold tabular-nums text-foreground">{num(meet)}</b> meet{" "}
              {yrs(req.yoe)}
              {req.cities.length > 0 ? " across all cities" : ""}.
              {unknown > 0 && (
                <>
                  {" "}
                  <b className="font-semibold tabular-nums text-foreground">{num(unknown)}</b>{" "}
                  haven't listed experience and could include{" "}
                  {isFreshers(req.yoe) ? "freshers" : "people who meet it"}.
                </>
              )}
            </>
          ) : (
            "Years of experience of everyone who registered."
          )}
        </p>
        <ListRegion label="Registrations by years of experience">
          <ul>
            {bands.map((b, i) => (
              <Row
                key={b.label}
                i={i}
                label={b.label === "0" ? "0 · freshers" : b.label}
                count={b.count}
                of={known}
                scale={(b.count / max) * 100}
                parts={[
                  { value: b.matching, cls: "bg-primary" },
                  { value: b.count - b.matching, cls: NEUTRAL },
                ]}
              />
            ))}
            <NotOnProfile count={unknown} total={snap.total} i={bands.length} />
          </ul>
        </ListRegion>
        <div className="mt-auto space-y-1.5 text-[12px] text-ink-3">
          <p>
            Shares are of the {num(known)} who listed experience
            {unknown > 0
              ? `; Not on profile is a share of all ${num(snap.total)} registrations`
              : ""}
            .
            {req.cities.length > 0 && snap.possibly > 0
              ? ` ${num(snap.possibly)} of those not on profile could still be relevant (city matches).`
              : ""}
          </p>
          {req.yoe && (
            <Legend
              items={[{ label: `Meets ${yrs(req.yoe)}` }, { label: "Other", swatch: NEUTRAL }]}
            />
          )}
        </div>
      </CardBody>
    </Card>
  );
}

type CityView = "meets" | "all";

function CitiesCard({ snap }: { snap: CandidateSnapshot }) {
  const { items, unknown, other } = snap.cities;
  const req = snap.requirement;
  const tracked = hasReq(req);
  // With a requirement the bars of "all registrations" and "meets the requirement" would mix, so the person picks.
  const [view, setView] = useState<CityView>("meets");
  const meets = tracked && view === "meets";
  const known = snap.total - unknown;
  // meets view: only cities with someone who meets (or possibly meets), most first; all view: by registrations
  const list = meets
    ? items
        .filter((c) => c.relevant + c.possibly > 0)
        .sort((a, b) => b.relevant - a.relevant || a.name.localeCompare(b.name))
    : items;
  const max = Math.max(1, items[0]?.count ?? 1);
  const maxMeets = Math.max(1, ...list.map((c) => c.relevant + c.possibly));
  // all view: meets + possibly + the rest when there is a requirement; one plain bar when there is not
  const cityParts = (c: CityItem) =>
    tracked
      ? [
          { value: c.relevant, cls: "bg-primary" },
          { value: c.possibly, cls: POSSIBLY },
          { value: Math.max(0, c.count - c.relevant - c.possibly), cls: NEUTRAL },
        ]
      : [{ value: c.count, cls: "bg-primary" }];
  // the "x meet · y possibly" line: the required cities, or every row when only experience is required
  const detailed = (c: CityItem) => (req.cities.length > 0 ? c.selected : tracked);
  const tick = (c: CityItem) =>
    c.selected && (
      <>
        <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
        <span className="sr-only">(required city)</span>
      </>
    );
  const csv = () =>
    downloadCsv("registrations-by-city.csv", [
      ["city", "registrations", "meets_requirement", "possibly_relevant"],
      ...items.map((c) => [c.name, c.count, c.relevant, c.possibly]),
      ["Other cities", other, "", ""],
      ["Not on profile", unknown, "", ""],
    ]);
  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Where they're from"
        meta={
          <Button size="sm" variant="ghost" onClick={csv} className="max-sm:min-h-11">
            <Download />
            CSV
          </Button>
        }
      />
      <CardBody className="flex flex-1 flex-col gap-3">
        {tracked && (
          <Segmented<CityView>
            value={view}
            onChange={setView}
            className="w-fit max-w-full"
            options={[
              { id: "meets", label: "Meets requirement" },
              { id: "all", label: "All registrations" },
            ]}
          />
        )}
        <Completeness listed={known} missing={unknown} noun="a location" />
        <p className={EXPLAIN}>
          {meets ? (
            <>
              Of the{" "}
              <b className="font-semibold tabular-nums text-foreground">{num(snap.relevant)}</b> who{" "}
              {phrase(req)}, by city.
              {req.yoe ? " Possibly = experience not on profile." : ""}
            </>
          ) : (
            `City on the profile. Shares are of the ${num(known)} who listed one.`
          )}
        </p>
        <ListRegion label={meets ? "Who meets the requirement, by city" : "Registrations by city"}>
          {meets && list.length === 0 && (
            <p className="p-2 text-[13px] text-ink-3">No city has anyone who meets this yet.</p>
          )}
          <ul>
            {list.map((c, i) =>
              meets ? (
                <Row
                  key={c.name}
                  i={i}
                  label={c.name}
                  count={c.relevant}
                  of={snap.relevant}
                  scale={((c.relevant + c.possibly) / maxMeets) * 100}
                  parts={[
                    { value: c.relevant, cls: "bg-primary" },
                    { value: c.possibly, cls: POSSIBLY },
                  ]}
                  sub={req.yoe ? `+${num(c.possibly)} possibly` : undefined}
                  mark={tick(c)}
                />
              ) : (
                <Row
                  key={c.name}
                  i={i}
                  label={c.name}
                  count={c.count}
                  of={known}
                  scale={(c.count / max) * 100}
                  parts={cityParts(c)}
                  sub={
                    detailed(c)
                      ? `${num(c.relevant)} meet · ${num(c.possibly)} possibly`
                      : undefined
                  }
                  mark={tick(c)}
                />
              ),
            )}
            {!meets && other > 0 && (
              <Row
                i={list.length}
                label="Other cities"
                count={other}
                of={known}
                scale={0}
                parts={[]}
                muted
              />
            )}
            {!meets && unknown > 0 && (
              <Row
                i={list.length + 1}
                label="Not on profile"
                count={unknown}
                scale={(unknown / Math.max(1, snap.total)) * 100}
                parts={[{ value: unknown, cls: HATCH }]}
                muted
                className="mt-1 border-t border-border pt-2"
              />
            )}
          </ul>
        </ListRegion>
        <div className="mt-auto space-y-1.5 text-[12px] text-ink-3">
          <p>Top 50 cities by registrations.</p>
          {tracked && (
            <Legend
              items={[
                { label: "Meets requirement" },
                ...(req.yoe ? [{ label: "Possibly (experience missing)", swatch: POSSIBLY }] : []),
                ...(meets ? [] : [{ label: "Other", swatch: NEUTRAL }]),
              ]}
            />
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ---- the view --------------------------------------------------------------------------------------------------

export function CandidatesPanel({
  ticketId,
  q,
  linked,
  elapsed,
  behindEarlier,
  onSetup,
  onEditRequirement,
}: {
  ticketId: string;
  q: UseQueryResult<Candidates>;
  linked: boolean; // the program has a HackerEarth event; without one there is nothing to fetch
  elapsed: number | null; // live seconds the running refresh has taken
  behindEarlier: boolean; // the requirement was saved while an earlier run was still in flight
  onSetup: () => void; // opens and scrolls to the event-linking block
  onEditRequirement: () => void; // opens the requirement dialog (owned by the tab, shared with the KPI cell)
}) {
  const qc = useQueryClient();
  const canManage = useCan("registrations.manage");
  const canLink = useCan("integrations.link");
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 8000);
    return () => window.clearTimeout(t);
  }, [note]);
  const key = ["programs", ticketId, "candidates"];
  const refresh = useMutation({
    mutationFn: () => refreshCandidates(ticketId),
    onMutate: () => setNote(null),
    onSuccess: (res) => {
      const snap = qc.getQueryData<Candidates>(key)?.snapshot;
      if (res.status === "fresh")
        setNote(`Already up to date${snap ? ` (updated ${timeAgo(snap.fetched_at)})` : ""}.`);
      else if (res.status === "already_running") {
        setNote("Redash is already working on it.");
        void qc.invalidateQueries({ queryKey: key });
      } else
        // the server sets `running` a moment after it accepts the job: show it now so polling starts
        qc.setQueryData<Candidates>(key, (c) => (c ? { ...c, running: true } : c));
    },
  });

  if (!linked)
    return (
      <Callout
        title="Link the HackerEarth event to see who registered"
        action={
          canLink || canManage ? (
            <Button size="sm" onClick={onSetup} className="max-sm:min-h-11">
              Link the event
            </Button>
          ) : undefined
        }
      >
        {canLink || canManage
          ? "Experience and city of everyone who registered appear once the event is linked."
          : "Ask the CSM to link the event."}
      </Callout>
    );
  if (q.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-9" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-[34rem]" />
          <Skeleton className="h-[34rem]" />
        </div>
      </div>
    );
  if (q.isError || !q.data)
    return (
      <EmptyState
        title="Couldn't load the candidates split"
        hint={errMsg(q.error)}
        action={
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            Retry
          </Button>
        }
      />
    );

  const c = q.data;
  const snap = c.snapshot;
  const running = c.running || refresh.isPending;
  const shownReq = snap ? snap.requirement : c.requirement;
  const status = progressText(c, elapsed);

  const editButton = canManage && (
    <Button
      size="sm"
      variant={hasReq(c.requirement) ? "outline" : "default"}
      onClick={onEditRequirement}
      className="max-sm:min-h-11"
    >
      {hasReq(c.requirement) ? <Pencil /> : null}
      {hasReq(c.requirement) ? "Edit requirement" : "Set who counts as relevant"}
    </Button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-[14px] text-ink-2" aria-live="polite">
          {snap ? (
            <>
              <b className="font-semibold text-foreground tabular-nums">{num(snap.total)}</b>{" "}
              registered
              {hasReq(shownReq) && (
                <>
                  {" · "}
                  <b className="font-semibold text-foreground tabular-nums">
                    {num(snap.relevant)}
                  </b>{" "}
                  {phrase(shownReq)}
                  {" · "}
                  <span className="font-medium tabular-nums text-foreground">
                    {num(snap.possibly)}
                  </span>{" "}
                  possibly
                </>
              )}
            </>
          ) : hasReq(c.requirement) ? (
            <>Relevant: people who {phrase(c.requirement)}.</>
          ) : (
            "No requirement set."
          )}
        </p>
        {editButton}
      </div>

      {!snap ? (
        <EmptyState
          icon={running ? <Loader2 className="animate-spin" /> : undefined}
          title={running ? "Fetching candidates…" : "No candidate data yet"}
          hint={
            running
              ? `${status ?? "Refreshing…"}${behindEarlier ? " Redash is still finishing the earlier request; yours runs right after." : ""}`
              : "It's fetched with the next daily sync" +
                (canLink ? ", or you can refresh now." : ".")
          }
          action={
            canLink && !running ? (
              <Button size="sm" onClick={() => refresh.mutate()} className="max-sm:min-h-11">
                <RefreshCw />
                Refresh now
              </Button>
            ) : undefined
          }
        />
      ) : snap.total === 0 ? (
        <EmptyState title="No registrations yet" hint="The split appears once people register." />
      ) : (
        <div className="reveal grid items-stretch gap-4 md:grid-cols-2">
          <ExperienceCard snap={snap} />
          <CitiesCard snap={snap} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-ink-2">
        {snap && <span>Updated {timeAgo(snap.fetched_at)}</span>}
        {c.stale && <Chip tone="warning">Stale</Chip>}
        {c.outdated && (
          <Chip tone="warning">
            {running
              ? "Requirement changed, refreshing…"
              : "Requirement changed, refresh to update"}
          </Chip>
        )}
        {snap && running && (
          <span role="status">
            {status ?? "Refreshing…"}
            {behindEarlier
              ? " Redash is still finishing the earlier request; yours runs right after."
              : ""}
          </span>
        )}
        {note && <span role="status">{note}</span>}
        {(c.error || refresh.isError) && (
          <span className="text-danger" role="alert">
            {refresh.isError
              ? errMsg(refresh.error)
              : `Last refresh failed: ${c.error}${/[.!?]$/.test(c.error ?? "") ? "" : "."}`}
            {snap ? " Showing the last good data." : ""}
          </span>
        )}
        <span className="flex-1" />
        {canLink && snap && (
          <Button
            size="sm"
            variant="outline"
            disabled={running}
            onClick={() => refresh.mutate()}
            className="max-sm:min-h-11"
          >
            <RefreshCw className={cn(running && "animate-spin")} />
            {running ? (elapsed != null ? `Refreshing · ${elapsed}s` : "Refreshing…") : "Refresh"}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---- requirement fields (shared by the dialog and the "use this event" step) ---------------------------------------

function RemovableChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Chip>
      {label}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="text-ink-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
      >
        <X className="size-3" />
      </button>
    </Chip>
  );
}

export function RequirementFields({
  value,
  onChange,
  idPrefix,
}: {
  value: ReqDraft;
  onChange: (v: ReqDraft) => void;
  idPrefix: string;
}) {
  const [draft, setDraft] = useState("");
  const [cityErr, setCityErr] = useState<string | null>(null);
  const yoe = draftYoe(value);
  const set = (p: Partial<ReqDraft>) => onChange({ ...value, ...p });

  /** Add the typed city; false when it isn't valid. */
  function commit(): boolean {
    const c = draft.replace(/\s+/g, " ").trim();
    if (!c) return true;
    if (/^(all|any)$/i.test(c)) return (setCityErr("Leave empty for all cities."), false);
    if (!CITY_OK.test(c)) return (setCityErr("Use letters, spaces, hyphens and dots only."), false);
    if (value.cities.some((x) => x.toLowerCase() === c.toLowerCase()))
      return (setDraft(""), setCityErr(null), true);
    if (value.cities.length >= MAX_CITIES)
      return (setCityErr(`At most ${MAX_CITIES} cities.`), false);
    setDraft("");
    setCityErr(null);
    set({ cities: [...value.cities, c] });
    return true;
  }

  const freshers = value.mode === "exact" && value.a === "0";
  return (
    <>
      <div className="grid gap-1.5">
        <span className="text-[12px] font-medium text-ink-3">Years of experience</span>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Mode | "none">
            value={value.mode}
            onChange={(mode) => set({ mode })}
            className="w-fit max-w-full"
            options={[
              { id: "any", label: "Any" },
              { id: "exact", label: "Exactly" },
              { id: "min", label: "At least" },
              { id: "range", label: "Between" },
            ]}
          />
          {/* one tap for the common case: freshers */}
          <Button
            type="button"
            size="sm"
            variant={freshers ? "default" : "outline"}
            aria-pressed={freshers}
            onClick={() => set({ mode: "exact", a: "0" })}
            className="max-sm:min-h-11"
          >
            Freshers (0 yrs)
          </Button>
        </div>
        {value.mode === "none" && (
          <p className="text-[12px] text-ink-3">
            Choose one. “Any” counts people of every experience level.
          </p>
        )}
        {value.mode !== "none" && value.mode !== "any" && (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              min={value.mode === "min" ? 1 : 0}
              max={40}
              step={1}
              value={value.a}
              onChange={(e) => set({ a: e.target.value })}
              aria-label={
                value.mode === "min"
                  ? "Minimum years"
                  : value.mode === "exact"
                    ? "Years"
                    : "From years"
              }
              className="w-24 max-sm:h-11"
            />
            {value.mode === "range" && (
              <>
                <span className="text-[13px] text-ink-2">and</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={40}
                  step={1}
                  value={value.b}
                  onChange={(e) => set({ b: e.target.value })}
                  aria-label="To years"
                  className="w-24 max-sm:h-11"
                />
              </>
            )}
            <span className="text-[13px] text-ink-2">years</span>
          </div>
        )}
        {value.mode !== "none" && value.mode !== "any" && yoe === undefined && (
          <p className="text-[12px] text-ink-3">
            {value.mode === "min" && value.a !== "" && Number(value.a) === 0
              ? "At least 1. For freshers choose Exactly 0 (or the Freshers chip)."
              : "Enter whole numbers from 0 to 40."}
          </p>
        )}
      </div>

      <div className="grid gap-1.5">
        <label htmlFor={`${idPrefix}-city`} className="text-[12px] font-medium text-ink-3">
          Cities (optional)
        </label>
        <div className="flex gap-2">
          <Input
            id={`${idPrefix}-city`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCityErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commit();
              }
            }}
            onBlur={() => void commit()}
            placeholder="Type a city and press Enter"
            className="max-sm:h-11"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => commit()}
            className="max-sm:min-h-11"
          >
            <Plus />
            Add
          </Button>
        </div>
        {cityErr ? (
          <p className="text-[13px] text-danger" role="alert">
            {cityErr}
          </p>
        ) : (
          <p className="text-[12px] text-ink-3">Leave empty for all cities.</p>
        )}
        {value.cities.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {value.cities.map((c) => (
              <RemovableChip
                key={c}
                label={c}
                onRemove={() => set({ cities: value.cities.filter((x) => x !== c) })}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function RequirementDialog({
  ticketId,
  req,
  onClose,
  onSaved,
}: {
  ticketId: string;
  req: CandidateRequirement;
  onClose: () => void;
  /** Called after a save; `behindEarlier` = the requirement changed while an earlier run was still in flight. */
  onSaved?: (behindEarlier: boolean) => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState<ReqDraft>(() => draftFrom(req));
  const yoe = draftYoe(value);

  const save = useMutation({
    mutationFn: (body: CandidateRequirement) => saveRequirement(ticketId, body),
    onSuccess: (view, body) => {
      const key = ["programs", ticketId, "candidates"];
      const wasRunning = qc.getQueryData<Candidates>(key)?.running ?? false;
      const changed = body.yoe !== req.yoe || body.cities.join("|") !== req.cities.join("|");
      // a changed requirement starts a ~1 minute refresh on the server (queued behind a run in flight, if any)
      qc.setQueryData<Candidates>(key, { ...view, running: view.running || changed });
      onSaved?.(changed && wasRunning);
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Who counts as relevant</DialogTitle>
          <DialogDescription>
            People whose profile meets this are counted as relevant. Anyone who hasn't listed their
            experience shows as "possibly".
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (yoe !== undefined) save.mutate({ yoe, cities: value.cities });
          }}
        >
          <RequirementFields value={value} onChange={setValue} idPrefix="req" />
          {save.isError && (
            <p className="text-[13px] text-danger" role="alert">
              {errMsg(save.error)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={save.isPending || yoe === undefined}
              className="max-sm:min-h-11"
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
