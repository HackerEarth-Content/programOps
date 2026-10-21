import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarClock,
  Download,
  ExternalLink,
  FileSignature,
  Handshake,
  Mail,
  Megaphone,
  MessageCircle,
  Newspaper,
  RefreshCw,
  Share2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardBody,
  CardHeader,
  Chip,
  EmptyState,
  MonoLabel,
  Segmented,
  Skeleton,
  type Tone,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { registrationsQueryOptions, type RegistrationEstimate } from "@/lib/api";
import { formatDate, known } from "@/lib/format";
import {
  programDocumentsQueryOptions,
  type PoaActivity,
  type PoaChannel,
  type PoaDetails,
  type ProgramDocument,
  type SowDetails,
} from "@/lib/program-documents";
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

// Date-driven highlight only: the item covering today is marked; no done/upcoming tags.
const isToday = (today: string, start: string, end: string | null) =>
  today >= start && today <= (end ?? start);

const CHANNEL: Record<PoaChannel, { icon: LucideIcon; tone: Tone }> = {
  Email: { icon: Mail, tone: "info" },
  Social: { icon: Share2, tone: "indigo" },
  Community: { icon: MessageCircle, tone: "good" },
  Newsletter: { icon: Newspaper, tone: "warning" },
  Partner: { icon: Handshake, tone: "serious" },
};

const NOW = "border-primary bg-primary/5";

export function ProgramDocuments({
  ticketId,
  isHiring: _isHiring,
}: {
  ticketId: string;
  isHiring?: boolean | undefined;
}) {
  const documents = useQuery(programDocumentsQueryOptions(ticketId));
  const registrations = useQuery(registrationsQueryOptions(ticketId));
  const [today, setToday] = useState("");
  const [view, setView] = useState<"sow" | "poa">("sow");
  // Client-only: server render has no notion of the viewer's local date.
  useEffect(() => setToday(toKey(new Date())), []);

  if (documents.isLoading)
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  if (documents.isError || !documents.data)
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 rounded-xl border border-status-critical/30 bg-status-critical/5 px-4 py-3"
      >
        <span className="flex items-center gap-2 t-body-sm text-status-critical">
          <AlertTriangle className="size-4" /> Couldn't load the SOW and plan of action.
        </span>
        <Button size="sm" variant="outline" onClick={() => void documents.refetch()}>
          <RefreshCw className="size-3.5" /> Retry
        </Button>
      </div>
    );

  const { sow, poa } = documents.data;
  const sowDetails = sow?.details ?? null;
  const poaDetails = poa?.details ?? null;
  const active =
    view === "poa" && poaDetails ? "poa" : sowDetails ? "sow" : poaDetails ? "poa" : null;
  const options = [
    ...(sowDetails ? [{ id: "sow" as const, label: "SOW details" }] : []),
    ...(poaDetails ? [{ id: "poa" as const, label: "Marketing schedule" }] : []),
  ];

  return (
    <section className="space-y-4 page-in" aria-label="Program documents">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid flex-1 gap-3 md:grid-cols-2">
          <FileCard kind="Statement of Work" icon={FileSignature} doc={sow} />
          <FileCard kind="Plan of Action" icon={Megaphone} doc={poa} />
        </div>
      </div>

      {options.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {options.length > 1 ? (
            <Segmented value={active ?? "sow"} onChange={setView} options={options} />
          ) : (
            <span />
          )}
          <label className="flex items-center gap-2 t-body-sm text-muted-foreground">
            <CalendarClock className="size-4" />
            Tracking as of
            <Input
              type="date"
              value={today}
              onChange={(e) => e.target.value && setToday(e.target.value)}
              className="w-36 font-mono"
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
      )}

      {active === "sow" && sowDetails && <SowView sow={sowDetails} today={today} />}
      {active === "poa" && poaDetails && (
        <PoaView poa={poaDetails} today={today} estimate={registrations.data?.estimate} />
      )}
      {active === null && (
        <EmptyState
          title="No extracted details yet"
          hint="Once the SOW or plan of action is attached to the HubSpot ticket and read, its details appear here."
        />
      )}
    </section>
  );
}

function FileCard({
  kind,
  icon: Icon,
  doc,
}: {
  kind: string;
  icon: LucideIcon;
  doc: ProgramDocument<unknown> | null;
}) {
  if (!doc)
    return (
      <Card>
        <div className="flex items-center gap-3 px-[18px] py-4">
          <Icon className="size-5 text-muted-foreground" />
          <div className="min-w-0">
            <MonoLabel>{kind}</MonoLabel>
            <p className="text-[14px] font-medium">Not uploaded</p>
            <p className="t-body-sm text-muted-foreground">
              Attach it to the HubSpot ticket and it will appear here.
            </p>
          </div>
        </div>
      </Card>
    );
  const file = doc.file;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 px-[18px] py-4">
        <Icon className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <MonoLabel>{kind}</MonoLabel>
            <Chip tone={doc.status === "ok" ? "good" : "warning"}>
              {doc.status === "ok" ? "extracted" : "extraction failed"}
            </Chip>
          </div>
          <p className="truncate text-[14px] font-medium" title={file.file_name}>
            {file.file_name}
          </p>
          <p className="t-data-sm text-muted-foreground">
            {Math.max(1, Math.round(file.size_bytes / 1024))} KB · {file.hubspot_property}
            {file.uploaded_at && ` · uploaded ${formatDate(file.uploaded_at)}`}
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button asChild size="sm" variant="outline">
            <a href={file.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" /> View
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`${file.url}?download=true`}>
              <Download className="size-3.5" /> Download
            </a>
          </Button>
        </div>
      </div>
      {doc.status === "failed" && (
        <p className="mx-[18px] mb-4 flex items-start gap-2 rounded-[8px] bg-status-warning/15 px-3 py-2 t-body-sm text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Couldn't extract details from this file ({doc.error ?? "unknown error"}). You can still
          view and download it.
        </p>
      )}
    </Card>
  );
}

// "INR 9,50,000 + taxes" from the extracted amount; the raw contract wording is the fallback.
function feeLabel(sow: SowDetails): string | null {
  if (sow.fee_amount_inr == null) return known(sow.fee);
  const amount = new Intl.NumberFormat("en-IN").format(sow.fee_amount_inr);
  return `INR ${amount}${/tax/i.test(sow.fee) ? " + taxes" : ""}`;
}

function SowView({ sow, today }: { sow: SowDetails; today: string }) {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4 px-[18px] pt-4">
          <div className="max-w-2xl">
            <h2 className="t-headline-sm">{sow.title}</h2>
            <p className="t-body-sm text-muted-foreground">
              {sow.customer} · Order dated {fmtLong(sow.order_date)}
            </p>
            <p className="mt-3 text-[14px] leading-5">{sow.objective}</p>
          </div>
          {feeLabel(sow) && (
            <div className="sm:text-right">
              <MonoLabel>Contract value</MonoLabel>
              <p className="t-data-lg">{feeLabel(sow)}</p>
              <p className="t-body-sm text-muted-foreground">{known(sow.payment_terms)}</p>
            </div>
          )}
        </div>
        <CardBody className="mt-4 space-y-3">
          {sow.commitments.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {sow.commitments.map((c) => (
                <div key={c.label} className="surface-inset p-3">
                  <p className="t-data-md">{c.value}</p>
                  <p className="t-body-sm text-muted-foreground">{c.label}</p>
                </div>
              ))}
            </div>
          )}
          <p className="t-body-sm text-muted-foreground">
            <span className="font-medium text-secondary-foreground">Validity:</span> {sow.validity}{" "}
            · <span className="font-medium text-secondary-foreground">Excludes:</span>{" "}
            {sow.exclusions}
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Delivery timeline"
          icon={<CalendarClock />}
          divided
          meta={sow.timeline.some((m) => !m.start) ? "Undated stages run in this order" : undefined}
        />
        <ol className="divide-y divide-border">
          {sow.timeline.map((m, i) => {
            const end = m.start && m.end && m.end !== m.start ? m.end : null;
            const now = !!today && !!m.start && isToday(today, m.start, end);
            return (
              <li
                key={`${i}|${m.task}`}
                className={cn("flex flex-wrap items-center gap-3 px-[18px] py-2.5", now && NOW)}
              >
                <span className="t-data-sm w-32 shrink-0">
                  {m.start ? (
                    <>
                      {fmt(m.start)}
                      {end ? ` – ${fmt(end)}` : m.open_ended ? " →" : ""}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Date TBC</span>
                  )}
                </span>
                <span className="min-w-0 flex-1 text-[14px] font-medium">{m.task}</span>
                {now && <Chip tone="info">now</Chip>}
                <Chip className="h-auto min-h-[22px] whitespace-normal py-0.5 text-left">
                  {m.owner}
                </Chip>
              </li>
            );
          })}
        </ol>
      </Card>

      <div className="grid gap-4 break-words lg:grid-cols-2 [&>*]:min-w-0">
        {sow.rounds.length + sow.content.length > 0 && (
          <Card>
            <CardHeader title="Rounds and content" divided />
            <CardBody className="space-y-3 pt-3">
              {sow.rounds.map((r) => (
                <div key={r.name}>
                  <p className="text-[14px] font-semibold">{r.name}</p>
                  <ul className="mt-1 list-disc pl-5 t-body-sm text-muted-foreground">
                    {r.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </div>
              ))}
              <div className="flex flex-wrap gap-1.5">
                {sow.content.map((c) => (
                  <Chip key={c} className="h-auto min-h-[22px] whitespace-normal py-0.5 text-left">
                    {c}
                  </Chip>
                ))}
              </div>
            </CardBody>
          </Card>
        )}
        {(sow.client_requirements.length > 0 || sow.reports.length > 0) && (
          <Card>
            {sow.client_requirements.length > 0 && (
              <>
                <CardHeader title="Needed from client" divided />
                <CardBody className="grid gap-2 pt-3 sm:grid-cols-2">
                  {sow.client_requirements.map((r) => (
                    <div key={r.item} className="surface-inset p-2.5">
                      <p className="text-[14px] font-medium">{r.item}</p>
                      <p className="t-body-sm text-muted-foreground">{r.details}</p>
                    </div>
                  ))}
                </CardBody>
              </>
            )}
            {sow.reports.length > 0 && (
              <>
                <CardHeader
                  title="Reports"
                  divided
                  className={sow.client_requirements.length ? "border-t border-border" : ""}
                />
                <CardBody className="space-y-1 pt-3">
                  {sow.reports.map((r) => (
                    <p key={r.type} className="flex justify-between text-[14px]">
                      <span>{r.type}</span>
                      <span className="t-data-sm text-muted-foreground">{r.frequency}</span>
                    </p>
                  ))}
                </CardBody>
              </>
            )}
          </Card>
        )}
        {sow.contacts.length > 0 && (
          <Card>
            <CardHeader title="Contacts" divided />
            <ul className="divide-y divide-border">
              {sow.contacts.map((c) => (
                <li
                  key={`${c.name}-${c.contact}`}
                  className="flex items-center justify-between gap-3 px-[18px] py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium">
                      {c.name}{" "}
                      <span className="t-body-sm font-normal text-muted-foreground">
                        · {c.role}
                      </span>
                    </p>
                    <a
                      href={`mailto:${c.contact}`}
                      className="t-data-sm text-primary hover:underline"
                    >
                      {c.contact}
                    </a>
                  </div>
                  <Chip>{c.side}</Chip>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {(sow.sla.length > 0 || sow.services.length > 0) && (
          <Card>
            {sow.sla.length > 0 && (
              <>
                <CardHeader title="Service levels" divided />
                <CardBody className="space-y-2 pt-3">
                  {sow.sla.map((s) => (
                    <div
                      key={s.audience}
                      className="surface-inset flex items-center justify-between p-3"
                    >
                      <div>
                        <p className="text-[14px] font-medium">{s.audience}</p>
                        <p className="t-data-sm text-muted-foreground">{s.hours}</p>
                      </div>
                      <span className="t-data-md">{s.response}</span>
                    </div>
                  ))}
                </CardBody>
              </>
            )}
            {sow.services.length > 0 && (
              <>
                <CardHeader
                  title="Services"
                  divided
                  className={sow.sla.length ? "border-t border-border" : ""}
                />
                <CardBody className="pt-3">
                  <ul className="list-disc pl-5 t-body-sm text-muted-foreground">
                    {sow.services.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </CardBody>
              </>
            )}
          </Card>
        )}
      </div>
    </div>
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
      <Card>
        <div className="grid gap-4 p-[18px] sm:grid-cols-3">
          <div>
            <MonoLabel>Campaign window</MonoLabel>
            <p className="mt-1 t-data-md">
              {poa.window_start && poa.window_end
                ? `${fmt(poa.window_start)} → ${fmt(poa.window_end)}`
                : "Not in the document"}
            </p>
          </div>
          <div>
            <MonoLabel>Activities</MonoLabel>
            <p className="mt-1 t-data-md">{poa.activities.length} planned</p>
          </div>
          <div>
            <MonoLabel>{todays.length ? "Happening today" : "Next up"}</MonoLabel>
            <p className="mt-1 text-[14px] font-medium">
              {todays.length
                ? todays.map((a) => a.activity).join(", ")
                : next
                  ? `${next.activity} · ${fmt(next.date)}`
                  : "Nothing pending"}
            </p>
          </div>
        </div>
      </Card>

      {undated > 0 && (
        <p className="rounded-[8px] bg-status-warning/15 px-3 py-2 t-body-sm text-warn">
          {undated} {undated === 1 ? "activity has" : "activities have"} no date in the document.
          {estimate?.start
            ? ` Their weeks are estimated from the registration start (${fmt(estimate.start)}${estimate.start_source ? `, ${estimate.start_source}` : ""}).`
            : ` Shown as "Date TBC" until the registration start is known.`}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(CHANNEL) as PoaChannel[]).map((c) => (
          <Chip key={c} tone={CHANNEL[c].tone}>
            {c}
          </Chip>
        ))}
      </div>

      {weeks.map((w) => (
        <Card key={w}>
          <CardHeader
            title={w}
            divided
            meta={`${poa.activities.filter((a) => a.week === w).length} activities`}
          />
          <ul className="divide-y divide-border">
            {poa.activities
              .filter((a) => a.week === w)
              .map((a) => {
                const ch = CHANNEL[a.channel];
                const est = a.date ? null : estimatedRange(a.week, estimate);
                const now =
                  !!today &&
                  (a.date
                    ? isToday(today, a.date, null)
                    : !!est && today >= est.from && today <= est.to);
                return (
                  <li
                    key={`${a.date ?? "tbc"}|${a.activity}`}
                    className={cn("flex gap-4 px-[18px] py-3", now && NOW)}
                  >
                    <div className="w-20 shrink-0">
                      {a.date ? (
                        <p className="t-data-md">{fmt(a.date)}</p>
                      ) : est ? (
                        <>
                          <MonoLabel>Est.</MonoLabel>
                          <p className="t-data-sm">
                            {fmt(est.from)} – {fmt(est.to)}
                          </p>
                        </>
                      ) : (
                        <MonoLabel>Date TBC</MonoLabel>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[14px] font-semibold">{a.activity}</p>
                        <Chip tone={ch.tone}>{a.channel}</Chip>
                        {now && <Chip tone="info">{a.date ? "today" : "this week"}</Chip>}
                      </div>
                      <p className="t-body-sm text-secondary-foreground">{a.objective}</p>
                      <p className="mt-0.5 t-body-sm text-muted-foreground">{a.description}</p>
                    </div>
                  </li>
                );
              })}
          </ul>
        </Card>
      ))}
    </div>
  );
}
