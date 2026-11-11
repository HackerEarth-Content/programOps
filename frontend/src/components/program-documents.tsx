import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, Upload } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Card,
  CardBody,
  CardHeader,
  Chip,
  EmptyState,
  KpiCell,
  KpiStrip,
  Notice,
  Segmented,
  Skeleton,
  type Tone,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UploadDocumentDialog, VersionHistory } from "@/components/document-upload";
import { registrationsQueryOptions, useCan, type RegistrationEstimate } from "@/lib/api";
import { formatDate, known } from "@/lib/format";
import {
  programDocumentsQueryOptions,
  type DocKind,
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

const CHANNEL: Record<PoaChannel, { tone: Tone }> = {
  Email: { tone: "info" },
  Social: { tone: "indigo" },
  Community: { tone: "good" },
  Newsletter: { tone: "warning" },
  Partner: { tone: "serious" },
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
      <div className="grid gap-4 md:grid-cols-2">
        <FileCard ticketId={ticketId} docKind="sow" kind="Statement of Work" doc={sow} />
        <FileCard ticketId={ticketId} docKind="poa" kind="Plan of Action" doc={poa} />
      </div>

      {options.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {options.length > 1 ? (
            <Segmented value={active ?? "sow"} onChange={setView} options={options} />
          ) : null}
          <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">
            Tracking as of
            <Input
              type="date"
              value={today}
              onChange={(e) => e.target.value && setToday(e.target.value)}
              className="h-8 w-36"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setToday(toKey(new Date()))}
            >
              Reset
            </Button>
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
  ticketId,
  docKind,
  kind,
  doc,
}: {
  ticketId: string;
  docKind: DocKind;
  kind: string;
  doc: ProgramDocument<unknown> | null;
}) {
  const canUpload = useCan(docKind === "sow" ? "document.upload_sow" : "document.upload_poa");
  const [uploading, setUploading] = useState(false);
  const dialog = canUpload && (
    <UploadDocumentDialog
      ticketId={ticketId}
      kind={docKind}
      replacing={!!doc}
      open={uploading}
      onOpenChange={setUploading}
    />
  );
  if (!doc)
    return (
      <Card className="flex min-h-[68px] items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[13px] text-ink-2">{kind}</p>
          <p className="text-[14px] font-medium">Not uploaded</p>
          <p className="text-[13px] text-ink-2">
            {canUpload
              ? "Upload it here, or attach it to the HubSpot ticket."
              : "Attach it to the HubSpot ticket and it will appear here."}
          </p>
        </div>
        {canUpload && (
          <Button size="sm" variant="outline" onClick={() => setUploading(true)}>
            <Upload className="size-3.5" /> Upload
          </Button>
        )}
        {dialog}
      </Card>
    );
  const file = doc.file;
  return (
    <Card className="px-4 py-3">
      <div className="flex min-h-[44px] items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[13px] text-ink-2">
            {kind}
            <Chip tone={doc.status === "ok" ? "good" : "warning"}>
              {doc.status === "ok" ? "Extracted" : "Extraction failed"}
            </Chip>
          </p>
          <p className="truncate text-[14px] font-medium" title={file.file_name}>
            {file.file_name}
          </p>
          <p className="text-[12px] text-ink-2">
            {Math.max(1, Math.round(file.size_bytes / 1024))} KB
            {file.uploaded_at && ` · uploaded ${formatDate(file.uploaded_at)}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <Button asChild size="sm" variant="outline">
            <a href={file.url} target="_blank" rel="noreferrer">
              View
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`${file.url}?download=true`}>Download</a>
          </Button>
          {canUpload && (
            <Button size="sm" variant="outline" onClick={() => setUploading(true)}>
              <Upload className="size-3.5" /> Replace
            </Button>
          )}
        </div>
      </div>
      {doc.status === "failed" && (
        <p className="mt-2 text-[13px] text-warn">
          Couldn't extract details from this file ({doc.error ?? "unknown error"}). You can still
          view and download it.
        </p>
      )}
      <VersionHistory ticketId={ticketId} kind={docKind} />
      {dialog}
    </Card>
  );
}

// "INR 9,50,000 + taxes" from the extracted amount; the raw contract wording is the fallback.
function feeLabel(sow: SowDetails): string | null {
  if (sow.fee_amount_inr == null) return known(sow.fee);
  const amount = new Intl.NumberFormat("en-IN").format(sow.fee_amount_inr);
  return `INR ${amount}${/tax/i.test(sow.fee) ? " + taxes" : ""}`;
}

function KvList({ rows }: { rows: { k: ReactNode; v: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13px]">
      {rows.map((r, i) => (
        <div key={i} className="contents">
          <dt className="text-ink-2">{r.k}</dt>
          <dd className="min-w-0 break-words">{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function SowView({ sow, today }: { sow: SowDetails; today: string }) {
  const [full, setFull] = useState(false);
  const fee = feeLabel(sow);
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4 px-4 pt-4">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold leading-6">{sow.title}</h2>
            <p className="text-[13px] text-ink-2">
              {sow.customer} · Order dated {fmtLong(sow.order_date)}
            </p>
          </div>
          {fee && (
            <div className="sm:text-right">
              <p className="text-[13px] text-ink-2">Contract value</p>
              <p className="text-[14px] font-semibold">{fee}</p>
              <p className="text-[13px] text-ink-2">{known(sow.payment_terms)}</p>
            </div>
          )}
        </div>
        <p className="mt-3 max-w-[78ch] px-4 text-[14px] leading-5">{sow.objective}</p>
        {sow.commitments.length > 0 && (
          <KpiStrip label="Headline numbers" className="m-4 mb-0">
            {sow.commitments.map((c) => (
              <KpiCell key={c.label} label={c.label} value={c.value} />
            ))}
          </KpiStrip>
        )}
        <div className="mt-4 border-t border-border px-4 py-3.5">
          <p className="text-[13px] font-medium">Validity and exclusions</p>
          <p className={cn("mt-1 max-w-[110ch] text-[13px] text-ink-2", !full && "line-clamp-2")}>
            <span className="font-medium text-foreground">Validity:</span> {sow.validity} ·{" "}
            <span className="font-medium text-foreground">Excludes:</span> {sow.exclusions}
          </p>
          <button
            type="button"
            onClick={() => setFull(!full)}
            className="text-[13px] text-primary hover:underline"
          >
            {full ? "Show less" : "Show full text"}
          </button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Delivery timeline"
          divided
          meta={sow.timeline.some((m) => !m.start) ? "Undated stages run in this order" : undefined}
        />
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-border text-left text-[12px] font-medium text-ink-2">
                <th className="w-36 px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Stage</th>
                <th className="px-4 py-2.5">Owner</th>
              </tr>
            </thead>
            <tbody>
              {sow.timeline.map((m, i) => {
                const end = m.start && m.end && m.end !== m.start ? m.end : null;
                const now = !!today && !!m.start && isToday(today, m.start, end);
                return (
                  <tr
                    key={`${i}|${m.task}`}
                    className={cn("h-11 border-b border-border last:border-b-0", now && NOW)}
                  >
                    <td className="whitespace-nowrap px-4">
                      {m.start ? (
                        <>
                          {fmt(m.start)}
                          {end ? ` – ${fmt(end)}` : m.open_ended ? " →" : ""}
                        </>
                      ) : (
                        <span className="text-ink-2">Date TBC</span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-medium">
                      {m.task}
                      {now && (
                        <Chip tone="info" className="ml-2">
                          now
                        </Chip>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <Chip className="h-auto min-h-[20px] whitespace-normal py-0.5 text-left">
                        {m.owner}
                      </Chip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid items-start gap-4 break-words lg:grid-cols-2 [&>*]:min-w-0">
        {sow.rounds.length + sow.content.length > 0 && (
          <Card>
            <CardHeader title="Rounds and content" />
            <CardBody className="space-y-4">
              {sow.rounds.map((r) => (
                <div key={r.name}>
                  <p className="text-[14px] font-medium">{r.name}</p>
                  <p className="text-[13px] text-ink-2">{r.details.join(" · ")}</p>
                </div>
              ))}
              {sow.content.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {sow.content.map((c) => (
                    <Chip
                      key={c}
                      className="h-auto min-h-[20px] whitespace-normal py-0.5 text-left"
                    >
                      {c}
                    </Chip>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        )}
        <div className="space-y-4">
          {sow.contacts.length > 0 && (
            <Card>
              <CardHeader title="Contacts" divided />
              <ul className="divide-y divide-border">
                {sow.contacts.map((c) => (
                  <li
                    key={`${c.name}-${c.contact}`}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-[14px] font-medium">{c.name}</p>
                      <p className="text-[13px] text-ink-2">
                        {c.role} ·{" "}
                        <a href={`mailto:${c.contact}`} className="text-primary hover:underline">
                          {c.contact}
                        </a>
                      </p>
                    </div>
                    <Chip>{c.side}</Chip>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {(sow.sla.length > 0 ||
            sow.services.length > 0 ||
            sow.reports.length > 0 ||
            sow.client_requirements.length > 0) && (
            <Card>
              <CardHeader title="Service levels and reporting" />
              <CardBody>
                <KvList
                  rows={[
                    ...sow.sla.map((s) => ({
                      k: s.audience,
                      v: `${s.response} first response · ${s.hours}`,
                    })),
                    ...sow.reports.map((r) => ({ k: r.type, v: r.frequency })),
                    ...sow.client_requirements.map((r) => ({
                      k: `Needed: ${r.item}`,
                      v: r.details,
                    })),
                    ...(sow.services.length
                      ? [{ k: "Services", v: sow.services.join(" · ") }]
                      : []),
                  ]}
                />
              </CardBody>
            </Card>
          )}
        </div>
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
            <p className="text-[13px] text-ink-2">Campaign window</p>
            <p className="mt-1 t-data-md">
              {poa.window_start && poa.window_end
                ? `${fmt(poa.window_start)} → ${fmt(poa.window_end)}`
                : "Not in the document"}
            </p>
          </div>
          <div>
            <p className="text-[13px] text-ink-2">Activities</p>
            <p className="mt-1 t-data-md">{poa.activities.length} planned</p>
          </div>
          <div>
            <p className="text-[13px] text-ink-2">
              {todays.length ? "Happening today" : "Next up"}
            </p>
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
        <Notice>
          {undated} {undated === 1 ? "activity has" : "activities have"} no date in the document.
          {estimate?.start
            ? ` Their weeks are estimated from the registration start (${fmt(estimate.start)}${estimate.start_source ? `, ${estimate.start_source}` : ""}).`
            : ` Shown as "Date TBC" until the registration start is known.`}
        </Notice>
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
                          <span className="text-[12px] text-ink-2">Est.</span>
                          <p className="t-data-sm">
                            {fmt(est.from)} – {fmt(est.to)}
                          </p>
                        </>
                      ) : (
                        <span className="text-[13px] text-ink-2">Date TBC</span>
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
