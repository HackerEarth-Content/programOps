import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, History, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Chip, Notice } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import {
  DOC_LABEL,
  MAX_COMMENT,
  MIN_COMMENT,
  documentVersionsQueryOptions,
  planChangeText,
  uploadDocument,
  type DocKind,
  type UploadResult,
} from "@/lib/program-documents";

const MAX_MB = 20;

/** Replace the SOW / POA: the file goes to HubSpot, is read again, and the program's data is re-arranged. */
export function UploadDocumentDialog({
  ticketId,
  kind,
  replacing,
  open,
  onOpenChange,
}: {
  ticketId: string;
  kind: DocKind;
  replacing: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [comment, setComment] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);

  const save = useMutation({
    mutationFn: () => uploadDocument(ticketId, kind, file as File, comment.trim()),
    onSuccess: (done) => {
      setResult(done);
      // The document, the marketing plan, rounds, the deal value and the audit trail can all have changed.
      void qc.invalidateQueries({ queryKey: ["programs"] });
      void qc.invalidateQueries({ queryKey: ["audit"] });
      void qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });

  const reset = () => {
    setFile(null);
    setComment("");
    setResult(null);
    save.reset();
  };
  const close = () => {
    reset();
    onOpenChange(false);
  };

  const tooBig = !!file && file.size > MAX_MB * 1024 * 1024;
  const notPdf = !!file && !/\.pdf$/i.test(file.name);
  const commentOk = comment.trim().length >= MIN_COMMENT;
  const ready = !!file && !tooBig && !notPdf && commentOk && !save.isPending;
  const label = DOC_LABEL[kind];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (save.isPending) return; // reading the file takes a while; don't lose it halfway
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {replacing ? "Replace" : "Upload"} the {label}
          </DialogTitle>
          <DialogDescription>
            {replacing
              ? "The new file is saved to the HubSpot ticket, read again, and the program's data is re-arranged from it."
              : "The file is saved to the HubSpot ticket and read."}{" "}
            Your name and comment are logged.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-[14px] font-medium">
              <CheckCircle2 className="size-4 text-status-good" /> {label} saved
            </p>
            {result.plan && <p className="text-[13px] text-ink-2">{planChangeText(result.plan)}</p>}
            {!result.hubspot_note && (
              <Notice tone="warn">
                The file is in HubSpot, but the note on the ticket couldn't be added. Your comment
                is saved here and in the activity log.
              </Notice>
            )}
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) save.mutate();
            }}
          >
            <div>
              <label className="mb-1 block text-[13px] font-medium" htmlFor={`file-${kind}`}>
                PDF file
              </label>
              <input
                ref={input}
                id={`file-${kind}`}
                type="file"
                accept="application/pdf,.pdf"
                disabled={save.isPending}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-[13px] file:mr-3 file:rounded-[6px] file:border file:border-border file:bg-card file:px-3 file:py-1.5 file:text-[13px]"
              />
              {notPdf && <p className="mt-1 text-[13px] text-status-critical">Only PDF files.</p>}
              {tooBig && <p className="mt-1 text-[13px] text-status-critical">Over {MAX_MB} MB.</p>}
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium" htmlFor={`comment-${kind}`}>
                Why is it being {replacing ? "replaced" : "uploaded"}?
              </label>
              <Textarea
                id={`comment-${kind}`}
                value={comment}
                maxLength={MAX_COMMENT}
                disabled={save.isPending}
                onChange={(e) => setComment(e.target.value)}
                placeholder="e.g. Client revised the scope; new version signed on 10 Nov"
                rows={3}
              />
              <p className="mt-1 text-[12px] text-ink-2">
                {commentOk
                  ? `${comment.trim().length}/${MAX_COMMENT}`
                  : `At least ${MIN_COMMENT} characters.`}
              </p>
            </div>
            {kind === "poa" && replacing && (
              <p className="text-[13px] text-ink-2">
                Marketing rows nobody has edited follow the new POA. Rows people edited are never
                changed or deleted; if the new POA no longer lists one, it is kept and flagged.
              </p>
            )}
            {save.isError && (
              <p role="alert" className="text-[13px] text-status-critical">
                {save.error.message}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={save.isPending} onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={!ready}>
                <Upload className="size-3.5" />
                {save.isPending
                  ? "Reading the file… up to a minute"
                  : replacing
                    ? "Replace"
                    : "Upload"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Who replaced the document, when, and why; rejected uploads and changes made in HubSpot are listed too. */
export function VersionHistory({ ticketId, kind }: { ticketId: string; kind: DocKind }) {
  const [open, setOpen] = useState(false);
  const versions = useQuery({ ...documentVersionsQueryOptions(ticketId, kind), enabled: open });

  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink"
      >
        <History className="size-3.5" /> {open ? "Hide history" : "History"}
      </button>
      {open && (
        <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
          {versions.isLoading && <p className="text-[13px] text-ink-2">Loading…</p>}
          {versions.isError && (
            <p role="alert" className="text-[13px] text-status-critical">
              Couldn't load the history.
            </p>
          )}
          {versions.data?.length === 0 && (
            <p className="text-[13px] text-ink-2">No changes recorded yet.</p>
          )}
          {versions.data?.map((v) => (
            <div key={v.id} className="text-[13px]">
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{v.file_name ?? "File"}</span>
                {v.status === "failed" ? (
                  <Chip tone="warning">Rejected</Chip>
                ) : v.source === "hubspot" ? (
                  <Chip tone="neutral">Changed in HubSpot</Chip>
                ) : null}
              </p>
              <p className="text-[12px] text-ink-2">
                {v.uploaded_by_name ?? "HubSpot"} · {formatDateTime(v.created_at)}
              </p>
              {v.comment && <p className="text-ink-2">“{v.comment}”</p>}
              {v.status === "failed" && v.error && (
                <p className="text-[12px] text-warn">{v.error}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
