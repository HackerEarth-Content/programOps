import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CalendarClock,
  Download,
  ExternalLink,
  FileSignature,
  FileText,
  Handshake,
  Loader2,
  Mail,
  Megaphone,
  MessageCircle,
  Newspaper,
  Share2,
  ShieldCheck,
  Target,
  UploadCloud,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  dueTodayQueryOptions,
  programDocumentsQueryOptions,
  type DocFile,
  type PoaActivity,
  type PoaChannel,
  type PoaDetails,
  type ProgramDocument,
  type SowDetails,
} from "@/lib/program-documents";
import { registrationsQueryOptions, type RegistrationEstimate } from "@/lib/api";
import { ProgramRegistrations } from "@/components/program-registrations";
import { cn } from "@/lib/utils";

const toKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (iso: string) => new Date(`${iso}T00:00:00`);
const fmt = (iso: string) =>
  new Intl.DateTimeFormat("en", { day: "2-digit", month: "short" }).format(parse(iso));
const fmtLong = (iso: string) =>
  new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(parse(iso));

// Date-driven highlight only: the item covering today glows; no done/upcoming tags.
const isToday = (today: string, start: string, end: string | null) =>
  today >= start && today <= (end ?? start);

const channelIcon: Record<PoaChannel, typeof Mail> = {
  Email: Mail,
  Social: Share2,
  Community: MessageCircle,
  Newsletter: Newspaper,
  Partner: Handshake,
};
const channelTone: Record<PoaChannel, string> = {
  Email: "text-primary bg-primary/10",
  Social: "text-chart-4 bg-chart-4/10",
  Community: "text-success bg-success/10",
  Newsletter: "text-warning bg-warning/10",
  Partner: "text-destructive bg-destructive/10",
};

export function ProgramDocuments({ ticketId, isHiring = false }: { ticketId: string; isHiring?: boolean }) {
  const documentsQuery = useQuery(programDocumentsQueryOptions(ticketId));
  const registrationsQuery = useQuery(registrationsQueryOptions(ticketId));
  const [today, setToday] = useState("");
  // Client-only: server render has no notion of the viewer's local date.
  useEffect(() => setToday(toKey(new Date())), []);

  if (documentsQuery.isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (documentsQuery.isError || !documentsQuery.data) {
    return (
      <p className="text-sm text-muted-foreground">Couldn't load the SOW and plan of action.</p>
    );
  }

  const { sow, poa } = documentsQuery.data;
  const estimate = registrationsQuery.data?.estimate;
  const sowDetails = sow?.details ?? null;
  const poaDetails = poa?.details ?? null;

  return (
    <section className="space-y-5" aria-label="Program documents">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <p className="section-kicker">From HubSpot</p>
          <h2 className="section-title">SOW & plan of action</h2>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarClock className="size-4" />
          Tracking as of
          <input
            type="date"
            value={today}
            onChange={(e) => e.target.value && setToday(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-foreground"
          />
          <button
            type="button"
            onClick={() => setToday(toKey(new Date()))}
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            Reset
          </button>
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <FileCard kind="Statement of Work" icon={FileSignature} doc={sow} />
        <FileCard kind="Plan of Action" icon={Megaphone} doc={poa} />
      </div>

      <Tabs defaultValue={sowDetails ? "sow" : poaDetails ? "poa" : "registrations"}>
          <TabsList>
            {sowDetails && <TabsTrigger value="sow">SOW details</TabsTrigger>}
            {poaDetails && <TabsTrigger value="poa">Marketing schedule</TabsTrigger>}
            <TabsTrigger value="registrations">Registrations</TabsTrigger>
          </TabsList>
          {sowDetails && (
            <TabsContent value="sow" className="mt-4 space-y-4">
              <SowView sow={sowDetails} today={today} />
            </TabsContent>
          )}
          {poaDetails && (
            <TabsContent value="poa" className="mt-4">
              <PoaView poa={poaDetails} today={today} estimate={estimate} />
            </TabsContent>
          )}
          <TabsContent value="registrations" className="mt-4">
            <ProgramRegistrations ticketId={ticketId} isHiring={isHiring} activities={poaDetails?.activities ?? []} />
          </TabsContent>
        </Tabs>
    </section>
  );
}

function FileCard({
  kind,
  icon: Icon,
  doc,
}: {
  kind: string;
  icon: typeof FileText;
  doc: ProgramDocument<unknown> | null;
}) {
  if (!doc) {
    return (
      <div className="flex items-center gap-4 rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
        <UploadCloud className="size-5" />
        <div>
          <p className="font-medium text-foreground">{kind} not uploaded</p>
          <p className="text-xs">Attach it to the HubSpot ticket and it will appear here.</p>
        </div>
      </div>
    );
  }
  const file: DocFile = doc.file;
  return (
    <div className="workspace-panel p-4">
      <div className="flex items-center gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase text-muted-foreground">{kind}</p>
          <p className="truncate text-sm font-medium" title={file.file_name}>
            {file.file_name}
          </p>
          <p className="text-xs text-muted-foreground">
            {Math.max(1, Math.round(file.size_bytes / 1024))} KB · HubSpot: {file.hubspot_property}
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button asChild size="sm" variant="outline">
            <a href={file.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              View
            </a>
          </Button>
          <Button asChild size="sm">
            <a href={`${file.url}?download=true`}>
              <Download className="size-4" />
              Download
            </a>
          </Button>
        </div>
      </div>
      {doc.status === "failed" && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-warning/10 p-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Couldn't extract details from this file ({doc.error ?? "unknown error"}). You can still
          view and download it.
        </p>
      )}
    </div>
  );
}

// "INR 9,50,000 + taxes" from the extracted amount; the raw contract wording
// ("INR.9,50,000/- plus taxes") is the fallback when no amount was parsed.
function feeLabel(sow: SowDetails) {
  if (sow.fee_amount_inr == null) return sow.fee;
  const amount = new Intl.NumberFormat("en-IN").format(sow.fee_amount_inr);
  return `INR ${amount}${/tax/i.test(sow.fee) ? " + taxes" : ""}`;
}

function SowView({ sow, today }: { sow: SowDetails; today: string }) {
  return (
    <>
      <div className="workspace-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h3 className="font-display text-lg font-semibold">{sow.title}</h3>
            <p className="text-sm text-muted-foreground">
              {sow.customer} · Order dated {fmtLong(sow.order_date)}
            </p>
            <p className="mt-3 text-sm leading-6">{sow.objective}</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase text-muted-foreground">
              Contract value
            </p>
            <p className="font-mono text-2xl font-semibold text-success">{feeLabel(sow)}</p>
            <p className="text-xs text-muted-foreground">{sow.payment_terms}</p>
          </div>
        </div>
        {sow.commitments.length > 0 && (
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {sow.commitments.map((c) => (
              <div key={c.label} className="rounded-md bg-secondary/60 p-3">
                <p className="font-mono text-xl font-semibold">{c.value}</p>
                <p className="text-xs text-muted-foreground">{c.label}</p>
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          <span className="font-semibold">Validity:</span> {sow.validity} ·{" "}
          <span className="font-semibold">Excludes:</span> {sow.exclusions}
        </p>
      </div>

      <div className="workspace-panel p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 font-semibold">
            <CalendarClock className="size-4 text-primary" />
            Delivery timeline
          </h3>
          {sow.timeline.some((m) => !m.start) && (
            <p className="text-xs text-muted-foreground">
              The SOW gives no dates for some stages; they run in this order.
            </p>
          )}
        </div>
        <ol className="space-y-2">
          {sow.timeline.map((m, i) => {
            const end = m.start && m.end && m.end !== m.start ? m.end : null;
            return (
              <li
                key={`${i}|${m.task}`}
                className={cn(
                  "flex flex-wrap items-center gap-3 rounded-md border border-border p-3 transition",
                  today && m.start && isToday(today, m.start, end) && "doc-glow",
                )}
              >
                <span className="w-28 shrink-0 font-mono text-xs">
                  {m.start ? fmt(m.start) : <span className="text-muted-foreground">Date TBC</span>}
                  {m.start && (end ? ` – ${fmt(end)}` : m.open_ended ? " →" : "")}
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium">{m.task}</span>
                <Badge variant="outline" className="text-[10px]">
                  {m.owner}
                </Badge>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {sow.rounds.length + sow.content.length > 0 && (
          <div className="workspace-panel p-5">
            <h3 className="mb-3 flex items-center gap-2 font-semibold">
              <Target className="size-4 text-primary" />
              Rounds & content
            </h3>
            {sow.rounds.map((r) => (
              <div key={r.name} className="mb-3">
                <p className="text-sm font-semibold">{r.name}</p>
                <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                  {r.details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="flex flex-wrap gap-1.5">
              {sow.content.map((c) => (
                <span key={c} className="rounded-sm bg-secondary px-2 py-1 text-xs">
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}
        {(sow.client_requirements.length > 0 || sow.reports.length > 0) && (
          <div className="workspace-panel p-5">
            {sow.client_requirements.length > 0 && (
              <>
                <h3 className="mb-3 font-semibold">Needed from client</h3>
                <div className="grid grid-cols-2 gap-2">
                  {sow.client_requirements.map((r) => (
                    <div key={r.item} className="rounded-md border border-border p-2.5">
                      <p className="text-sm font-medium">{r.item}</p>
                      <p className="text-xs text-muted-foreground">{r.details}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
            {sow.reports.length > 0 && (
              <>
                <h3 className="mb-2 mt-4 font-semibold">Reports</h3>
                {sow.reports.map((r) => (
                  <p key={r.type} className="flex justify-between text-sm">
                    <span>{r.type}</span>
                    <span className="text-muted-foreground">{r.frequency}</span>
                  </p>
                ))}
              </>
            )}
          </div>
        )}
        {sow.contacts.length > 0 && (
          <div className="workspace-panel p-5">
            <h3 className="mb-3 font-semibold">Contacts</h3>
            <div className="space-y-2.5">
              {sow.contacts.map((c) => (
                <div
                  key={`${c.name}-${c.contact}`}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium">
                      {c.name} <span className="text-xs text-muted-foreground">· {c.role}</span>
                    </p>
                    <a
                      href={`mailto:${c.contact}`}
                      className="text-xs text-primary hover:underline"
                    >
                      {c.contact}
                    </a>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    {c.side}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
        {(sow.sla.length > 0 || sow.services.length > 0) && (
          <div className="workspace-panel p-5">
            {sow.sla.length > 0 && (
              <>
                <h3 className="mb-3 flex items-center gap-2 font-semibold">
                  <ShieldCheck className="size-4 text-primary" />
                  Service levels
                </h3>
                {sow.sla.map((s) => (
                  <div
                    key={s.audience}
                    className="mb-2 flex items-center justify-between rounded-md bg-secondary/60 p-3 text-sm"
                  >
                    <div>
                      <p className="font-medium">{s.audience}</p>
                      <p className="text-xs text-muted-foreground">{s.hours}</p>
                    </div>
                    <span className="font-mono font-semibold">{s.response}</span>
                  </div>
                ))}
              </>
            )}
            {sow.services.length > 0 && (
              <>
                <h3 className="mb-2 mt-4 font-semibold">Services</h3>
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {sow.services.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

const addDays = (iso: string, n: number) => {
  const d = parse(iso);
  d.setDate(d.getDate() + n);
  return toKey(d);
};

// "Week N" of an undated plan -> estimated dates, from the event start (clipped to its end).
function estimatedRange(week: string, est: RegistrationEstimate | undefined) {
  const n = Number(/(\d+)/.exec(week)?.[1]);
  if (!est?.start || !n) return null;
  const from = addDays(est.start, 7 * (n - 1));
  if (est.end && from > est.end) return null;
  const to = addDays(from, 6);
  return { from, to: est.end && to > est.end ? est.end : to };
}

function PoaView({
  poa,
  today,
  estimate,
}: {
  poa: PoaDetails;
  today: string;
  estimate: RegistrationEstimate | undefined;
}) {
  const dated = poa.activities.filter((a): a is PoaActivity & { date: string } => !!a.date);
  const undated = poa.activities.length - dated.length;
  const todays = dated.filter((a) => a.date === today);
  const next = dated.find((a) => a.date > today);
  const weeks = useMemo(() => Array.from(new Set(poa.activities.map((a) => a.week))), [poa]);

  return (
    <div className="space-y-4">
      <div className="workspace-panel grid gap-4 p-5 sm:grid-cols-3">
        <div>
          <p className="text-[10px] font-semibold uppercase text-muted-foreground">
            Campaign window
          </p>
          <p className="mt-1 text-sm font-medium">
            {poa.window_start && poa.window_end
              ? `${fmt(poa.window_start)} → ${fmt(poa.window_end)}`
              : "Not specified in the document"}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase text-muted-foreground">Activities</p>
          <p className="mt-1 text-sm font-medium">{poa.activities.length} planned</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase text-muted-foreground">
            {todays.length ? "Happening today" : "Next up"}
          </p>
          <p className="mt-1 text-sm font-medium">
            {todays.length
              ? todays.map((a) => a.activity).join(", ")
              : next
                ? `${next.activity} · ${fmt(next.date)}`
                : "Nothing pending"}
          </p>
        </div>
      </div>
      {undated > 0 && (
        <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          {undated} {undated === 1 ? "activity has" : "activities have"} no date in the document.
          {estimate?.start
            ? ` Their weeks are estimated from the registration start (${fmt(estimate.start)}${estimate.start_source ? `, ${estimate.start_source}` : ""}).`
            : ` Shown as "Date TBC" until the registration start is known.`}
        </p>
      )}
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {(Object.keys(channelIcon) as PoaChannel[]).map((c) => {
          const I = channelIcon[c];
          return (
            <span key={c} className="flex items-center gap-1.5">
              <span
                className={cn("flex size-5 items-center justify-center rounded", channelTone[c])}
              >
                <I className="size-3" />
              </span>
              {c}
            </span>
          );
        })}
      </div>
      <div className="space-y-4">
        {weeks.map((w) => (
          <div key={w}>
            <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{w}</p>
            <div className="space-y-2">
              {poa.activities
                .filter((a) => a.week === w)
                .map((a) => {
                  const I = channelIcon[a.channel];
                  return (
                    <div
                      key={`${a.date ?? "tbc"}|${a.activity}`}
                      className={cn(
                        "flex gap-4 rounded-lg border border-border bg-card/60 p-4 transition",
                        today && a.date && isToday(today, a.date, null) && "doc-glow",
                      )}
                    >
                      <div className="w-16 shrink-0 text-center">
                        {a.date ? (
                          <>
                            <p className="font-mono text-lg font-semibold leading-none">
                              {a.date.slice(8)}
                            </p>
                            <p className="text-[10px] uppercase text-muted-foreground">
                              {new Intl.DateTimeFormat("en", { month: "short" }).format(parse(a.date))}
                            </p>
                          </>
                        ) : (
                          (() => {
                            const r = estimatedRange(a.week, estimate);
                            return r ? (
                              <>
                                <p className="text-[10px] font-semibold uppercase text-muted-foreground">
                                  Est.
                                </p>
                                <p className="font-mono text-[11px] leading-tight">
                                  {fmt(r.from)}
                                  <br />– {fmt(r.to)}
                                </p>
                                {today >= r.from && today <= r.to && (
                                  <Badge className="mt-1 px-1 py-0 text-[9px]">This week</Badge>
                                )}
                              </>
                            ) : (
                              <p className="text-[10px] font-semibold uppercase text-muted-foreground">
                                Date TBC
                              </p>
                            );
                          })()
                        )}
                      </div>
                      <span
                        className={cn(
                          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md",
                          channelTone[a.channel],
                        )}
                      >
                        <I className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold">{a.activity}</p>
                          <span className="text-xs text-muted-foreground">· {a.objective}</span>
                        </div>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                          {a.description}
                        </p>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Dashboard strip: everything scheduled for today across programs.
export function DueToday() {
  const [today, setToday] = useState("");
  useEffect(() => setToday(toKey(new Date())), []);
  const { data } = useQuery({ ...dueTodayQueryOptions(today), enabled: !!today });
  if (!data?.length) return null;
  return (
    <section className="workspace-panel doc-glow p-5" aria-label="Due today">
      <p className="section-kicker">Due today</p>
      <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
        {data.map((item) => (
          <li key={`${item.ticket_id}-${item.kind}-${item.date}-${item.title}`}>
            <Link
              to="/programs/$ticketId"
              params={{ ticketId: item.ticket_id }}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card/70 px-3 py-2 text-sm hover:border-primary/50"
            >
              <span className="font-medium">{item.title}</span>
              <span className="text-xs text-muted-foreground">
                {item.subject} · {item.owner}
              </span>
              <Badge variant="outline" className="ml-auto text-[10px] uppercase">
                {item.kind}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
