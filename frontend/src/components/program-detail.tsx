import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  Check,
  CircleDollarSign,
  Clock3,
  FileText,
  Loader2,
  Mail,
  MessageSquareText,
  SendHorizontal,
  Server,
  UserRound,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProgramDocuments } from "@/components/program-documents";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  STAGES,
  checklistStatusQueryOptions,
  createNote,
  HIRING_CAMPAIGN_TYPE,
  historyQueryOptions,
  notesQueryOptions,
  programQueryOptions,
} from "@/lib/api";
import { formatDate, formatDateTime, formatMoney, orUnassigned, orUnset } from "@/lib/format";
import { cn } from "@/lib/utils";

const AUTHOR_NAME_STORAGE_KEY = "programops-author-name";

const sourceTone: Record<string, string> = {
  CRM_UI: "bg-primary/10 text-primary",
  API: "bg-success/10 text-success",
  INTEGRATION: "bg-chart-4/10 text-chart-4",
  WORKFLOW: "bg-warning/10 text-warning",
  MIGRATION: "bg-muted text-muted-foreground",
};
const defaultSourceTone = "bg-muted text-muted-foreground";

export function ProgramDetail({ ticketId }: { ticketId: string }) {
  const queryClient = useQueryClient();
  const programQuery = useQuery(programQueryOptions(ticketId));
  const checklistQuery = useQuery(checklistStatusQueryOptions);
  const historyQuery = useQuery(historyQueryOptions(ticketId));
  const notesQuery = useQuery(notesQueryOptions(ticketId));

  const [composerOpen, setComposerOpen] = useState(false);
  const [noteBody, setNoteBody] = useState("");
  const [authorName, setAuthorName] = useState(
    () =>
      (typeof window !== "undefined" && window.localStorage.getItem(AUTHOR_NAME_STORAGE_KEY)) || "",
  );
  const addNote = useMutation({
    mutationFn: () => createNote(ticketId, noteBody.trim(), authorName.trim()),
    onSuccess: () => {
      window.localStorage.setItem(AUTHOR_NAME_STORAGE_KEY, authorName.trim());
      queryClient.invalidateQueries({ queryKey: ["programs", ticketId, "notes"] });
      setNoteBody("");
      setComposerOpen(false);
    },
  });
  const canSend = noteBody.trim().length > 0 && authorName.trim().length > 0 && !addNote.isPending;

  const isLoading =
    programQuery.isLoading ||
    checklistQuery.isLoading ||
    historyQuery.isLoading ||
    notesQuery.isLoading;

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const notFound = programQuery.error instanceof ApiError && programQuery.error.status === 404;
  if (notFound) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">This program doesn't exist or was removed.</p>
        <Link to="/" className="text-sm text-primary underline">
          Back to overview
        </Link>
      </div>
    );
  }

  if (programQuery.isError || !programQuery.data) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">Couldn't load this program.</p>
        <Button variant="outline" onClick={() => programQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const program = programQuery.data;
  const checklistStatuses = checklistQuery.data ?? [];
  const history = historyQuery.data ?? [];
  const programNotes = notesQuery.data ?? [];
  const checklist = checklistStatuses.find((item) => item.ticket_id === program.ticket_id);
  const stageIndex = STAGES.indexOf(program.stage);

  return (
    <div className="page-enter space-y-8">
      <Link
        to="/"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to overview
      </Link>
      <section className="flex flex-col justify-between gap-6 border-b border-border pb-8 lg:flex-row lg:items-end">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-muted-foreground">
              {program.ticket_id}
            </Badge>
            <Badge className="bg-primary/15 text-primary hover:bg-primary/15">
              {program.stage}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {program.campaign_type ?? "Uncategorized"}
            </span>
          </div>
          <h1 className="max-w-4xl font-display text-3xl font-semibold sm:text-5xl">
            {program.subject}
          </h1>
          <p className="mt-3 flex items-center gap-2 text-muted-foreground">
            <Building2 className="size-4" />
            {orUnassigned(program.account_manager_name)} <span className="text-border">/</span> CSM{" "}
            {orUnassigned(program.csm_name)}
          </p>
        </div>
        <div className="shrink-0 text-left lg:text-right">
          <p className="text-xs font-semibold uppercase text-muted-foreground">
            Expected deal value
          </p>
          <p className="mt-1 font-mono text-3xl font-semibold text-success">
            {formatMoney(program.expected_deal_size)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Modified {formatDateTime(program.last_modified_at)}
          </p>
        </div>
      </section>

      <section aria-label="Program stage progress">
        <div className="grid grid-cols-6 gap-1">
          {STAGES.map((stage, index) => (
            <div key={stage} className="min-w-0">
              <div
                className={cn(
                  "h-1.5 rounded-sm transition-all",
                  index <= stageIndex ? "bg-primary" : "bg-secondary",
                )}
              />
              <p
                className={cn(
                  "mt-2 truncate text-[10px] font-semibold sm:text-xs",
                  index === stageIndex ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {stage}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="space-y-6">
          <div>
            <p className="section-kicker">Current gate</p>
            <h2 className="section-title">Stage checklist</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="border border-success/25 bg-success/5 p-5">
              <div className="mb-4 flex items-center gap-2">
                <Check className="size-4 text-success" />
                <h3 className="font-semibold">Completed</h3>
                <span className="ml-auto font-mono text-sm text-success">
                  {checklist?.completed_items.length ?? 0}
                </span>
              </div>
              <div className="space-y-3">
                {checklist?.completed_items.length ? (
                  checklist.completed_items.map((item) => (
                    <div key={item} className="flex items-center gap-3 text-sm">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-success text-success-foreground">
                        <Check className="size-3" />
                      </span>
                      {item}
                    </div>
                  ))
                ) : (
                  <div className="py-4 text-center text-sm text-muted-foreground">
                    Nothing completed for this stage yet.
                  </div>
                )}
              </div>
            </div>
            <div className="border border-warning/25 bg-warning/5 p-5">
              <div className="mb-4 flex items-center gap-2">
                <Clock3 className="size-4 text-warning" />
                <h3 className="font-semibold">Pending</h3>
                <span className="ml-auto font-mono text-sm text-warning">
                  {checklist?.pending_items.length ?? 0}
                </span>
              </div>
              {checklist?.pending_items.length ? (
                <div className="space-y-3">
                  {checklist.pending_items.map((item) => (
                    <div key={item} className="flex items-center gap-3 text-sm">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-sm border border-warning/40">
                        <X className="size-3 text-warning" />
                      </span>
                      {item}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-4 text-center text-sm text-muted-foreground">
                  No pending items in this stage.
                </div>
              )}
            </div>
          </div>

          <div className="pt-3">
            <div className="mb-5">
              <p className="section-kicker">Audit trail</p>
              <h2 className="section-title">What changed, and who changed it</h2>
            </div>
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No changes recorded for this program yet.
              </p>
            ) : (
              <div className="max-h-[32rem] overflow-y-auto pr-2">
                <div className="relative ml-2 space-y-0 border-l border-border">
                  {history.map((item, index) => (
                    <div
                      key={`${item.property_name}-${item.changed_at}`}
                      className="timeline-item relative pb-8 pl-7 last:pb-0"
                      style={{ animationDelay: `${Math.min(index, 8) * 90}ms` }}
                    >
                      <span className="absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2 border-background bg-primary ring-2 ring-primary/20" />
                      <div className="flex flex-col justify-between gap-2 sm:flex-row">
                        <div>
                          <p className="text-sm font-semibold">{item.property_label} updated</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                            <span className="rounded-sm bg-secondary px-2 py-1 text-muted-foreground">
                              {item.old_value_label ?? "Empty"}
                            </span>
                            <span className="text-muted-foreground">→</span>
                            <span className="rounded-sm bg-primary/10 px-2 py-1 font-medium text-primary">
                              {item.new_value_label}
                            </span>
                          </div>
                        </div>
                        <div className="sm:text-right">
                          <span
                            className={cn(
                              "rounded-sm px-2 py-1 text-[10px] font-bold",
                              item.source_type
                                ? (sourceTone[item.source_type] ?? defaultSourceTone)
                                : defaultSourceTone,
                            )}
                          >
                            {item.source_type ?? "UNKNOWN"}
                          </span>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {formatDateTime(item.changed_at)}
                          </p>
                        </div>
                      </div>
                      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <UserRound className="size-3" />
                        {item.changed_by_name ??
                          (item.changed_by_user_id != null
                            ? `HubSpot user ${item.changed_by_user_id}`
                            : "System (HubSpot automation / form)")}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="space-y-5">
          <div className="border border-border bg-card/60 p-5">
            <h2 className="mb-5 font-display text-xl font-semibold">Program brief</h2>
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
              <Info icon={Zap} label="Event" value={orUnset(program.event_name)} />
              <Info icon={FileText} label="Campaign type" value={orUnset(program.campaign_type)} />
              <Info icon={Server} label="Platform" value={orUnset(program.platform_details)} />
              <Info
                icon={UserRound}
                label="Ticket owner"
                value={orUnassigned(program.owner_name)}
              />
              <Info
                icon={UsersRound}
                label="Account manager"
                value={orUnassigned(program.account_manager_name)}
              />
              <Info
                icon={UserRound}
                label="Customer success"
                value={orUnassigned(program.csm_name)}
              />
              <Info
                icon={Mail}
                label="Content POC"
                value={orUnassigned(program.content_poc_name)}
              />
              <Info icon={CalendarDays} label="Created" value={formatDate(program.created_at)} />
            </div>
          </div>
          <div className="border border-border bg-card/60 p-5">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="section-kicker">Internal</p>
                <h2 className="font-display text-xl font-semibold">Notes</h2>
              </div>
              <button
                type="button"
                aria-label={composerOpen ? "Close note composer" : "Add a note"}
                onClick={() => setComposerOpen((open) => !open)}
                className="rounded-md p-1.5 text-primary transition-colors hover:bg-primary/10"
              >
                <MessageSquareText className="size-5" />
              </button>
            </div>

            {composerOpen && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSend) addNote.mutate();
                }}
                className="mb-5 space-y-2 border border-border bg-secondary/30 p-3"
              >
                <Input
                  value={authorName}
                  onChange={(event) => setAuthorName(event.target.value)}
                  placeholder="Your name"
                  className="h-8 text-sm"
                />
                <Textarea
                  value={noteBody}
                  onChange={(event) => setNoteBody(event.target.value)}
                  placeholder="Add an internal note…"
                  className="min-h-16 text-sm"
                />
                {addNote.isError && (
                  <p className="text-xs text-destructive">
                    {addNote.error instanceof Error
                      ? addNote.error.message
                      : "Couldn't save the note."}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={!canSend}>
                    {addNote.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <SendHorizontal className="size-3.5" />
                    )}
                    Send
                  </Button>
                </div>
              </form>
            )}

            {programNotes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No internal notes logged yet.</p>
            ) : (
              <div className="max-h-96 space-y-5 overflow-y-auto pr-2">
                {programNotes.map((note) => (
                  <article key={note.note_id} className="border-l-2 border-primary/40 pl-4">
                    <p className="text-sm leading-6 text-foreground/90">{note.body}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {note.author_name ??
                        (note.author_user_id != null
                          ? `HubSpot user ${note.author_user_id}`
                          : "Unknown author")}{" "}
                      · {formatDateTime(note.created_at)}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </div>
        </aside>
      </section>

      <ProgramDocuments ticketId={program.ticket_id} isHiring={program.campaign_type === HIRING_CAMPAIGN_TYPE} />
    </div>
  );
}

function Info({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof UserRound;
  label: string;
  value: string;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div>
        <p className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</p>
        <p className="mt-0.5 text-sm font-medium">{value}</p>
      </div>
    </div>
  );
}
